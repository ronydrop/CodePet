// 채팅 실행기는 watcher rollout과 독립적이므로, 말풍선 표현도 작은 순수 함수로 분리합니다.
// action은 외부 codex:// 링크가 아니라 CodePet의 저장된 대화방을 여는 내부 IPC 경로입니다.
const CHAT_NOTIFICATION_ACTION = "chat-session:open";
const PROVIDERS = new Set(["claude", "codex", "agy", "grok"]);

function providerFromAgent(agentId) {
  const id = typeof agentId === "string" ? agentId.trim().toLowerCase() : "";
  if (PROVIDERS.has(id)) return id;
  const head = id.split("_")[0];
  return PROVIDERS.has(head) ? head : null;
}

const KIND_LABELS = Object.freeze({
  working: { title: "Tarefa iniciada", statusText: "O CodePet começou a tarefa.", busy: true },
  progress: { title: "Trabalhando", statusText: "O CodePet está avançando na tarefa.", busy: true },
  waiting: { title: "Aguardando entrada", statusText: "O CodePet está esperando a sua confirmação.", busy: true },
  completed: { title: "Tarefa concluída", statusText: "A tarefa do CodePet foi concluída.", busy: false },
  failed: { title: "Tarefa falhou", statusText: "Houve um problema na tarefa do CodePet.", busy: false },
  cancelled: { title: "Tarefa cancelada", statusText: "A tarefa do CodePet foi cancelada.", busy: false },
});

// 한 대화방에는 여러 agent run이 동시에 존재할 수 있으므로 방 id만으로는 부족합니다.
// IPC에서 전달한 영속 agent id와 함께 상태 키를 만들어, 한 agent의 정리가 다른 agent를 지우지 않게 합니다.
function chatNotificationActivityKey(sessionId, agentId) {
  const room = typeof sessionId === "string" ? sessionId.trim() : "";
  const agent = typeof agentId === "string" ? agentId.trim() : "";
  if (!room || !agent) return null;
  return `chat:${encodeURIComponent(room)}:${encodeURIComponent(agent)}`;
}

function buildChatNotificationBubble(notification) {
  const sessionId = typeof notification?.sessionId === "string" ? notification.sessionId.trim() : "";
  const detail = KIND_LABELS[notification?.kind];
  if (!sessionId || !detail) return null;

  const agentName = typeof notification.agentName === "string" && notification.agentName.trim()
    ? notification.agentName.trim()
    : "CodePet";
  const text = typeof notification.text === "string" && notification.text.trim()
    ? notification.text.trim()
    : detail.statusText;

  const provider = providerFromAgent(notification.agentId);
  return {
    kind: "activity",
    ...(provider ? { provider } : {}),
    title: `${agentName} · ${detail.title}`,
    busy: detail.busy,
    text,
    statusText: detail.statusText,
    primaryAction: {
      id: CHAT_NOTIFICATION_ACTION,
      payload: { sessionId },
    },
    clickHint: "Clique para abrir a conversa do CodePet",
    terminal: !detail.busy,
  };
}

module.exports = {
  CHAT_NOTIFICATION_ACTION,
  buildChatNotificationBubble,
  chatNotificationActivityKey,
};
