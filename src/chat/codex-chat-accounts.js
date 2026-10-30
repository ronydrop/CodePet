const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { stripCodePetProxyLines } = require("../codex-proxy");
const { atomicWriteText } = require("../provider-profile-store");
const { probeCodexModelCatalog } = require("../providers/provider-capabilities");
const { normalizeCatalog, CATALOG_ERROR } = require("../providers/provider-model-catalog");
const { CodexWindowsSandboxState } = require("./codex-windows-sandbox");

const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const FILE_AUTH_ARGS = ["-c", "cli_auth_credentials_store=file"];
function readOptional(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Saved login directories are the CLI homes; auth.json is never copied into a
// chat or renderer. Refreshes remain in the same profile used by account switching.
class CodexChatAccounts {
  constructor({ switcher, probe = probeCodexModelCatalog, now = Date.now, platform = process.platform }) {
    this.switcher = switcher;
    this.probe = probe;
    this.now = now;
    this.windowsSandbox = new CodexWindowsSandboxState({ platform });
    this.cache = new Map();
    this.pending = new Map();
  }

  list() {
    return this.switcher.listProfiles().filter((profile) => profile.hasAuth).map((profile) => ({
      key: profile.key, label: profile.label || profile.email || profile.key,
      email: profile.email || null, plan: profile.planType || null,
    }));
  }

  prepare(key) {
    const profile = this.switcher.getProfile(key);
    if (!profile?.hasAuth) throw new Error("Não há conta do Codex salva. Entre em Configurações, na seção Contas.");
    const home = profile.homePath;
    const source = this.switcher.codexHome;
    if (!home || path.resolve(home) === path.resolve(source)) throw new Error("É preciso um caminho separado para a conta do Codex.");
    const manifestPath = path.join(home, ".codepet-chat-inheritance.json");
    let hashes = {};
    try { hashes = JSON.parse(readOptional(manifestPath) || "{}"); } catch {}
    for (const name of ["config.toml", "AGENTS.md", "AGENTS.override.md"]) {
      let next = readOptional(path.join(source, name));
      const target = path.join(home, name);
      const current = readOptional(target);
      // Preserve profile-specific edits. Only update files we still own.
      if (current !== null && hashes[name] !== digest(current)) continue;
      if (name === "config.toml" && next !== null) next = stripCodePetProxyLines(next);
      if (next === null) {
        if (current !== null) fs.unlinkSync(target);
        delete hashes[name];
      } else {
        if (next !== current) atomicWriteText(target, next);
        hashes[name] = digest(next);
      }
    }
    const config = readOptional(path.join(home, "config.toml")) || "";
    if (stripCodePetProxyLines(config) !== config) {
      throw new Error("O config.toml desta conta ainda contém o proxy global de contas do CodePet.");
    }
    // Keep shared instructions and skills available without duplicating their files.
    for (const name of ["skills", "rules"]) {
      const from = path.join(source, name);
      const to = path.join(home, name);
      if (!fs.existsSync(from)) continue;
      try { fs.lstatSync(to); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        fs.symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
      }
    }
    const manifest = JSON.stringify(hashes);
    if (readOptional(manifestPath) !== manifest) atomicWriteText(manifestPath, manifest);
    const env = { ...process.env, CODEX_HOME: home };
    // A shell-wide API key must not replace the explicitly selected login.
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    return { env, profile };
  }

  async prepareSandbox(key, record, cwd) {
    const profile = this.switcher.getProfile(key);
    if (!profile?.hasAuth) throw new Error("Não há conta do Codex salva.");
    await this.windowsSandbox.ensure(profile.homePath, this.switcher.codexHome, record, cwd);
  }

  async discover(key, base, { force = false } = {}) {
    if (this.pending.has(key)) return this.pending.get(key);
    const cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < 60_000 && cached.commandPath === base?.commandPath) return cached.record;
    const promise = (async () => {
      let catalog = [];
      let reason = "";
      try {
        if (!base?.commandPath || base.status !== "cli") throw new Error("Instale a CLI do Codex antes.");
        const { env } = this.prepare(key);
        catalog = normalizeCatalog(await this.probe(base.commandPath, base.needsShell, 8000, { env, argv: FILE_AUTH_ARGS }));
        if (!catalog.length) reason = CATALOG_ERROR;
      } catch (error) { reason = error.message || CATALOG_ERROR; }
      const record = {
        ...base, id: "codex", providerId: "codex", reason,
        modelOptions: catalog, models: catalog.map((entry) => entry.id), efforts: [],
        catalogStatus: catalog.length ? "ready" : "unavailable", catalogReason: reason,
      };
      this.cache.set(key, { at: this.now(), commandPath: base?.commandPath, record });
      return record;
    })();
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }

  record(key, base) {
    if (!this.list().some((profile) => profile.key === key)) {
      return { ...base, modelOptions: [], models: [], catalogStatus: "unavailable", reason: "A conta salva do Codex foi excluída. Adicione o participante de novo." };
    }
    return this.cache.get(key)?.record || {
      ...base, modelOptions: [], models: [], catalogStatus: "unavailable", reason: "Confira de novo a lista de modelos desta conta.",
    };
  }
}

module.exports = { CodexChatAccounts, FILE_AUTH_ARGS };
