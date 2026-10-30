const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const owned = new Set();
process.once("exit", () => { for (const release of owned) release(); });

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function acquire(file, depth = 0) {
  if (depth > 8) throw new Error("O bloqueio do armazenamento precisa ser recuperado.");
  const hostname = os.hostname();
  const token = JSON.stringify({ hostname, pid: process.pid, token: randomUUID() });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, token, { flag: "wx", mode: 0o600 });
  try {
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== "EEXIST") {
        if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"].includes(error.code)) {
          throw new Error("Não foi possível criar o bloqueio do writer. Use uma pasta local que aceite hard links.", { cause: error });
        }
        throw error;
      }
      const previous = fs.readFileSync(file, "utf8");
      const owner = JSON.parse(previous);
      // A PID is meaningful only on its own host. Unknown/legacy owners must
      // also stay locked rather than risk reclaiming another machine's writer.
      if (!hostname || owner.hostname !== hostname) {
        throw new Error("Não foi possível identificar o host dono do writer do armazenamento. Não use um armazenamento compartilhado e confira quem está com o bloqueio.");
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid)) {
        throw new Error("Outro writer está usando este armazenamento.");
      }
      // Serialize stale-owner recovery. New writers can only claim the main
      // file after unlink; no reclaimer removes a replacement owner's file.
      const releaseRecovery = acquire(`${file}.recovery`, depth + 1);
      try {
        if (fs.readFileSync(file, "utf8") !== previous) throw new Error("O writer do armazenamento mudou.");
        fs.unlinkSync(file);
        fs.linkSync(temporary, file);
      } finally { releaseRecovery(); }
    }
  } finally { fs.unlinkSync(temporary); }
  const release = () => {
    try { if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    owned.delete(release);
  };
  owned.add(release);
  return release;
}

function acquireWriter(root) {
  fs.mkdirSync(root, { recursive: true });
  return acquire(path.join(fs.realpathSync(root), ".writer-lock"));
}
module.exports = { acquireWriter };
