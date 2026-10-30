#Requires -Version 7
[CmdletBinding()]
param(
    [switch]$PlanOnly,
    [switch]$SelfTest,
    [ValidateSet('Build', 'Install', 'Push')]
    [string]$ResumeFrom,
    [string]$ReleaseCommit
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Agentes leem a saída por pipe; sem isso, o pwsh grava os acentos na página de código do console.
if ([Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}

$script:PushStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:StageTimings = New-Object System.Collections.Generic.List[object]
$script:CurrentStage = $null
$script:CurrentStageStartedAt = [timespan]::Zero

$ExpectedRepoPath = 'C:\Users\ronyo\projects\codepet'
$ExpectedPackageName = 'code-pet'
$ExpectedProductName = 'CodePet'
$ExpectedAppId = 'app.codepet.desktop'
$ExpectedBranch = 'main'
$ExpectedOrigin = 'https://github.com/ronydrop/CodePet.git'
$InstalledExe = Join-Path $env:LOCALAPPDATA 'Programs\CodePet\CodePet.exe'
$SettingsPath = Join-Path $env:APPDATA 'code-pet\settings.json'
$BackupRoot = 'C:\Users\ronyo\Documents\Codex\codepet'

function Complete-CurrentStage {
    if ($null -ne $script:CurrentStage) {
        $elapsed = $script:PushStopwatch.Elapsed - $script:CurrentStageStartedAt
        $script:StageTimings.Add([pscustomobject]@{
            Stage = $script:CurrentStage
            Duration = $elapsed
        })
        Write-Host ("<== {0} concluída em {1:mm\:ss\.f}" -f $script:CurrentStage, $elapsed) -ForegroundColor DarkCyan
        $script:CurrentStage = $null
    }
}

function Write-Step {
    param([string]$Message)

    Complete-CurrentStage
    $script:CurrentStage = $Message
    $script:CurrentStageStartedAt = $script:PushStopwatch.Elapsed

    Write-Host ""
    Write-Host ("==> {0} [t+{1:hh\:mm\:ss}]" -f $Message, $script:PushStopwatch.Elapsed) -ForegroundColor Cyan
}

function Write-StageTimingSummary {
    Complete-CurrentStage
    if ($script:StageTimings.Count -eq 0) {
        return
    }

    Write-Host ""
    Write-Host "Duração por etapa:" -ForegroundColor Cyan
    foreach ($timing in $script:StageTimings) {
        Write-Host ("  {0,-44} {1:hh\:mm\:ss\.f}" -f $timing.Stage, $timing.Duration)
    }
    Write-Host ("  {0,-44} {1:hh\:mm\:ss\.f}" -f 'TOTAL', $script:PushStopwatch.Elapsed) -ForegroundColor Cyan
}

function Fail {
    param([string]$Message)

    throw "[codepet-push] $Message"
}

function Run {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    Write-Host ">> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "Comando falhou com exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Capture {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [switch]$AllowNonZero
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    $text = $text.Trim()

    if ((-not $AllowNonZero) -and $exitCode -ne 0) {
        Fail "Comando falhou com exit code $exitCode`: $FilePath $($Arguments -join ' ')`n$text"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Text = $text
    }
}

function Capture-Text {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    return (Capture $FilePath $Arguments).Text
}

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "Comando obrigatório não encontrado no PATH: $Name"
    }
}

# Neste PC, builds de outras tarefas não se sobrepõem: espera compilações Rust e empacotadores terminarem.
function Wait-ForBuilds {
    $deadline = (Get-Date).AddMinutes(20)
    while ($busy = Get-Process cargo, rustc, app-builder, makensis -ErrorAction SilentlyContinue) {
        if ((Get-Date) -gt $deadline) {
            Fail 'Outra compilação continua rodando há 20 minutos.'
        }
        Write-Host "Aguardando outra compilação terminar ($(@($busy).Count) processo(s))..."
        Start-Sleep -Seconds 15
    }
}

function Normalize-RepoPath {
    param([string]$Path)

    return ($Path -replace '\\', '/').Trim('"')
}

function Get-NextPatchVersion {
    param([string]$CurrentVersion)

    $current = Convert-SemVer $CurrentVersion
    return "$($current.Major).$($current.Minor).$($current.Patch + 1)"
}

function Convert-SemVer {
    param([string]$Version)

    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
        Fail "Versão precisa ser SemVer simples X.Y.Z. Recebido: $Version"
    }

    return [pscustomobject]@{
        Major = [int]$Matches[1]
        Minor = [int]$Matches[2]
        Patch = [int]$Matches[3]
    }
}

