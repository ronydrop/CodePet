document.title = "Limite restante do CodePet";
const api = window.usageApi;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const remainingPercent = (used) => typeof used === "number" && Number.isFinite(used) ? Math.round(100 - Math.max(0, Math.min(100, used))) : null;
const tone = (value) => value == null ? "" : value <= 10 ? "critical" : value <= 30 ? "warning" : "";
function resetLabel(value) {
  if (!value) return "Horário de reinício não informado";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toLocaleString("pt-BR", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" })} · reinicia`;
}
function intervalLabel(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60000);
  return minutes >= 1 ? `atualiza automaticamente a cada ${minutes} min` : "Atualização automática";
}
function render(data) {
  if (!data) return;
  const rows = data.providers.filter((p) => p.connected);
  const loading = data.providers.some((p) => p.loading);
  const container = document.getElementById("providers");
  container.replaceChildren();
  if (!rows.length) container.append(element("p", "empty", loading ? "Conferindo o login…" : "Nenhum serviço está conectado."));
  for (const row of rows) {
    const card = element("article", "usage-card");
    const heading = element("header", "usage-card-heading");
    const identity = element("div", "card-identity");
    identity.append(element("h2", "", row.label));
    if (row.account) identity.append(element("small", "", row.account));
    heading.append(element("span", "provider-mark", row.label.slice(0, 1)), identity);
    if (row.plan) heading.append(element("span", "count-label", row.plan));
    card.append(heading);
    for (const gauge of row.gauges) {
      const value = remainingPercent(gauge.usedPercent);
      const group = element("div", `gauge ${tone(value)}`);
      const label = element("div", "usage-row");
      const name = element("span", "", gauge.label);
      name.title = gauge.label;
      label.append(name, element("strong", "", value == null ? "—" : `${value}% restante`));
      group.append(label);
      if (value != null) {
        const bar = element("progress", "usage-track"); bar.max = 100; bar.value = value; bar.setAttribute("aria-label", `Limite restante de ${row.label} ${gauge.label}`);
        group.append(bar);
      }
      group.append(element("small", "", resetLabel(gauge.resetText)));
      card.append(group);
    }
    if (row.error) card.append(element("p", "usage-error", row.stale ? `${row.error} · consulta anterior` : row.error));
    if (row.updatedAt) card.append(element("p", "card-meta", `${new Date(row.updatedAt).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" })}${row.loading ? " · atualizando…" : ""}`));
    container.append(card);
  }
  const disconnected = data.providers.filter((p) => !p.connected && !p.loading);
  if (disconnected.length) container.append(element("p", "disconnected", disconnected.map((p) => `${p.label}: ${p.error || "login necessário"}`).join(" · ")));
  document.getElementById("refresh").disabled = loading;
  document.getElementById("status").textContent = loading ? "Conferindo limites…" : intervalLabel(data.intervalMs);
}
for (const [id, action] of [["close","close"],["accounts","settings"]]) {
  document.getElementById(id).addEventListener("click", () => api?.action(action));
}
document.getElementById("refresh").addEventListener("click", async () => {
  const button = document.getElementById("refresh"); button.disabled = true;
  try { render(await api.refresh()); } catch { document.getElementById("status").textContent = "Falha ao atualizar"; }
  finally { button.disabled = false; }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") api?.action("close"); });
if (api) { api.onUpdate(render); api.get().then(render).catch(() => {}); }
