#!/usr/bin/env node
// CodePet 실행 도우미.
//   code-pet          → Electron 앱 실행 (로컬에 electron이 설치된 경우)
//   code-pet --chat   → 채팅 창을 바로 열며 실행
//   code-pet doctor   → 프로바이더 CLI 상태 점검 (자격 증명은 출력하지 않습니다)
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_ROOT = path.join(__dirname, "..");

async function doctor() {
  const { diagnoseProviders } = require(path.join(
    APP_ROOT,
    "src",
    "providers",
    "provider-diagnostics"
  ));
  const records = await diagnoseProviders();

  console.log("CodePet doctor — estado das CLIs\n");
  for (const record of records) {
    const statusLabel = record.installed === true ? "Instalado" : record.installed === false ? "Não instalado" : "Falha na verificação";
    console.log(`  ${record.name} (@${record.provider})`);
    console.log(`    Estado: ${statusLabel}${record.version ? ` · ${record.version}` : ""}`);
    if (record.installed === true) {
      const loginLabel = record.loggedIn === true ? "Conectado" : record.loggedIn === false ? "Login necessário" : "Confirmação automática indisponível";
      console.log(`    Login: ${loginLabel}`);
    }
    if (record.message) console.log(`    Aviso: ${record.message}`);
  }
  console.log("\nSessões e configurações: ~/.code-pet (dá para mudar com CODE_PET_HOME)");
  const failed = records.some(
    (record) => record.installed !== true || record.loggedIn === false
  );
  process.exitCode = failed ? 1 : 0;
}

function launchApp(extraArgs) {
  let electronPath = null;
  try {
    // electron 패키지가 함께 설치된 경우에만 실행할 수 있습니다.
    electronPath = require("electron");
  } catch {
    console.error(
      [
        "O runtime do Electron não foi encontrado.",
        "Execute a versão de distribuição (portátil ou instalada) ou, no repositório,",
        "  npm install && npm start",
        "para executar. `code-pet doctor` funciona sem o Electron.",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  const child = spawn(electronPath, [APP_ROOT, ...extraArgs], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
}

const args = process.argv.slice(2);
if (args[0] === "doctor") {
  doctor().catch((error) => {
    console.error("Falha ao executar o doctor:", error?.message || error);
    process.exitCode = 1;
  });
} else {
  launchApp(args);
}
