const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CodexAccountSwitcher } = require("../src/codex-account-switcher");
const { ClaudeAccountSwitcher } = require("../src/claude-account-switcher");
const { GrokAccountSwitcher } = require("../src/grok-account-switcher");
const { importNexusAccounts } = require("../src/nexus-account-import");

function jwt(payload) {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function codexAuth(email, accountId) {
  return {
    tokens: {
      access_token: jwt({
        email,
        sub: `user-${email}`,
        "https://api.openai.com/auth": {
          chatgpt_account_id: accountId,
          chatgpt_plan_type: "pro",
        },
      }),
    },
  };
}

test("importa as pastas de conta do Nexus e não duplica na segunda vez", () => {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-nexus-"));
  const dbPath = path.join(user, "nexo.db");
  fs.mkdirSync(path.join(user, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(user, ".codex-admin"), { recursive: true });
  fs.mkdirSync(path.join(user, ".claude-contato"), { recursive: true });
  fs.mkdirSync(path.join(user, ".grok-extra"), { recursive: true });
  fs.writeFileSync(
    path.join(user, ".codex", "auth.json"),
    JSON.stringify(codexAuth("live@exemplo.com", "acct-live"))
  );
  fs.writeFileSync(
    path.join(user, ".codex-admin", "auth.json"),
    JSON.stringify(codexAuth("admin@exemplo.com", "acct-admin"))
  );
  fs.writeFileSync(
    path.join(user, ".claude-contato", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { refreshToken: "refresh-contato", accessToken: "access-contato" } })
  );
  fs.writeFileSync(
    path.join(user, ".claude-contato", ".claude.json"),
    JSON.stringify({ email: "contato@exemplo.com", subscriptionType: "team" })
  );
  fs.writeFileSync(
    path.join(user, ".grok-extra", "auth.json"),
    JSON.stringify({ login: { refresh_token: "refresh-grok", email: "grok@exemplo.com" } })
  );

  const outside = path.join(user, "codex-fora");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "auth.json"), JSON.stringify(codexAuth("fora@exemplo.com", "acct-fora")));
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE accounts(id TEXT, kind TEXT, label TEXT, home TEXT, enabled INTEGER, position INTEGER)");
  db.prepare("INSERT INTO accounts VALUES ('fora', 'codex', 'Fora', ?, 1, 0)").run(outside);
  db.close();

  const codex = new CodexAccountSwitcher({ homeDir: user });
  const claude = new ClaudeAccountSwitcher({ home: user });
  const grok = new GrokAccountSwitcher({ home: user });
  const first = importNexusAccounts({ user, dbPath, codex, claude, grok });
  const second = importNexusAccounts({ user, dbPath, codex, claude, grok });

  assert.deepEqual(first, { codex: 3, claude: 1, grok: 1 });
  assert.deepEqual(second, { codex: 0, claude: 0, grok: 0 });
  assert.equal(codex.listProfiles().length, 3);
  assert.equal(claude.listProfiles().some((profile) => profile.email === "contato@exemplo.com"), true);
  assert.equal(grok.listProfiles().some((profile) => profile.email === "grok@exemplo.com"), true);
  fs.rmSync(user, { recursive: true, force: true });
});
