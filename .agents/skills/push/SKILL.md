---
name: push
description: Publica o CodePet neste PC (bump patch, testes, commit de release, executável portátil e substituição da instalação local). Use when the user explicitly invokes /push or this skill inside the CodePet repository.
---

# Push do CodePet

## Regra central

Quando o usuário digitar `/push` neste repositório ou invocar explicitamente esta skill, isso conta como confirmação explícita para executar preflight, bump patch, testes, commit de release, build do executável portátil, substituição do CodePet instalado neste PC e push para `origin/main`.

O CodePet daqui é o fork `https://github.com/ronydrop/CodePet.git` (`origin`) de `nokryong/CodePet` (`upstream`), com a interface em português brasileiro. Publicar significa gravar o commit de release, instalar a versão nova neste PC e enviar para `origin/main` do fork. Nunca envie nada para `upstream` nem abra PR no repositório original.

O CodePet é distribuído como executável portátil, sem instalador: a instalação é o arquivo `%LOCALAPPDATA%\Programs\CodePet\CodePet.exe`. O script guarda o executável anterior em `C:\Users\ronyo\Documents\Codex\codepet\<AAAA-MM-DD>_push-v<versão>-<commit>`, encerra somente os processos do CodePet (o executável instalado e a cópia extraída em `%TEMP%\<id>\CodePet.exe`), substitui o arquivo, reabre pelo WMI e confere hash e versão. Nunca encerra Codex, Claude, Grok, Antigravity nem processos de outras tarefas.

Contas, credenciais, conversas, permissões e configurações ficam em `%APPDATA%\code-pet` e não são tocadas. `codexProxyMode` precisa continuar `false`; o script falha se encontrar outro valor depois da reabertura. Não altere o `config.toml` do Codex.

Fora de `/push` ou da invocação explícita desta skill, continue seguindo as regras globais: não rode build publicável, commit, push, PR, branch, checkout ou troca de branch sem confirmação explícita.

## Ambiente

A publicação roda no Windows, com PowerShell 7 (`pwsh`), a partir da raiz `C:\Users\ronyo\projects\codepet`. O script não roda no `powershell.exe` 5.1. Git, npm e node usados são os do Windows; nada roda no WSL. As dependências precisam estar instaladas (`npm ci`).

O script fica dentro desta skill em `.agents/skills/push/scripts/codepet_push.ps1`. Não duplique nem reescreva o script para outro shell. Use barras normais no `-File`.

- Windows (Git Bash ou PowerShell): cwd `C:\Users\ronyo\projects\codepet` e `pwsh`.
- WSL: cwd `/mnt/c/Users/ronyo/projects/codepet` e `pwsh.exe`.

## Execução

1. Confirme que o cwd é a raiz do CodePet.
2. Rode o script único da skill:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/push/scripts/codepet_push.ps1
```

O fluxo completo leva alguns minutos (testes, depois o build do Electron e a verificação do pacote). Rode em segundo plano e acompanhe a saída; não interrompa por tempo limite curto.

3. Não crie branch, não troque branch e não crie tag.
4. Se o script falhar, siga o protocolo de recuperação abaixo. Só pare imediatamente quando a falha estiver na lista de bloqueios protegidos ou quando o limite de tentativas for atingido.

## Recuperação de falhas

Ao encontrar um erro durante `/push`:

1. Capture a saída completa, o comando e a etapa que falharam.
2. Verifique `git status --short --branch`, `git rev-parse HEAD`, `git log -1 --format=%s` e a versão de `package.json` para determinar o que já aconteceu.
3. Diagnostique a causa raiz reproduzindo a falha com o menor comando aplicável (por exemplo, `node --test test/<arquivo>.test.js`).
4. Aplique somente a correção mínima, segura e reversível necessária para remover a causa.
5. Rode primeiro a validação focada que falhou.
6. Retome pela etapa correta conforme as regras abaixo.
7. No máximo 2 novas tentativas para a mesma causa. Se ela persistir, pare e reporte causa, evidências, correções tentadas e o estado local.

Antes do commit de release, o agente pode corrigir código, testes, textos e configuração versionada. Depois da validação focada, execute novamente o script completo. O script reconhece e reutiliza o bump patch preparado no worktree.

Não execute novamente o fluxo completo depois que o commit de release existir. Use o SHA completo do commit e uma das retomadas abaixo:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/push/scripts/codepet_push.ps1 -ResumeFrom Build -ReleaseCommit <sha>
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/push/scripts/codepet_push.ps1 -ResumeFrom Install -ReleaseCommit <sha>
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/push/scripts/codepet_push.ps1 -ResumeFrom Push -ReleaseCommit <sha>
```