function Test-PreparedPatchVersion {
    param(
        [string]$BaseVersion,
        [string]$CurrentVersion
    )

    $base = Convert-SemVer $BaseVersion
    $current = Convert-SemVer $CurrentVersion

    return $current.Major -eq $base.Major -and
        $current.Minor -eq $base.Minor -and
        $current.Patch -gt $base.Patch
}

function Get-GitSyncStatus {
    param(
        [int]$Ahead,
        [int]$Behind
    )

    if ($Behind -eq 0) {
        return 'ok'
    }

    if ($Ahead -eq 0) {
        return 'behind'
    }

    return 'diverged'
}

function Get-RemoteMode {
    param(
        [string[]]$Remotes,
        [string]$Expected,
        [string]$OriginUrl
    )

    if ($Remotes -notcontains 'origin') {
        return [pscustomobject]@{ Mode = ''; Error = "Remote origin ausente; esperado $Expected." }
    }

    if ($OriginUrl -ne $Expected) {
        return [pscustomobject]@{ Mode = ''; Error = "Remote origin inesperado: $OriginUrl (esperado $Expected)." }
    }

    return [pscustomobject]@{ Mode = 'origin'; Error = '' }
}

function Get-ResumeParameterError {
    param(
        [string]$ResumeStage,
        [string]$Commit,
        [bool]$IsPlanOnly,
        [bool]$IsSelfTest
    )

    $hasResumeStage = -not [string]::IsNullOrWhiteSpace($ResumeStage)
    $hasCommit = -not [string]::IsNullOrWhiteSpace($Commit)

    if ($hasResumeStage -and ($IsPlanOnly -or $IsSelfTest)) {
        return '-ResumeFrom não pode ser combinado com -PlanOnly ou -SelfTest.'
    }

    if ($hasResumeStage -and -not $hasCommit) {
        return '-ReleaseCommit é obrigatório quando -ResumeFrom for usado.'
    }

    if ((-not $hasResumeStage) -and $hasCommit) {
        return '-ReleaseCommit só pode ser usado junto com -ResumeFrom.'
    }

    return ''
}

function Assert-ResumeParameters {
    param(
        [string]$ResumeStage,
        [string]$Commit,
        [bool]$IsPlanOnly,
        [bool]$IsSelfTest
    )

    $parameterError = Get-ResumeParameterError `
        -ResumeStage $ResumeStage `
        -Commit $Commit `
        -IsPlanOnly $IsPlanOnly `
        -IsSelfTest $IsSelfTest
    if (-not [string]::IsNullOrWhiteSpace($parameterError)) {
        Fail $parameterError
    }
}

function Get-RemainingReleaseStages {
    param([string]$ResumeStage)

    switch ($ResumeStage) {
        'Build' { return @('Build', 'Install', 'Push') }
        'Install' { return @('Install', 'Push') }
        'Push' { return @('Push') }
        default { Fail "Etapa de retomada inválida: $ResumeStage" }
    }
}

function Get-ChangedPaths {
    # Lista cada arquivo novo, para que um arquivo perigoso dentro de uma pasta nova não passe despercebido.
    $lines = & git -c core.quotePath=false status --porcelain=v1 --untracked-files=all
    if ($LASTEXITCODE -ne 0) {
        Fail 'Não foi possível ler o git status'
    }

    $paths = @()
    foreach ($line in $lines) {
        if ($line.Length -lt 4) {
            continue
        }

        $path = $line.Substring(3)
        if ($path -match ' -> ') {
            $path = ($path -split ' -> ')[-1]
        }

        $paths += (Normalize-RepoPath $path)
    }

    return $paths
}

