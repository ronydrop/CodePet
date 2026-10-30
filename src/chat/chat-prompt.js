const DEFAULT_MAX_MESSAGES = 40;
const { emoticonPromptRules } = require("./chat-emoticons");
const { agentMention } = require("./chat-agent-identity");

function speakerLabel(message, agentsById) {
  if (message.authorType === "user") return message.authorName || "User";
  const agent = agentsById.get(message.author);
  return `@${agent ? agentMention(agent) : message.agentMeta?.mention || message.author}`;
}

function attachmentSuffix(message) {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) return "";
  const names = message.attachments.map((attachment) => attachment.name).join(", ");
  return ` [Anexo: ${names}]`;
}

function replyPrefix(message, agentsById) {
  const replyTo = message?.replyTo;
  if (!replyTo || typeof replyTo !== "object" || Array.isArray(replyTo)) return "";
  const excerpt = typeof replyTo.excerpt === "string"
    ? replyTo.excerpt.replace(/\s+/gu, " ").trim().slice(0, 200)
    : "";
  if (!excerpt) return "";
  const author = typeof replyTo.author === "string"
    ? replyTo.author.replace(/\s+/gu, " ").trim().slice(0, 80)
    : "";
  if (!author) return "";
  if (replyTo.authorType !== "user" && replyTo.authorType !== "agent") return "";
  const label = replyTo.authorType === "user"
    ? "User"
    : `@${agentMention(agentsById.get(author)) || author}`;
  const quoted = excerpt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `(Citação: ${label} "${quoted}") `;
}

function permissionRule(permissionMode) {
  if (permissionMode === "workspace-read") {
    return "- Você pode ler e pesquisar arquivos do workspace, mas não os modifique nem execute comandos.";
  }
  if (permissionMode === "workspace-write") {
    return "- Você pode ler e modificar arquivos do workspace. Não faça alterações fora do pedido.";
  }
  return "- Responda só em conversa, sem executar ferramentas nem modificar arquivos.";
}

function buildAgentPrompt({
  agent,
  agents,
  messages,
  maxMessages = DEFAULT_MAX_MESSAGES,
  permissionMode = "chat",
  workMode = false,
  discussion = null,
  broadcast = null,
  activeAgentIds = [],
  mentionsEnabled = !discussion,
  extraLines = [],
  continued = false,
}) {
  const agentsById = new Map(agents.map((entry) => [entry.id, entry]));
  const others = agents.filter((entry) => entry.id !== agent.id);
  const recent = messages.slice(-maxMessages);
  const omitted = messages.length - recent.length;

  const lines = [];
  lines.push(
    `Você é "@${agentMention(agent)}" (${agent.name}), participante de um chat em grupo com o usuário e vários agentes de código.`
  );
  const roster = ["Usuário (User)", ...agents.map((entry) => `@${agentMention(entry)}(${entry.name})`)];
  lines.push(`Participantes: ${roster.join(", ")}`);
  const working = agents.filter((entry) => entry.id !== agent.id && activeAgentIds.includes(entry.id));
  if (working.length) lines.push(`Participantes trabalhando agora: ${working.map((entry) => `@${agentMention(entry)}`).join(", ")}. Vale no início da execução e pode mudar durante a tarefa.`);
  const renamed = agents.filter((entry) => agentMention(entry) !== entry.id);
  if (renamed.length) lines.push(`IDs para consultar o histórico: ${renamed.map((entry) => `@${agentMention(entry)}=${entry.id}`).join(", ")}`);
  lines.push("");
  lines.push("Regras:");
  lines.push("- Continue naturalmente a partir da última mensagem da conversa abaixo.");
  lines.push(
    `- A saída inteira é enviada como uma única mensagem de chat. Não acrescente prefixo nem assinatura como "[@${agentMention(agent)}]".`
  );
  if (others.length > 0 && mentionsEnabled) {
    lines.push(
      `- Para chamar outro participante, use @nome (${others.map((entry) => `@${agentMention(entry)}`).join(", ")}). Esse participante responde em seguida. Para apenas mencionar, use o nome sem @. Chame só quando precisar.`
    );
    lines.push("- Se precisar delegar, reportar um resultado ou pedir revisão, chame o participante com @. Vários participantes começam ao mesmo tempo. Um pedido para quem já está trabalhando só roda depois da tarefa atual.");
    lines.push("- Outros participantes também podem trabalhar no mesmo workspace. Confira o escopo da conversa e o histórico necessário para evitar trabalho duplicado. Não sobrescreva nem reverta alterações de outro participante. Coordene edições sobrepostas no mesmo arquivo com quem é responsável.");
  } else if (others.length > 0) {
    lines.push("- Neste turno você não pode chamar outros participantes. Para mencioná-los, use só o nome, sem @.");
  }
  if (others.length > 0 && !workMode) {
    lines.push("- Com os outros agentes, converse como um colega próximo e um rival sutil. Reconheça o que estiver bom, aponte falhas ou discordâncias com tato e só provoque de leve quando isso soar natural.");
    lines.push("- Use o bate-boca só como tempero. Sem ataques pessoais, insultos, ironia pesada ou discordância sem fundamento. Priorize a precisão, o objetivo do usuário e a conclusão do grupo.");
  }
  lines.push(permissionRule(permissionMode));
  lines.push("- Responda de forma breve, no tom de um chat.");
  lines.push("- Responda no idioma usado na conversa.");
  if (!workMode) lines.push(...emoticonPromptRules(agent.providerId || agent.id));
  if (broadcast?.parallel) {
    lines.push("- Os outros participantes receberam a mesma mensagem do usuário ao mesmo tempo. Não espere as outras respostas: trabalhe e responda por conta própria.");
  } else if (broadcast && broadcast.position > 1) {
    lines.push(
      `- ${broadcast.total} participantes respondem em sequência à mensagem do usuário, e você é o ${broadcast.position}º. Leia as respostas anteriores, não repita o que já foi dito e só complemente ou traga outro ponto de vista.`
    );
  }
  if (discussion) {
    lines.push(
      `- Este é o turno ${discussion.turn} da discussão autônoma. Revise as respostas anteriores e contribua de forma breve só se tiver um argumento novo.`
    );
    lines.push("- Na última linha, coloque exatamente um destes marcadores: [[CODEPET_DISCUSSION:CONTINUE]], [[CODEPET_DISCUSSION:AGREE]], [[CODEPET_DISCUSSION:PASS]], [[CODEPET_DISCUSSION:CONCLUDE]].");
    lines.push("- Use CONTINUE para uma contribuição nova, AGREE se concordar sem conteúdo novo, PASS se não tiver o que acrescentar e CONCLUDE se apresentar uma conclusão final suficiente.");
  }
  lines.push("");
  lines.push("=== Conversa ===");
  if (continued) lines.push("Esta conversa continua o trabalho anterior da mesma sessão de CLI. Abaixo está só o que chegou depois. Não repita comandos anteriores nem tarefas já concluídas.");
  if (omitted > 0) lines.push(`(${omitted} mensagens anteriores omitidas)`);
  for (const message of recent) {
    lines.push(
      `[${speakerLabel(message, agentsById)}] ${replyPrefix(message, agentsById)}${message.text}${attachmentSuffix(message)}`
    );
  }
  lines.push("=== Fim da conversa ===");
  for (const line of extraLines) lines.push(line);
  lines.push("");
  lines.push(`Agora é a vez de "@${agentMention(agent)}" responder.`);
  return lines.join("\n");
}

module.exports = { buildAgentPrompt, DEFAULT_MAX_MESSAGES };
