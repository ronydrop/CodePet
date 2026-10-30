const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_CHANGE_FILES = 32;
const MAX_CHANGE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;
const CHANGE_TTL_MS = 15 * 60_000;
const MAX_PENDING_CHANGE_SETS = 16;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PROTECTED_ROOTS = new Set([
  ".git",
  "node_modules",
  "artifacts",
  ".next",
  "dist",
  "coverage",
  "out",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeChangePath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 240
    || value.includes("\\")
    || path.win32.isAbsolute(value)
    || path.posix.isAbsolute(value)
  ) {
    throw new Error("O caminho do arquivo alterado é inválido.");
  }

  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("O caminho do arquivo alterado é inválido.");
  }
  if (PROTECTED_ROOTS.has(parts[0].toLocaleLowerCase("en"))) {
    throw new Error("Artefatos protegidos ou metadados do repositório não podem ser aplicados.");
  }
  for (const part of parts) {
    if (
      Buffer.byteLength(part, "utf8") > 255
      || /[\u0000-\u001f<>:"|?*]/u.test(part)
      || /[. ]$/u.test(part)
      || WINDOWS_DEVICE_NAME.test(part)
    ) {
      throw new Error("O nome do arquivo alterado não é seguro no Windows.");
    }
  }
  return parts.join("/");
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function lstatSafe(fsApi, target) {
  const stat = fsApi.lstatSync(target);
  if (
    stat.isSymbolicLink()
    || stat.isBlockDevice()
    || stat.isCharacterDevice()
    || stat.isFIFO()
    || stat.isSocket()
  ) {
    throw new Error("Links, junções, pontos de reanálise e arquivos especiais não podem ser aplicados.");
  }
  return stat;
}

function workspaceRoot(fsApi, workspace) {
  const root = fsApi.realpathSync(workspace);
  const stat = lstatSafe(fsApi, root);
  if (!stat.isDirectory()) throw new Error("O workspace não é uma pasta.");
  return root;
}

function safeTarget(fsApi, workspace, relativePath, { allowMissing = false } = {}) {
  const root = workspaceRoot(fsApi, workspace);
  const parts = normalizeChangePath(relativePath).split("/");
  let current = root;
  let missing = false;
  let finalStat = null;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (!isPathInside(root, current)) throw new Error("O caminho da alteração sai do workspace.");

    const exists = !missing && fsApi.existsSync(current);
    if (!exists) {
      missing = true;
      if (!allowMissing) return { root, target: current, exists: false, stat: null };
      continue;
    }

    finalStat = lstatSafe(fsApi, current);
    if (index < parts.length - 1 && !finalStat.isDirectory()) {
      throw new Error("O item acima do caminho alterado não é uma pasta.");
    }
    const real = fsApi.realpathSync(current);
    if (!isPathInside(root, real)) throw new Error("O caminho da alteração sai do workspace.");
  }

  return { root, target: current, exists: !missing, stat: missing ? null : finalStat };
}

function decodeContent(entry) {
  if (typeof entry.content !== "string" || !BASE64_PATTERN.test(entry.content)) {
    throw new Error("O conteúdo do arquivo alterado é inválido.");
  }
  if (entry.content.length > Math.ceil(MAX_CHANGE_BYTES / 3) * 4 + 4) {
    throw new Error("O conteúdo do arquivo alterado passou do limite de tamanho.");
  }
  const content = Buffer.from(entry.content, "base64");
  if (content.toString("base64") !== entry.content || !HASH_PATTERN.test(entry.sha256) || sha256(content) !== entry.sha256.toLowerCase()) {
    throw new Error("O hash do conteúdo alterado é inválido.");
  }
  return content;
}