- `Build` gera o executável do commit de release e continua pela instalação e pelo push.
- `Install` exige o executável da versão e continua pela instalação e pelo push.
- `Push` só envia o commit para `origin/main`.

O script imprime o comando de retomada exato quando uma etapa posterior ao commit falha. Se a causa estiver em código ou configuração versionada, corrija e inicie uma nova release patch, porque o commit anterior já é a release. Nunca use amend, reset ou force-push no commit de release.

Pare sem autocorreção em caso de remoto ausente ou diferente de `$ExpectedOrigin` definido no script, arquivo perigoso, branch diferente de `main`, histórico atrás ou divergente, conflito Git, correção destrutiva ou ação que exija nova autorização, como encerrar processos que não sejam do CodePet.

## Atualizações do upstream

Trazer versões novas do `nokryong/CodePet` não faz parte do `/push`. Quando o usuário pedir, faça `git fetch upstream`, integre a tag desejada em `main`, resolva os conflitos preservando a tradução e traduza os textos novos antes de publicar. Como o fork também incrementa o patch, a versão do fork pode coincidir com uma versão do upstream; nesse caso o aviso de atualização do aplicativo não aparece para aquela versão.

## Dry-run técnico

Para testar preflight e cálculo de versão sem alterar arquivos:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/push/scripts/codepet_push.ps1 -PlanOnly
```

`-PlanOnly` não faz bump, testes, build, commit, instalação nem push.

Para validar apenas as funções internas do script:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/push/scripts/codepet_push.ps1 -SelfTest
```

`-SelfTest` não toca no repositório nem no CodePet instalado.

## O que o script garante

- O cwd precisa ser a raiz `C:\Users\ronyo\projects\codepet`, com `package.json` do CodePet (`code-pet`, `productName` `CodePet`, `appId` `app.codepet.desktop`) e dependências instaladas.
- A branch atual precisa ser `main` e o remoto `origin` precisa ser `https://github.com/ronydrop/CodePet.git`, conforme `$ExpectedOrigin` no script. A branch `main` precisa estar em dia com `origin/main` e o push usa somente `git push origin main`.
- Arquivos perigosos (`artifacts`, `dist`, `release`, `node_modules`, `.cache`, `.code-pet`, `.env*`, `*.local`, `*.log`, executáveis e pacotes, bancos SQLite, chaves e certificados) bloqueiam a publicação antes de qualquer bump.
- A versão nova é sempre patch automático; o bump usa `npm version` e atualiza `package.json` e `package-lock.json`.
- A validação é `npm test` (`node --test`, a mesma do CI), esperando outras compilações deste PC.
- A árvore candidata é calculada antes dos testes e conferida depois deles e no stage; arquivos regenerados durante os testes bloqueiam o commit.
- Cada etapa registra a duração no log (`t+` no cabeçalho, `<==` na conclusão e resumo final).
- O commit usa `chore: publica CodePet vX.Y.Z` e vem antes do build, para que o executável corresponda ao commit de release.
- O build roda `npm run dist -- --win`, que inclui a verificação do pacote (`scripts/smoke-package.js`), e precisa gerar `artifacts/CodePet-X.Y.Z.exe` com essa versão nos metadados; o log mostra tamanho e SHA-256, e o build não pode alterar arquivos versionados.
- A instalação guarda o executável anterior, encerra só o CodePet, copia o artefato, confere SHA-256 e versão, reabre o aplicativo fora do job do agente e confirma que ele continua aberto e com `codexProxyMode` desligado.
- Retomadas posteriores ao commit validam SHA, mensagem de release, versão, worktree limpo e artefato antes de continuar, sem novo bump ou commit.
