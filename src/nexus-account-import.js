const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readClaudeAccountMetadata } = require("./claude-account-metadata");
const { ClaudeAccountSwitcher } = require("./claude-account-switcher");
const { grokCredential } = require("./grok-account-switcher");
const { normalizeEmail } = require("./provider-profile-store");

const ACCOUNT_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

function expandHome(raw, user) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value === "~") return user;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(user, value.slice(2));
  if (value.toLowerCase().startsWith("%userprofile%")) {
    return path.resolve(user, value.slice("%userprofile%".length).replace(/^[/\\]+/, ""));
  }
  return path.isAbsolute(value) ? path.resolve(value) : null;
}

function nexusDatabasePath(env = process.env, home = os.homedir()) {
  const base = env.APPDATA || path.join(home, ".config");
  return path.join(base, "nexo", "nexo.db");
}

function readDatabaseAccounts(dbPath, user) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return [];
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db
      .prepare("SELECT kind, home FROM accounts WHERE enabled != 0")
      .all()
      .map((row) => ({
        kind: String(row.kind || ""),
        home: expandHome(row.home, user),
      }))
      .filter((row) => row.home);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // O banco do Nexus pode estar aberto. A varredura das pastas segue sem ele.
    }
  }
}

function namedHomes(user, prefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(user, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      if (name === prefix) return true;
      if (!name.startsWith(`${prefix}-`)) return false;
      return ACCOUNT_SLUG.test(name.slice(prefix.length + 1));
    })
    .map((name) => path.resolve(user, name));
}

function discoverAccountHomes(user = os.homedir(), dbPath = nexusDatabasePath()) {
  const homes = {
    codex: new Set(namedHomes(user, ".codex")),
    claude: new Set(namedHomes(user, ".claude")),
    grok: new Set(namedHomes(user, ".grok")),
  };
  for (const account of readDatabaseAccounts(dbPath, user)) {
    if (homes[account.kind]) homes[account.kind].add(account.home);
  }
  return {
    codex: [...homes.codex],
    claude: [...homes.claude],
    grok: [...homes.grok],
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function importCodexHomes(switcher, homes) {
  let added = 0;
  for (const home of homes) {
    if (switcher.importAuthFile(path.join(home, "auth.json"))) added += 1;
  }
  return added;
}

function importClaudeHomes(switcher, homes, user) {
  let added = 0;
  for (const home of homes) {
    const secret = readJson(path.join(home, ".credentials.json"));
    if (!ClaudeAccountSwitcher.hasClaudeToken(secret)) continue;
    const metaHome = path.basename(home).toLowerCase() === ".claude" ? user : home;
    const meta = readClaudeAccountMetadata(metaHome);
    const email = normalizeEmail(meta.email);
    const known = switcher.store.list();
    if (switcher.store.findKeyBySecret(secret)) continue;
    if (email && known.some((profile) => normalizeEmail(profile.email) === email)) continue;
    try {
      switcher.store.save({ secret, email: meta.email, plan: meta.plan, active: false });
      added += 1;
    } catch {
      // Uma pasta sem login utilizável não impede as outras.
    }
  }
  return added;
}

function importGrokHomes(switcher, homes) {
  let added = 0;
  for (const home of homes) {
    const secret = readJson(path.join(home, "auth.json"));
    const credential = grokCredential(secret);
    if (!credential?.refresh_token) continue;
    const email = normalizeEmail(credential.email);
    const known = switcher.store.list();
    if (switcher.store.findKeyBySecret(secret)) continue;
    if (email && known.some((profile) => normalizeEmail(profile.email) === email)) continue;
    try {
      switcher.store.save({
        secret,
        email: credential.email,
        plan: credential.auth_mode || null,
        active: false,
      });
      added += 1;
    } catch {
      // Uma pasta sem login utilizável não impede as outras.
    }
  }
  return added;
}

function importNexusAccounts({
  user = os.homedir(),
  dbPath = nexusDatabasePath(process.env, user),
  codex,
  claude,
  grok,
} = {}) {
  const homes = discoverAccountHomes(user, dbPath);
  return {
    codex: codex ? importCodexHomes(codex, homes.codex) : 0,
    claude: claude ? importClaudeHomes(claude, homes.claude, user) : 0,
    grok: grok ? importGrokHomes(grok, homes.grok) : 0,
  };
}

module.exports = {
  discoverAccountHomes,
  expandHome,
  importNexusAccounts,
  nexusDatabasePath,
  readDatabaseAccounts,
};
