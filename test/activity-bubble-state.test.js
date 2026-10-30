const test = require("node:test");
const assert = require("node:assert/strict");
const { ActivityBubbleState, applyActivityPrivacy } = require("../src/activity-bubble-state");

const THREADS = [
  "019f4a30-b0a7-73f1-8080-2ba11b4e5d25",
  "019f4a31-1111-7222-8333-444444444444",
  "019f4a32-2222-7333-8444-555555555555",
  "agy:session-1",
  "claude:session-1",
  "agy:session-2",
];

function activity(title, text, statusText) {
  return { kind: "activity", title, busy: true, text, statusText };
}

function startedAt(seconds) {
  return `2026-07-10T13:02:${String(seconds).padStart(2, "0")}.000Z`;
}

test("대화는 실제 시작 시각 순서를 유지하고 각 제목 아래 자기 내용을 가진다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("Testando", "terra detail", "terra status"), {
    workerLabel: "Terra",
    taskStartedAt: startedAt(30),
  });
  state.upsert(THREADS[3], activity("AGY Escrevendo a resposta", "agy detail", "agy status"), {
    taskStartedAt: startedAt(10),
  });
  state.upsert(THREADS[4], activity("Claude Executando comando", "claude detail", "claude status"), {
    taskStartedAt: startedAt(20),
  });
  state.upsert(THREADS[0], activity("Compilando", "new terra detail", "terra status"), {
    workerLabel: "Terra",
    taskStartedAt: startedAt(1),
  });

  const bubble = state.toBubbleData();
  assert.equal(bubble.title, "3 tarefas em andamento");
  assert.deepEqual(bubble.sections.map((section) => section.title), [
    "AGY Escrevendo a resposta",
    "Claude Executando comando",
    "Terra · Compilando",
  ]);
  assert.deepEqual(bubble.sections.map((section) => section.text), [
    "agy detail",
    "claude detail",
    "new terra detail",
  ]);
  assert.deepEqual(bubble.sections.map((section) => section.provider), ["agy", "claude", undefined]);
});

test("Codex·AGY·Claude를 합쳐 최대 다섯 대화를 표시하고 빈자리에 다음 대화를 올린다", () => {
  const state = new ActivityBubbleState();
  THREADS.forEach((threadId, index) => {
    state.upsert(threadId, activity(`대화 ${index + 1}`, `내용 ${index + 1}`, `상태 ${index + 1}`), {
      taskStartedAt: startedAt(index + 1),
    });
  });

  assert.equal(state.size, 6);
  assert.deepEqual(state.getVisibleThreadIds(), THREADS.slice(0, 5));
  assert.equal(state.toBubbleData().sections.length, 5);
  assert.equal(state.toBubbleData().title, "6 tarefas em andamento");
  state.remove(THREADS[1]);
  assert.deepEqual(state.getVisibleThreadIds(), [THREADS[0], ...THREADS.slice(2, 6)]);
});

test("한 대화만 남으면 기존 단일 말풍선 형태를 유지한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("Testando", "terra detail", "terra status"), {
    workerLabel: "Terra",
    taskStartedAt: startedAt(10),
  });

  const bubble = state.toBubbleData();
  assert.equal(bubble.sections, undefined);
  assert.equal(bubble.title, "Terra · Testando");
  assert.equal(bubble.text, "terra detail");
});

test("full/status/off 모드는 각 대화 section의 내용에 적용된다", () => {
  const data = {
    kind: "activity",
    title: "2 tarefas em andamento",
    sections: [
      activity("AGY Escrevendo a resposta", "agy detail", "AGY Trabalhando"),
      activity("Claude Escrevendo a resposta", "claude detail", "Claude Trabalhando"),
    ],
  };

  const full = applyActivityPrivacy(data, "full");
  assert.deepEqual(full.sections.map((section) => section.text), ["agy detail", "claude detail"]);
  assert.equal(full.sections[0].statusText, undefined);
  const status = applyActivityPrivacy(data, "status");
  assert.deepEqual(status.sections.map((section) => section.text), ["AGY Trabalhando", "Claude Trabalhando"]);
  assert.equal(applyActivityPrivacy(data, "off"), null);
});

test("허용된 Sol/Terra/Luna 라벨만 붙이고 외부 provider 제목은 그대로 유지한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("첫 작업", "detail", "status"), {
    workerLabel: "gpt-5.6-terra-internal",
  });
  state.upsert(THREADS[1], activity("둘째 작업", "detail", "status"), { workerLabel: "Luna" });
  state.upsert(THREADS[3], activity("AGY 작업", "detail", "status"), {});
  const bubble = state.toBubbleData();
  assert.deepEqual(bubble.sections.map((section) => section.title), [
    "첫 작업",
    "Luna · 둘째 작업",
    "AGY 작업",
  ]);
});