function validateManifest(manifest) {
  if (
    !manifest
    || manifest.version !== 1
    || !Array.isArray(manifest.changes)
    || manifest.changes.length > MAX_CHANGE_FILES
  ) {
    throw new Error("O conjunto de alterações do workspace é inválido.");
  }

  let bytes = 0;
  const seen = new Set();
  const changes = manifest.changes.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Um item de alteração do workspace é inválido.");
    }
    const relativePath = normalizeChangePath(entry.path);
    const folded = relativePath.toLocaleLowerCase("en");
    if (seen.has(folded)) throw new Error("O mesmo arquivo aparece duas vezes nas alterações.");
    seen.add(folded);

    const op = entry.op === "delete" ? "delete" : entry.op === "write" ? "write" : null;
    if (
      !op
      || typeof entry.originalExists !== "boolean"
      || !HASH_PATTERN.test(String(entry.originalSha256 || ""))
      || (op === "delete" && !entry.originalExists)
    ) {
      throw new Error("Um item de alteração do workspace é inválido.");
    }
    const allowedKeys = op === "write"
      ? new Set(["path", "op", "originalExists", "originalSha256", "content", "sha256"])
      : new Set(["path", "op", "originalExists", "originalSha256"]);
    if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      throw new Error("Não é possível aplicar mudança de tipo de arquivo ou de permissão de execução.");
    }

    const content = op === "write" ? decodeContent(entry) : null;
    bytes += content?.length || 0;
    if (bytes > MAX_CHANGE_BYTES) throw new Error("O conjunto de alterações do workspace passou do limite de tamanho.");
    return {
      relativePath,
      op,
      originalExists: entry.originalExists,
      originalSha256: entry.originalSha256.toLowerCase(),
      content,
    };
  });

  const sorted = [...seen].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startsWith(`${sorted[index - 1]}/`)) {
      throw new Error("Não é possível alterar um arquivo e um caminho dentro dele ao mesmo tempo.");
    }
  }
  return changes;
}

function inspectOriginal(fsApi, workspace, change) {
  const target = safeTarget(fsApi, workspace, change.relativePath, { allowMissing: true });
  if (target.exists && !target.stat.isFile()) throw new Error("Só arquivos comuns podem ser alterados.");
  const content = target.exists ? fsApi.readFileSync(target.target) : Buffer.alloc(0);
  const exists = target.exists;
  if (exists !== change.originalExists || sha256(content) !== change.originalSha256) {
    throw new Error(`Conflito no workspace: ${change.relativePath}`);
  }
  return {
    ...target,
    mode: target.stat ? target.stat.mode & 0o777 : 0o600,
  };
}

function clampDiff(value) {
  const text = String(value || "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_DIFF_BYTES) return text;
  return `${bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n[o restante do diff foi omitido pelo limite de exibição]`;
}

function ensureParentDirectories(fsApi, root, relativePath, createdDirectories) {
  const parts = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!isPathInside(root, current)) throw new Error("O caminho da alteração sai do workspace.");
    if (!fsApi.existsSync(current)) {
      fsApi.mkdirSync(current, { mode: 0o700 });
      createdDirectories.push(current);
    }
    const stat = lstatSafe(fsApi, current);
    if (!stat.isDirectory()) throw new Error("O item acima do caminho alterado não é uma pasta.");
  }
}

class GrokWorkspaceChangeStore {
  constructor(options = {}) {
    this.fs = options.fsApi || fs;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.records = new Map();
  }

  stage({ sessionId, workspace, manifest, diff = manifest?.diff || "" }) {
    this.cleanup();
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 160) {
      throw new Error("Os dados da sessão desta aprovação são inválidos.");
    }
    if (this.records.size >= MAX_PENDING_CHANGE_SETS) {
      throw new Error("Há aprovações demais do Grok aguardando. Resolva os pedidos atuais antes.");
    }
    const root = workspaceRoot(this.fs, workspace);
    const changes = validateManifest(manifest);
    if (changes.length === 0) return null;
    for (const change of changes) inspectOriginal(this.fs, root, change);