function Get-ReleaseCandidateTree {
    param([string]$RepositoryPath = '.')

    $resolvedRepository = (Resolve-Path -LiteralPath $RepositoryPath).Path
    $temporaryIndex = Join-Path ([System.IO.Path]::GetTempPath()) "codepet-release-index-$PID-$([guid]::NewGuid().ToString('N'))"
    $previousIndex = $env:GIT_INDEX_FILE
    try {
        $env:GIT_INDEX_FILE = $temporaryIndex
        [void](Capture 'git' @('-C', $resolvedRepository, 'read-tree', 'HEAD'))
        [void](Capture 'git' @('-C', $resolvedRepository, 'add', '-A', '--', '.'))
        return Capture-Text 'git' @('-C', $resolvedRepository, 'write-tree')
    }
    finally {
        if ([string]::IsNullOrEmpty($previousIndex)) {
            Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
        }
        else {
            $env:GIT_INDEX_FILE = $previousIndex
        }
        Remove-Item -LiteralPath $temporaryIndex -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReleaseCandidateTreeMatch {
    param(
        [string]$ExpectedTree,
        [string]$ActualTree
    )

    return (
        $ExpectedTree -match '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' -and
        $ActualTree -match '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' -and
        $ExpectedTree -eq $ActualTree
    )
}

function Assert-ReleaseCandidateTree {
    param(
        [string]$ExpectedTree,
        [string]$ActualTree
    )

    if (-not (Test-ReleaseCandidateTreeMatch -ExpectedTree $ExpectedTree -ActualTree $ActualTree)) {
        Fail "A árvore candidata mudou durante a verificação. esperado=$ExpectedTree atual=$ActualTree. Confira se os testes regeneraram arquivos versionados e reinicie a publicação."
    }
}

function Get-BlockedPaths {
    param([string[]]$Paths)

    $dangerousPatterns = @(
        '^artifacts(/|$)',
        '^dist(/|$)',
        '^release(/|$)',
        '^node_modules(/|$)',
        '^\.cache(/|$)',
        '^\.code-?pet(/|$)',
        '^\.env$',
        '^\.env\.',
        '\.local$',
        '\.log$',
        '(^|/)[^/]+\.(exe|dmg|AppImage|nsis\.7z)$',
        '(^|/)\.secrets(/|$)',
        '(^|/)secrets(/|$)',
        '(^|/)[^/]+\.(db|sqlite|sqlite3|db-journal|sqlite-journal)$',
        '(^|/)[^/]+\.(pem|key|p12|pfx)$'
    )

    $blocked = New-Object System.Collections.Generic.List[string]
    foreach ($path in $Paths) {
        foreach ($pattern in $dangerousPatterns) {
            if ($path -match $pattern) {
                $blocked.Add($path)
                break
            }
        }
    }

    return @($blocked | Sort-Object -Unique)
}

function Assert-NoDangerousChangedPaths {
    param([string[]]$Paths)

    $blocked = @(Get-BlockedPaths $Paths)
    if ($blocked.Count -gt 0) {
        Fail "Arquivos perigosos no worktree ou no stage. Remova ou confirme manualmente fora do /push:`n$($blocked -join "`n")"
    }
}

function Assert-CodePetRepo {
    $repoRoot = Capture-Text 'git' @('rev-parse', '--show-toplevel')
    $cwd = (Resolve-Path -LiteralPath '.').Path
    $resolvedRoot = (Resolve-Path -LiteralPath $repoRoot).Path
    $expectedRoot = (Resolve-Path -LiteralPath $ExpectedRepoPath).Path

    if ($cwd -ne $resolvedRoot) {
        Fail "Execute /push na raiz do repo. cwd=$cwd repo=$resolvedRoot"
    }

    if ($resolvedRoot -ne $expectedRoot) {
        Fail "Repo inesperado. esperado=$expectedRoot atual=$resolvedRoot"
    }

    $package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
    if ($package.name -ne $ExpectedPackageName -or $package.build.productName -ne $ExpectedProductName -or $package.build.appId -ne $ExpectedAppId) {
        Fail "package.json não parece ser do CodePet. name=$($package.name) productName=$($package.build.productName) appId=$($package.build.appId)"
    }
}

# O main precisa estar em dia com origin/main do fork.
function Assert-GitPreflight {
    $branch = Capture-Text 'git' @('rev-parse', '--abbrev-ref', 'HEAD')
    if ($branch -ne $ExpectedBranch) {
        Fail "Branch atual precisa ser $ExpectedBranch. Atual: $branch"
    }

    $remotes = @((Capture-Text 'git' @('remote')) -split '\s+')
    $originUrl = ''
    if ($remotes -contains 'origin') {
        $originUrl = Capture-Text 'git' @('remote', 'get-url', 'origin')
    }
    $remote = Get-RemoteMode -Remotes $remotes -Expected $ExpectedOrigin -OriginUrl $originUrl
    if ($remote.Error) {
        Fail $remote.Error
    }

    [void](Capture 'git' @('fetch', 'origin', "+refs/heads/$($ExpectedBranch):refs/remotes/origin/$($ExpectedBranch)"))
    $aheadBehind = Capture-Text 'git' @('rev-list', '--left-right', '--count', "HEAD...refs/remotes/origin/$ExpectedBranch")
    $parts = @($aheadBehind -split '\s+')
    if ($parts.Count -ne 2) {
        Fail "Não foi possível comparar $ExpectedBranch com origin/$ExpectedBranch. Saída: $aheadBehind"
    }

    $syncStatus = Get-GitSyncStatus -Ahead ([int]$parts[0]) -Behind ([int]$parts[1])
    if ($syncStatus -eq 'behind') {
        Fail "origin/$ExpectedBranch está $($parts[1]) commit(s) à frente. Atualize com git pull --rebase origin $ExpectedBranch antes do /push."
    }
    if ($syncStatus -eq 'diverged') {
        Fail "$ExpectedBranch divergiu de origin/$ExpectedBranch (local +$($parts[0]), remoto +$($parts[1])). Resolva manualmente antes do /push."
    }
}

function Assert-ReleasePreflight {
    foreach ($command in @('git', 'node', 'npm')) {
        Assert-Command $command
    }
    if (-not (Test-Path -LiteralPath 'node_modules\electron-builder')) {
        Fail 'Dependências ausentes. Rode npm ci antes do /push.'
    }
}

function Get-CurrentVersion {
    return [string](Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
}

function Get-CommitVersion {
    param([string]$Commit)

    return [string]((Capture-Text 'git' @('show', "$Commit`:package.json")) | ConvertFrom-Json).version
}

function Set-ReleaseVersion {
    param([string]$Version)

    $npmResult = Capture-Text 'npm' @('version', $Version, '--no-git-tag-version')
    if ($npmResult -ne "v$Version") {
        Fail "npm version retornou $npmResult, esperado v$Version"
    }
}

# Um package-lock atrasado faria o npm ci seguinte reescrever a versão.
function Assert-ReleaseVersionFiles {
    param([string]$Version)

    $current = Get-CurrentVersion
    if ($current -ne $Version) {
        Fail "Versão do worktree é $current, esperado $Version"
    }

    $lock = Get-Content -LiteralPath 'package-lock.json' -Raw | ConvertFrom-Json -AsHashtable
    if ($lock['version'] -ne $Version -or $lock['packages']['']['version'] -ne $Version) {
        Fail "package-lock.json não está em $Version"
    }
}

function Assert-ReleaseCommitForResume {
    param([string]$ReleaseCommit)

    if ($ReleaseCommit -notmatch '^[0-9a-fA-F]{40}$') {
        Fail "ReleaseCommit precisa ser um SHA completo de 40 caracteres. Recebido: $ReleaseCommit"
    }

    $resolvedCommit = Capture-Text 'git' @('rev-parse', '--verify', "$ReleaseCommit^{commit}")
    $headCommit = Capture-Text 'git' @('rev-parse', 'HEAD')
    if ($headCommit -ne $resolvedCommit) {
        Fail "Commit de retomada precisa ser o HEAD atual. esperado=$resolvedCommit atual=$headCommit"
    }

    $changedPaths = @(Get-ChangedPaths)
    Assert-NoDangerousChangedPaths $changedPaths
    if ($changedPaths.Count -gt 0) {
        Fail "Retomada posterior ao commit exige worktree e stage limpos. Alterações encontradas:`n$($changedPaths -join "`n")"
    }

    $version = Get-CommitVersion $resolvedCommit
    $null = Convert-SemVer $version
    $commitMessage = Capture-Text 'git' @('log', '-1', '--format=%s', $resolvedCommit)
    $expectedMessage = "chore: publica CodePet v$version"
    if ($commitMessage -ne $expectedMessage) {
        Fail "Commit de retomada não é uma release válida. esperado='$expectedMessage' atual='$commitMessage'"
    }

    return [pscustomobject]@{
        Commit = $resolvedCommit
        Version = $version
    }
}

function Get-FileSha256Hex {
    param([string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ReleaseArtifactPath {
    param([string]$Version)

    return Join-Path 'artifacts' "CodePet-$Version.exe"
}

function Assert-ReleaseArtifact {
    param([string]$Version)

    $artifactPath = Get-ReleaseArtifactPath $Version
    if (-not (Test-Path -LiteralPath $artifactPath)) {
        Fail "Executável esperado não encontrado: $artifactPath"
    }

    $item = Get-Item -LiteralPath $artifactPath
    if ($item.Length -le 0) {
        Fail "Executável gerado está vazio: $artifactPath"
    }
    if ($item.VersionInfo.ProductVersion -ne $Version) {
        Fail "Executável gerado declara a versão $($item.VersionInfo.ProductVersion), esperado $Version"
    }

    Write-Host "Artefato: $artifactPath"
    Write-Host "Tamanho: $($item.Length) bytes"
    Write-Host "SHA256: $(Get-FileSha256Hex -Path $artifactPath)"
}

# O executável portátil abre a cópia instalada e a extrai em %TEMP%\<id>\CodePet.exe.
function Test-CodePetProcessPath {
    param(
        [string]$Path,
        [string]$Installed,
        [string]$TempRoot
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }
    if ($Path -eq $Installed) {
        return $true
    }

    $relative = [System.IO.Path]::GetRelativePath($TempRoot, $Path)
    return $relative -match '^[^\\/.][^\\/]*[\\/]CodePet\.exe$'
}

function Get-CodePetProcesses {
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
    return @(Get-Process CodePet -ErrorAction SilentlyContinue | Where-Object {
        Test-CodePetProcessPath -Path $_.Path -Installed $InstalledExe -TempRoot $tempRoot
    })
}

# Via WMI, o CodePet fica fora do job do agente e continua aberto depois que o script termina.
function Start-InstalledCodePet {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "`"$InstalledExe`""
        CurrentDirectory = (Split-Path -Parent $InstalledExe)
    }
    if ($result.ReturnValue -ne 0) {
        Fail "Win32_Process.Create não abriu o CodePet (código $($result.ReturnValue))."
    }
}

function Assert-CodexProxyDisabled {
    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        return
    }

    $settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json -AsHashtable
    if ($settings.ContainsKey('codexProxyMode') -and $settings['codexProxyMode'] -ne $false) {
        Fail "codexProxyMode ficou $($settings['codexProxyMode']) em $SettingsPath; o esperado é false."
    }
}

# Guarda o executável anterior, encerra só o CodePet, substitui, reabre e confere versão e hash.
function Install-Release {
    param(
        [string]$Version,
        [string]$ReleaseCommit
    )

    $artifact = (Resolve-Path -LiteralPath (Get-ReleaseArtifactPath $Version)).Path
    $artifactHash = Get-FileSha256Hex -Path $artifact
    $shortCommit = Capture-Text 'git' @('rev-parse', '--short', $ReleaseCommit)

    if (Test-Path -LiteralPath $InstalledExe) {
        $previousVersion = (Get-Item -LiteralPath $InstalledExe).VersionInfo.ProductVersion
        $backupDir = Join-Path $BackupRoot ("{0:yyyy-MM-dd}_push-v{1}-{2}" -f (Get-Date), $Version, $shortCommit)
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        $backup = Join-Path $backupDir "CodePet-$previousVersion-anterior.exe"
        Copy-Item -LiteralPath $InstalledExe -Destination $backup -Force
        Write-Host "Backup do executável anterior ($previousVersion): $backup"
    }

    $running = @(Get-CodePetProcesses)
    if ($running.Count -gt 0) {
        Write-Host "Encerrando o CodePet ($($running.Count) processo(s))."
        $running | Stop-Process -Force
        $running | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
    }
    if (@(Get-CodePetProcesses).Count -gt 0) {
        Fail 'O CodePet continua aberto depois de encerrado; o executável não foi substituído.'
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $InstalledExe) -Force | Out-Null
    Copy-Item -LiteralPath $artifact -Destination $InstalledExe -Force
    if ((Get-FileSha256Hex -Path $InstalledExe) -ne $artifactHash) {
        Fail "O executável instalado não confere com o artefato: $InstalledExe"
    }
    $installedVersion = (Get-Item -LiteralPath $InstalledExe).VersionInfo.ProductVersion
    if ($installedVersion -ne $Version) {
        Fail "O executável instalado declara a versão $installedVersion, esperado $Version"
    }

    Start-InstalledCodePet
    $deadline = (Get-Date).AddSeconds(60)
    while (@(Get-CodePetProcesses | Where-Object { $_.Path -ne $InstalledExe }).Count -eq 0) {
        if ((Get-Date) -gt $deadline) {
            Fail 'O CodePet instalado não abriu em 60 s.'
        }
        Start-Sleep -Milliseconds 500
    }
    Start-Sleep -Seconds 5
    if (@(Get-CodePetProcesses).Count -eq 0) {
        Fail 'O CodePet abriu e fechou em seguida.'
    }
    Assert-CodexProxyDisabled

    Write-Host "Instalado e aberto: CodePet $installedVersion ($shortCommit), SHA256 $artifactHash."
}

function Get-ResumeCommand {
    param(
        [string]$ResumeStage,
        [string]$ReleaseCommit
    )

    return "pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/push/scripts/codepet_push.ps1 -ResumeFrom $ResumeStage -ReleaseCommit $ReleaseCommit"
}

function Invoke-RemainingReleaseStages {
    param(
        [string]$ResumeStage,
        [string]$ReleaseCommit,
        [string]$Version
    )

    foreach ($stage in @(Get-RemainingReleaseStages $ResumeStage)) {
        try {
            switch ($stage) {
                'Build' {
                    Write-Step 'Executável portátil'
                    Wait-ForBuilds
                    Run 'npm' @('run', 'dist', '--', '--win')
                    Assert-ReleaseArtifact $Version
                    $postBuildChanges = @(Get-ChangedPaths)
                    if ($postBuildChanges.Count -gt 0) {
                        Fail "O build alterou arquivos versionados depois do commit de release:`n$($postBuildChanges -join "`n")"
                    }
                }
                'Install' {
                    Write-Step 'Instalação neste PC'
                    Assert-ReleaseArtifact $Version
                    Install-Release -Version $Version -ReleaseCommit $ReleaseCommit
                }
                'Push' {
                    Write-Step 'Push do commit de release'
                    Run 'git' @('push', 'origin', $ExpectedBranch)
                    Run 'git' @('fetch', 'origin', "+refs/heads/$($ExpectedBranch):refs/remotes/origin/$($ExpectedBranch)")
                    $remoteCommit = Capture-Text 'git' @('rev-parse', "refs/remotes/origin/$ExpectedBranch")
                    if ($remoteCommit -ne $ReleaseCommit) {
                        Fail "origin/$ExpectedBranch não aponta para o commit de release. esperado=$ReleaseCommit atual=$remoteCommit"
                    }
                }
            }
        }
        catch {
            $resumeCommand = Get-ResumeCommand -ResumeStage $stage -ReleaseCommit $ReleaseCommit
            Write-Host "Falha na etapa $stage do CodePet v$Version ($ReleaseCommit)." -ForegroundColor Red
            Write-Host 'Depois de diagnosticar, corrigir e validar a causa, retome com:' -ForegroundColor Yellow
            Write-Host $resumeCommand -ForegroundColor Yellow
            throw
        }
    }

    Write-StageTimingSummary
    Write-Host ""
    Write-Host "CodePet v$Version publicado em origin/$ExpectedBranch e instalado neste PC." -ForegroundColor Green
}

function Invoke-SelfTest {
    $next = Get-NextPatchVersion '1.2.3'
    if ($next -ne '1.2.4') {
        Fail "SelfTest falhou: patch esperado 1.2.4, recebido $next"
    }

    if (-not (Test-PreparedPatchVersion -BaseVersion '0.1.0' -CurrentVersion '0.1.1') -or
        (Test-PreparedPatchVersion -BaseVersion '0.1.0' -CurrentVersion '0.1.0')) {
        Fail 'SelfTest falhou: detecção do bump já preparado'
    }

    $hashFixture = Join-Path ([System.IO.Path]::GetTempPath()) "codepet-push-hash-$PID.txt"
    try {
        [System.IO.File]::WriteAllBytes($hashFixture, [System.Text.Encoding]::UTF8.GetBytes('nexus-push'))
        if ((Get-FileSha256Hex -Path $hashFixture) -ne 'c2ec5a77d383b142bdd87eeca2d118697a4cf537309db047656eadd6b7537595') {
            Fail 'SelfTest falhou: SHA-256 do fixture inesperado'
        }
    }
    finally {
        Remove-Item -LiteralPath $hashFixture -Force -ErrorAction SilentlyContinue
    }

    $candidateRepo = Join-Path ([System.IO.Path]::GetTempPath()) "codepet-push-candidate-$PID-$([guid]::NewGuid().ToString('N'))"
    try {
        New-Item -ItemType Directory -Path $candidateRepo -Force | Out-Null
        & git -C $candidateRepo init --quiet
        if ($LASTEXITCODE -ne 0) { Fail 'SelfTest falhou: git init do candidato' }
        & git -C $candidateRepo config user.name 'CodePet SelfTest'
        & git -C $candidateRepo config user.email 'codepet-selftest@example.invalid'
        [System.IO.File]::WriteAllText((Join-Path $candidateRepo 'fixture.txt'), 'antes')
        & git -C $candidateRepo add -- fixture.txt
        & git -C $candidateRepo commit --quiet -m 'fixture inicial'
        if ($LASTEXITCODE -ne 0) { Fail 'SelfTest falhou: commit inicial do candidato' }

        [System.IO.File]::WriteAllText((Join-Path $candidateRepo 'fixture.txt'), 'candidato')
        $candidateTree = Get-ReleaseCandidateTree -RepositoryPath $candidateRepo
        if (-not (Test-ReleaseCandidateTreeMatch -ExpectedTree $candidateTree -ActualTree $candidateTree)) {
            Fail 'SelfTest falhou: árvore candidata idêntica foi rejeitada'
        }

        [System.IO.File]::WriteAllText((Join-Path $candidateRepo 'fixture.txt'), 'mudança concorrente')
        $mutatedTree = Get-ReleaseCandidateTree -RepositoryPath $candidateRepo
        if (Test-ReleaseCandidateTreeMatch -ExpectedTree $candidateTree -ActualTree $mutatedTree) {
            Fail 'SelfTest falhou: mudança concorrente não alterou a árvore candidata'
        }
    }
    finally {
        Remove-Item -LiteralPath $candidateRepo -Recurse -Force -ErrorAction SilentlyContinue
    }

    $syncCases = @(
        @(0, 0, 'ok'),
        @(2, 0, 'ok'),
        @(0, 1, 'behind'),
        @(1, 1, 'diverged')
    )
    foreach ($case in $syncCases) {
        if ((Get-GitSyncStatus -Ahead $case[0] -Behind $case[1]) -ne $case[2]) {
            Fail "SelfTest falhou: sincronia +$($case[0]) -$($case[1]) deveria ser $($case[2])"
        }
    }

    $origin = 'https://github.com/ronydrop/CodePet.git'
    if (-not (Get-RemoteMode -Remotes @('') -Expected $origin -OriginUrl '').Error) {
        Fail 'SelfTest falhou: sem origin deveria bloquear'
    }
    if (-not (Get-RemoteMode -Remotes @('origin') -Expected $origin -OriginUrl 'https://github.com/nokryong/CodePet.git').Error) {
        Fail 'SelfTest falhou: origin do upstream deveria bloquear'
    }
    if ((Get-RemoteMode -Remotes @('origin', 'upstream') -Expected $origin -OriginUrl $origin).Mode -ne 'origin') {
        Fail 'SelfTest falhou: origin esperado deveria publicar no fork'
    }

    $expectedResumeStages = @{
        Build = 'Build|Install|Push'
        Install = 'Install|Push'
        Push = 'Push'
    }
    foreach ($resumeStage in $expectedResumeStages.Keys) {
        $actualStages = (@(Get-RemainingReleaseStages $resumeStage) -join '|')
        if ($actualStages -ne $expectedResumeStages[$resumeStage]) {
            Fail "SelfTest falhou: etapas de retomada para $resumeStage. esperado=$($expectedResumeStages[$resumeStage]) atual=$actualStages"
        }
    }

    if ([string]::IsNullOrWhiteSpace((Get-ResumeParameterError -ResumeStage 'Build' -Commit '' -IsPlanOnly $false -IsSelfTest $false))) {
        Fail 'SelfTest falhou: retomada sem ReleaseCommit deveria ser inválida'
    }
    if ([string]::IsNullOrWhiteSpace((Get-ResumeParameterError -ResumeStage 'Build' -Commit ('a' * 40) -IsPlanOnly $true -IsSelfTest $false))) {
        Fail 'SelfTest falhou: ResumeFrom com PlanOnly deveria ser inválido'
    }
    if ([string]::IsNullOrWhiteSpace((Get-ResumeParameterError -ResumeStage '' -Commit ('a' * 40) -IsPlanOnly $false -IsSelfTest $false))) {
        Fail 'SelfTest falhou: ReleaseCommit sem ResumeFrom deveria ser inválido'
    }

    $installed = 'C:\Users\x\AppData\Local\Programs\CodePet\CodePet.exe'
    $tempRoot = 'C:\Users\x\AppData\Local\Temp'
    $processCases = @(
        @($installed, $true),
        @('C:\Users\x\AppData\Local\Temp\3LPRGiBEUBKZvzKO1D34u9v1gYB\CodePet.exe', $true),
        @('C:\Users\x\AppData\Local\Temp\a\b\CodePet.exe', $false),
        @('C:\Users\x\projects\codepet\node_modules\electron\dist\CodePet.exe', $false),
        @('C:\Outro\CodePet.exe', $false),
        @('', $false)
    )
    foreach ($case in $processCases) {
        if ((Test-CodePetProcessPath -Path $case[0] -Installed $installed -TempRoot $tempRoot) -ne $case[1]) {
            Fail "SelfTest falhou: identificação do processo $($case[0])"
        }
    }

    $blocked = Get-BlockedPaths @(
        'src/main.js',
        'artifacts/CodePet-1.2.3.exe',
        'node_modules/electron/index.js',
        '.cache/x',
        '.env',
        'config/app.local',
        'chat.sqlite',
        'test/chat-room.test.js'
    )
    $expectedBlocked = @(
        '.cache/x',
        '.env',
        'artifacts/CodePet-1.2.3.exe',
        'chat.sqlite',
        'config/app.local',
        'node_modules/electron/index.js'
    )
    $blockedText = ($blocked | Sort-Object) -join '|'
    $expectedText = ($expectedBlocked | Sort-Object) -join '|'
    if ($blockedText -ne $expectedText) {
        Fail "SelfTest falhou: paths bloqueados inesperados. esperado=$expectedText recebido=$blockedText"
    }

    Write-Host 'SelfTest OK.'
}

Assert-ResumeParameters `
    -ResumeStage $ResumeFrom `
    -Commit $ReleaseCommit `
    -IsPlanOnly ([bool]$PlanOnly) `
    -IsSelfTest ([bool]$SelfTest)

if ($SelfTest) {
    Invoke-SelfTest
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($ResumeFrom)) {
    Write-Step 'Preflight de retomada'
    Assert-ReleasePreflight
    Assert-CodePetRepo
    Assert-GitPreflight

    $release = Assert-ReleaseCommitForResume $ReleaseCommit
    Invoke-RemainingReleaseStages `
        -ResumeStage $ResumeFrom `
        -ReleaseCommit $release.Commit `
        -Version $release.Version
    exit 0
}

Write-Step 'Preflight'
Assert-ReleasePreflight
Assert-CodePetRepo
Assert-GitPreflight

$changedPaths = @(Get-ChangedPaths)
Assert-NoDangerousChangedPaths $changedPaths

$current = Get-CurrentVersion
$head = Get-CommitVersion 'HEAD'
$null = Convert-SemVer $head
$hasPreparedVersionBump = Test-PreparedPatchVersion -BaseVersion $head -CurrentVersion $current
if (-not $hasPreparedVersionBump -and $current -ne $head) {
    Fail "Versão do worktree fora do padrão: package.json=$current, HEAD=$head. Desfaça o bump parcial antes do /push."
}
$nextVersion = if ($hasPreparedVersionBump) { $current } else { Get-NextPatchVersion $head }

Write-Host "Versão no HEAD: $head"
if ($hasPreparedVersionBump) {
    Write-Host "Bump patch já aplicado no worktree: $head -> $current"
}
Write-Host "Próxima versão patch: $nextVersion"
if ($changedPaths.Count -gt 0) {
    Write-Host "Alterações que entram no commit de release ($($changedPaths.Count)):"
    $changedPaths | ForEach-Object { Write-Host "  $_" }
}

if ($PlanOnly) {
    Write-Host 'PlanOnly ativo: nenhum arquivo será alterado.'
    Write-StageTimingSummary
    exit 0
}

Write-Step 'Bump de versão'
if ($hasPreparedVersionBump) {
    Write-Host "Mantendo o bump preparado: worktree já está em v$nextVersion."
}
else {
    Set-ReleaseVersion $nextVersion
}
Assert-ReleaseVersionFiles $nextVersion

$releaseCandidateTree = Get-ReleaseCandidateTree
Write-Host "Árvore candidata: $releaseCandidateTree"

Write-Step 'Testes'
Wait-ForBuilds
Run 'npm' @('test')

Write-Step 'Revalidação do candidato'
$changedPaths = @(Get-ChangedPaths)
Assert-NoDangerousChangedPaths $changedPaths
$validatedCandidateTree = Get-ReleaseCandidateTree
Assert-ReleaseCandidateTree -ExpectedTree $releaseCandidateTree -ActualTree $validatedCandidateTree

Write-Step 'Commit da release'
Run 'git' @('add', '-A')
$stagedCandidateTree = Capture-Text 'git' @('write-tree')
if (-not (Test-ReleaseCandidateTreeMatch -ExpectedTree $releaseCandidateTree -ActualTree $stagedCandidateTree)) {
    Run 'git' @('restore', '--staged', '--', ':/')
    Assert-ReleaseCandidateTree -ExpectedTree $releaseCandidateTree -ActualTree $stagedCandidateTree
}
$stagedStatus = & git diff --cached --name-only
if ($LASTEXITCODE -ne 0) {
    Fail 'Não foi possível ler o diff staged'
}
if (-not $stagedStatus) {
    Fail 'Nenhuma mudança staged para commit'
}

Run 'git' @('commit', '-m', "chore: publica CodePet v$nextVersion")
$publishedCommit = Capture-Text 'git' @('rev-parse', 'HEAD')
$postCommitChanges = @(Get-ChangedPaths)
if ($postCommitChanges.Count -gt 0) {
    Fail "O worktree mudou depois que o candidato foi para o stage. O commit foi preservado, mas o build foi bloqueado:`n$($postCommitChanges -join "`n")"
}

Invoke-RemainingReleaseStages `
    -ResumeStage 'Build' `
    -ReleaseCommit $publishedCommit `
    -Version $nextVersion
