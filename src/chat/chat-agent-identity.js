const GROUP_ALIASES = Object.freeze(["all", "everyone", "todos", "pessoal", "galera", "모두", "전원", "얘들아"]);

function agentMention(agent) {
  return agent?.mention || agent?.id || "";
}

function aliasKey(value) {
  return String(value).normalize("NFC").toLowerCase();
}

function identityPatch(patch, agentId, agents) {
  const next = {};
  if (Object.hasOwn(patch || {}, "name")) {
    if (typeof patch.name !== "string") throw new Error("Informe o nome de exibição.");
    const name = patch.name.normalize("NFC").trim();
    if (name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) {
      throw new Error("O nome de exibição deve ter até 40 caracteres, sem quebra de linha.");
    }
    next.name = name;
  }
  if (Object.hasOwn(patch || {}, "mention")) {
    if (typeof patch.mention !== "string") throw new Error("Informe o apelido de chamada.");
    const mention = patch.mention.normalize("NFC").trim().replace(/^@/, "");
    if (mention && (mention.length > 40 || !/^[\p{L}\p{N}_-]+$/u.test(mention))) {
      throw new Error("O apelido de chamada deve ter até 40 caracteres: letras, números, sublinhado ou hífen.");
    }
    const key = aliasKey(mention || agentId);
    if (GROUP_ALIASES.some((alias) => aliasKey(alias) === key)
      || agents.some((agent) => agent.id !== agentId
        && [agent.id, ...(agent.aliases || [])].some((alias) => aliasKey(alias) === key))) {
      throw new Error("Este apelido de chamada já está em uso.");
    }
    next.mention = mention;
  }
  return next;
}

module.exports = { GROUP_ALIASES, agentMention, aliasKey, identityPatch };
