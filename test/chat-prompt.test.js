const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");

const AGENTS = [
  { id: "claude", name: "Claude", aliases: ["claude"] },
  { id: "codex", name: "Codex", aliases: ["codex"] },
];

function message(author, text, authorType = "agent") {
  return { author, authorType, text };
}

test("프롬프트에 역할, Participantes, 대화 기록이 화자 라벨과 함께 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [
      message("user", "@codex, @claude 응답해라", "user"),
      message("claude", "안녕하세요!"),
    ],
  });

  assert.match(prompt, /Você é "@codex" \(Codex\)/);
  assert.match(prompt, /Participantes: Usuário \(User\), @claude\(Claude\), @codex\(Codex\)/);
  assert.match(prompt, /\[User\] @codex, @claude 응답해라/);
  assert.match(prompt, /\[@claude\] 안녕하세요!/);
  assert.match(prompt, /Agora é a vez de "@codex" responder\./);
});

test("@멘션은 실제 호출이고 이름만 쓰면 언급이라는 규칙이 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
  });
  assert.match(prompt, /Esse participante responde em seguida/);
  assert.match(prompt, /use o nome sem @/);
  assert.doesNotMatch(prompt, /não pode chamar outros participantes/);
});

test("여러 AI는 친한 경쟁자처럼 가볍게 견제하되 협업 목표를 우선한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "같이 검토해줘", "user")],
  });
  assert.match(prompt, /colega próximo e um rival sutil/);
  assert.match(prompt, /provoque de leve/);
  assert.match(prompt, /Sem ataques pessoais/);
  assert.match(prompt, /Priorize a precisão/);
});

test("긴 대화는 최근 메시지만 남기고 생략 안내를 넣는다", () => {
  const messages = Array.from({ length: 50 }, (_, index) =>
    message("user", `메시지 ${index}`, "user")
  );
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages,
    maxMessages: 10,
  });

  assert.match(prompt, /\(40 mensagens anteriores omitidas\)/);
  assert.doesNotMatch(prompt, /\[User\] 메시지 39\n/);
  assert.match(prompt, /\[User\] 메시지 49/);
});

test("다른 Participantes가 없으면 멘션 규칙을 생략한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: [AGENTS[0]],
    messages: [message("user", "안녕", "user")],
  });
  assert.doesNotMatch(prompt, /Para chamar outro participante/);
});

test("Modo de permissão에 따라 도구 규칙이 달라진다", () => {
  const chat = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "chat",
  });
  assert.match(chat, /Responda só em conversa/);

  const read = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "workspace-read",
  });
  assert.match(read, /pode ler e pesquisar/);

  const write = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "workspace-write",
  });
  assert.match(write, /pode ler e modificar/);
});

test("토론 컨텍스트가 자율 종료 신호와 함께 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "주제", "user")],
    discussion: { turn: 2 },
  });
  assert.match(prompt, /turno 2 da discussão autônoma/);
  assert.match(prompt, /CODEPET_DISCUSSION:CONCLUDE/);
});

test("첨부가 있는 메시지는 첨부 이름이 함께 표기된다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [
      {
        author: "user",
        authorType: "user",
        text: "이 파일 봐줘",
        attachments: [{ name: "정리.md" }, { name: "shot.png" }],
      },
    ],
  });
  assert.match(prompt, /\[Anexo: 정리\.md, shot\.png\]/);
});

test("extraLines가 대화 끝 뒤에 추가된다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    extraLines: ["=== 첨부 내용 ===", "파일: note.txt"],
  });
  assert.match(prompt, /=== Fim da conversa ===\n=== 첨부 내용 ===\n파일: note\.txt/);
});

test("에이전트가 매 답변에 Emoticon 한 개를 선택하도록 안내한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "검토해줘", "user")],
  });
  assert.match(prompt, /use só 1 emoticon/);
  assert.match(prompt, /CODEPET_EMOTE:chave/);
  assert.match(prompt, /Dicionário de emoticons/);
  assert.match(prompt, /주인님=ao receber um pedido/);
  assert.match(prompt, /멍청=.*Nunca para insultar o usuário/);
  assert.match(prompt, /Não escolha uma chave só porque a palavra apareceu/);
  assert.match(prompt, /início, entre parágrafos ou no fim/);
  assert.match(prompt, /Quebre a linha antes e depois/);
  assert.match(prompt, /검토완료/);
});

test("Resposta citada은 대상 발언과 발췌를 사용자 메시지 앞에 표시한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [
      {
        author: "user",
        authorType: "user",
        text: "이 의견을 검토해줘",
        replyTo: {
          messageId: "m-original",
          author: "codex",
          authorType: "agent",
          excerpt: "첫 줄\n둘째 줄",
        },
      },
    ],
  });

  assert.match(prompt, /\[User\] \(Citação: @codex "첫 줄 둘째 줄"\) 이 의견을 검토해줘/);
});