    const id = this.randomUUID();
    const createdAt = this.now();
    this.records.set(id, {
      id,
      sessionId,
      workspace: root,
      changes,
      diff: clampDiff(diff),
      createdAt,
      expiresAt: createdAt + CHANGE_TTL_MS,
      used: false,
    });
    return this.public(id);
  }

  public(id) {
    const record = this.records.get(id);
    return record && {
      id: record.id,
      changes: record.changes.map((change) => ({ path: change.relativePath, op: change.op })),
      diff: record.diff,
      expiresAt: record.expiresAt,
    };
  }

  get(id, sessionId) {
    this.cleanup();
    const record = this.records.get(String(id || ""));
    if (!record || record.used || record.sessionId !== sessionId) {
      throw new Error("A aprovação da alteração expirou ou já foi tratada.");
    }
    return record;
  }

  cancel(id, sessionId) {
    this.cleanup();
    const record = this.records.get(String(id || ""));
    if (!record) return { canceled: true, alreadyHandled: true };
    if (record.sessionId !== sessionId) throw new Error("A aprovação da alteração expirou ou já foi tratada.");
    record.used = true;
    this.records.delete(record.id);
    return { canceled: true, alreadyHandled: false };
  }

  apply(id, sessionId) {
    const record = this.get(id, sessionId);
    record.used = true;
    this.records.delete(record.id);

    const plans = record.changes.map((change) => ({
      change,
      original: inspectOriginal(this.fs, record.workspace, change),
    }));
    const transaction = path.join(record.workspace, `.codepet-apply-${this.randomUUID()}`);
    const createdDirectories = [];
    const applied = [];
    this.fs.mkdirSync(transaction, { mode: 0o700 });

    try {
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        if (plan.change.op !== "write") continue;
        const candidate = path.join(transaction, `new-${index}`);
        this.fs.writeFileSync(candidate, plan.change.content, { mode: 0o600, flag: "wx" });
        plan.candidate = candidate;
      }
      for (const plan of plans) {
        ensureParentDirectories(this.fs, record.workspace, plan.change.relativePath, createdDirectories);
      }
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        const current = inspectOriginal(this.fs, record.workspace, plan.change);
        const backup = path.join(transaction, `old-${index}`);
        const appliedItem = {
          target: current.target,
          backup,
          hadOriginal: current.exists,
          wrote: false,
        };
        if (current.exists) this.fs.renameSync(current.target, backup);
        applied.push(appliedItem);
        if (plan.change.op === "write") {
          this.fs.renameSync(plan.candidate, current.target);
          appliedItem.wrote = true;
          try {
            this.fs.chmodSync(current.target, current.exists ? current.mode : 0o600);
          } catch {}
        }
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const item of [...applied].reverse()) {
        try {
          if (item.wrote && this.fs.existsSync(item.target)) this.fs.unlinkSync(item.target);
          if (item.hadOriginal && this.fs.existsSync(item.backup)) this.fs.renameSync(item.backup, item.target);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError?.message || String(rollbackError));
        }
      }
      for (const directory of [...createdDirectories].reverse()) {
        try {
          this.fs.rmdirSync(directory);
        } catch {}
      }
      if (rollbackErrors.length === 0) {
        try {
          this.fs.rmSync(transaction, { recursive: true, force: true });
        } catch {}
        throw error;
      }
      throw new Error(`${error?.message || error} Parte da reversão falhou. Arquivo de recuperação: ${transaction}`);
    }

    let cleanupWarning = "";
    try {
      this.fs.rmSync(transaction, { recursive: true, force: true });
    } catch (error) {
      cleanupWarning = `A aplicação terminou, mas a limpeza do backup falhou: ${transaction}`;
    }
    return { applied: plans.length, ...(cleanupWarning ? { cleanupWarning } : {}) };
  }

  discardSession(sessionId) {
    for (const [id, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(id);
    }
  }

  clear() {
    this.records.clear();
  }

  cleanup() {
    const cutoff = this.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt <= cutoff || record.used) this.records.delete(id);
    }
  }
}

module.exports = {
  GrokWorkspaceChangeStore,
  normalizeChangePath,
  safeTarget,
  validateManifest,
  MAX_CHANGE_FILES,
  MAX_CHANGE_BYTES,
  MAX_DIFF_BYTES,
  CHANGE_TTL_MS,
};
