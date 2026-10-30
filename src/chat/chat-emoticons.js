const manifest = require("../chat-icon/emoticons/manifest.json");
const fs = require("node:fs");
const path = require("node:path");
const { maskNonCallingText } = require("./chat-mention");

const MAX_EMOTICONS_PER_MESSAGE = 1;
const EMOTICON_KEYS = Object.freeze(Object.keys(manifest));
const EMOTICON_PATTERN = /\[\[CODEPET_EMOTE:([^\]\r\n]+)\]\]/g;
const AGENT_EMOTICON_FOLDERS = Object.freeze({
  codex: "gpt",
  claude: "claude",
  agy: "gemini",
  grok: "grok",
});

const EMOTICON_MEANINGS = Object.freeze({
  "검토완료": "quando terminar a revisão de código, documento ou resultado",
  "그건안돼": "quando recusar com clareza por segurança, permissão ou impossibilidade técnica",
  "그정돈아님": "quando reduzir com calma uma avaliação exagerada",
  "좋은데": "quando concordar claramente e ficar satisfeito com a proposta ou o resultado",
  "내가볼게": "quando for conferir pessoalmente ou assumir a tarefa",
  "파일줘봐": "quando pedir um arquivo ou anexo necessário para decidir",
  "하트": "quando expressar gratidão, afeto ou boa vontade",
  "잠깐만": "quando precisar de um momento para conferir ou processar",
  "이건웃기네": "quando a situação for claramente engraçada ou absurda",
  "오류났다": "quando ocorrer um erro real de execução ou processamento",
  "수정완료": "quando a correção pedida estiver de fato concluída",
  "몰루": "quando ainda não souber ou suspender o julgamento por falta de informação",
  "우헤헤": "quando estiver discretamente satisfeito com um sucesso pequeno ou uma travessura",
  "주인님": "ao receber um pedido ou cumprimentar o usuário de forma amigável",
  "멍청": "Use só para rir de um erro simples seu. Nunca para insultar o usuário.",
});

function availableEmoticonKeys(agentId = "codex") {
  const folder = Object.hasOwn(AGENT_EMOTICON_FOLDERS, agentId)
    ? AGENT_EMOTICON_FOLDERS[agentId]
    : null;
  if (!folder) return [];
  let files;
  try {
    files = new Set(
      fs.readdirSync(path.join(__dirname, "..", "chat-icon", "emoticons", folder))
    );
  } catch {
    return [];
  }
  return EMOTICON_KEYS.filter((key) => files.has(manifest[key]));
}

function emoticonPromptRules(agentId) {
  const guide = availableEmoticonKeys(agentId)
    .map((key) => `${key}=${EMOTICON_MEANINGS[key]}`)
    .join("; ");
  return [
    "- Em cada resposta, use só 1 emoticon do personagem, o que melhor corresponder à emoção e à situação.",
    `- Dicionário de emoticons (chave=quando usar): ${guide}`,
    "- Não escolha uma chave só porque a palavra apareceu. Escolha a chave cujo significado corresponda à atitude da resposta e ao que foi ou não concluído.",
    "- Insira [[CODEPET_EMOTE:chave]] em um ponto natural (início, entre parágrafos ou no fim), usando uma chave exata do dicionário. Quebre a linha antes e depois, não deixe o marcador na mesma linha do texto e não repita o mesmo emoticon.",
    "- O aplicativo troca esse marcador por uma imagem. Não o explique nem o coloque em bloco ou código inline. Chaves agressivas ou brincalhonas só quando o contexto realmente pedir.",
  ];
}

function extractEmoticons(value, limit = MAX_EMOTICONS_PER_MESSAGE, agentId = "codex") {
  const emoticons = [];
  const seen = new Set();
  const parts = [];
  const source = String(value || "");
  const scanSource = maskNonCallingText(source);
  const allowedKeys = new Set(availableEmoticonKeys(agentId));
  let lastIndex = 0;
  for (const match of scanSource.matchAll(EMOTICON_PATTERN)) {
    const preceding = source.slice(lastIndex, match.index).trim();
    if (preceding) parts.push({ type: "text", text: preceding });
    const key = String(match[1] || "").trim();
    const file = manifest[key];
    if (file && allowedKeys.has(key) && emoticons.length < limit && !seen.has(key)) {
      seen.add(key);
      const emoticon = { key, file, folder: AGENT_EMOTICON_FOLDERS[agentId] };
      emoticons.push(emoticon);
      parts.push({ type: "emoticon", ...emoticon });
    }
    lastIndex = match.index + match[0].length;
  }
  const trailing = source.slice(lastIndex).trim();
  if (trailing) parts.push({ type: "text", text: trailing });

  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text,
    emoticons,
    parts,
  };
}

module.exports = {
  EMOTICON_KEYS,
  EMOTICON_MEANINGS,
  MAX_EMOTICONS_PER_MESSAGE,
  emoticonPromptRules,
  availableEmoticonKeys,
  extractEmoticons,
};
