const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("변경 승인 IPC는 세션과 승인 ID를 함께 main 프로세스에 전달한다", () => {
  const preload = source("src/chat-preload.js");
  const ipc = source("src/chat/chat-ipc.js");
  assert.match(preload, /workspaceChangesApply: \(sessionId, approvalId\)/);
  assert.match(preload, /WORKSPACE_CHANGES_APPLY, \{ sessionId, approvalId \}/);
  assert.match(preload, /workspaceChangesCancel: \(sessionId, approvalId\)/);
  assert.match(ipc, /chat:workspace-changes:apply/);
  assert.match(ipc, /requireSession\(sessionId\)/);
  assert.match(ipc, /applyWorkspaceChanges\(String\(approvalId \|\| ""\), sessionId\)/);
  assert.match(ipc, /cancelWorkspaceChanges\(String\(approvalId \|\| ""\), sessionId\)/);
});

test("채팅 말풍선은 변경 파일과 diff를 표시하고 Aplicar tudo·취소를 제공한다", () => {
  const chat = source("src/chat.js");
  const css = source("src/chat.css");
  const room = source("src/chat/chat-room.js");
  assert.match(chat, /Alteração na cópia isolada do Docker · precisa de aprovação/);
  assert.match(chat, /apply\.textContent = "Aplicar tudo"/);
  assert.match(chat, /cancel\.textContent = "Cancelar"/);
  assert.match(chat, /workspaceChangesApply\(sessionId, changeSet\.id\)/);
  assert.match(chat, /workspaceChangesCancel\(sessionId, changeSet\.id\)/);
  assert.match(chat, /Alterações do Grok sempre precisam da revisão do diff da cópia antes de serem aplicadas/);
  assert.match(css, /\.workspace-change-review pre \{[^}]*overflow: auto/);
  assert.match(room, /result\.workspaceChangeSet \? \{ workspaceChangeSet: result\.workspaceChangeSet \}/);
});
