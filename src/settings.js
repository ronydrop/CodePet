const api = window.settingsApi;
const rootElement = document.documentElement;
const toastElement = document.querySelector("#toast");
const fontSelect = document.querySelector("#font");
const fontSearch = document.querySelector("#font-search");
const fontSizeInput = document.querySelector("#font-size");
const fontSizeValue = document.querySelector("#font-size-value");

let state = null;
let installedFonts = [];
let fontsReady = false;
let fontsFailed = false;
let lastFontRender = null;
let fontSearchTimer = null;
let fontPreviewFrame = null;
let fontListVisible = false;
const previewedFontOptions = new Set();
let selectedFont = "";
let selectedFontSize = 12;
let toastTimer = null;

function $(selector) {
  return document.querySelector(selector);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function quoteFontFamily(fontFamily) {
  if (!fontFamily) return null;
  const escaped = String(fontFamily)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function createFontOption(label, value) {
  return new Option(label, value);
}

function scheduleFontPreviews() {
  if (!fontListVisible || fontPreviewFrame !== null) return;
  fontPreviewFrame = requestAnimationFrame(() => {
    fontPreviewFrame = null;
    if (!fontListVisible || !fontSelect.options.length) return;
    // Fixed-height native options retain keyboard navigation and scroll position.
    const rowHeight = fontSelect.options[0].getBoundingClientRect().height + 1;
    if (rowHeight <= 1) return;
    const first = Math.max(0, Math.floor(fontSelect.scrollTop / rowHeight) - 1);
    const end = Math.min(fontSelect.options.length, first + Math.ceil(fontSelect.clientHeight / rowHeight) + 3);
    const visible = new Set();
    for (let index = first; index < end; index++) {
      const option = fontSelect.options[index];
      if (option.value && !option.disabled) visible.add(option);
    }
    for (const option of previewedFontOptions) {
      if (visible.has(option)) continue;
      option.style.removeProperty("font-family");
      previewedFontOptions.delete(option);
    }
    for (const option of visible) {
      if (previewedFontOptions.has(option)) continue;
      option.style.fontFamily = quoteFontFamily(option.value);
      previewedFontOptions.add(option);
    }
  });
}

function applyAppearance(appearance, fontFamily = appearance?.fontFamily || "") {
  const quotedFont = quoteFontFamily(fontFamily);
  if (quotedFont) {
    rootElement.style.setProperty("--user-font", quotedFont);
    rootElement.style.setProperty("--font-display", quotedFont);
  } else {
    rootElement.style.removeProperty("--user-font");
    rootElement.style.removeProperty("--font-display");
  }

  const fontSize = Number(appearance?.fontSize);
  if (Number.isFinite(fontSize)) {
    rootElement.style.setProperty("--preview-font-size", `${fontSize}px`);
  } else {
    rootElement.style.removeProperty("--preview-font-size");
  }

  if (appearance?.bubbleBgColor) {
    rootElement.style.setProperty("--bubble-bg", appearance.bubbleBgColor);
  } else {
    rootElement.style.removeProperty("--bubble-bg");
  }
  if (appearance?.bubbleTextColor) {
    rootElement.style.setProperty("--bubble-ink", appearance.bubbleTextColor);
    const textHex = String(appearance.bubbleTextColor).trim();
    if (textHex.startsWith("#") && textHex.length === 7) {
      rootElement.style.setProperty("--bubble-muted", textHex + "a6");
    } else {
      rootElement.style.setProperty("--bubble-muted", textHex);
    }
  } else {
    rootElement.style.removeProperty("--bubble-ink");
    rootElement.style.removeProperty("--bubble-muted");
  }
}

function showError(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = String(message || "Ocorreu um erro.");
  toastElement.hidden = false;
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
    toastElement.textContent = "";
  }, 4500);
}

function responseError(response, fallback) {
  return response?.error || fallback;
}

function setButtonBusy(button, busy, busyLabel = "Processando…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.dataset.wasDisabled = String(button.disabled);
    button.textContent = busyLabel;
    button.disabled = true;
    return;
  }
  if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = button.dataset.wasDisabled === "true";
  delete button.dataset.wasDisabled;
}

function replaceOptions(select, options, selectedValue) {
  select.replaceChildren(...options);
  select.value = selectedValue || "";
}

function resolveInstalledFontFamily(fontFamily) {
  const requested = String(fontFamily || "").trim();
  if (!requested) return "";
  // Keep the saved choice while discovery is pending or unavailable.
  if (!fontsReady || installedFonts.length === 0) return requested;
  const exact = installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === requested.toLocaleLowerCase("en")
  );
  if (exact) return exact;

  // 이전 버전은 Arial Bold처럼 개별 face 이름을 저장했습니다. 현재 목록은 CSS가 실제로
  // 인식하는 family 이름만 제공하므로, 남아 있는 style 꼬리표를 한 번 걷어내 이관합니다.
  const family = requested.replace(
    /\s+(?:Regular|Roman|Book|Medium|SemiBold|DemiBold|Bold|Light|Thin|Black|Italic)$/i,
    ""
  );
  return installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === family.toLocaleLowerCase("en")
  ) || "";
}

function updateFontPreview() {
  $("#font-preview-name").textContent = selectedFont || "Padrão do sistema";
  fontSizeInput.value = String(selectedFontSize);
  fontSizeValue.value = `${selectedFontSize}px`;
  applyAppearance({ ...(state?.appearance || {}), fontSize: selectedFontSize }, selectedFont);
}

function renderFonts() {
  const query = fontSearch.value.trim().toLocaleLowerCase("ko");
  if (lastFontRender?.fonts === installedFonts && lastFontRender.query === query
    && lastFontRender.selected === selectedFont && lastFontRender.ready === fontsReady
    && lastFontRender.failed === fontsFailed) {
    updateFontPreview();
    return;
  }
  lastFontRender = { fonts: installedFonts, query, selected: selectedFont, ready: fontsReady, failed: fontsFailed };
  const filteredFonts = query
    ? installedFonts.filter((font) => font.toLocaleLowerCase("ko").includes(query))
    : installedFonts;
  const options = [createFontOption("Padrão do sistema", "")];

  if (selectedFont && !filteredFonts.includes(selectedFont)) {
    options.push(createFontOption(`${selectedFont} · atual`, selectedFont));
  }
  options.push(...filteredFonts.map((font) => createFontOption(font, font)));
  if (fontsReady && query && filteredFonts.length === 0) {
    const empty = new Option("Nenhum resultado", "__empty__");
    empty.disabled = true;
    options.push(empty);
  }

  replaceOptions(fontSelect, options, selectedFont);
  previewedFontOptions.clear();
  fontSelect.setAttribute("aria-busy", String(!fontsReady && !fontsFailed));
  $("#font-count").textContent = !fontsReady ? (fontsFailed ? "Falha na consulta" : "Carregando") : query
    ? `${filteredFonts.length} / ${installedFonts.length}`
    : `${installedFonts.length}`;
  updateFontPreview();
  scheduleFontPreviews();
}

async function loadFonts() {
  try {
    const response = await api.fonts();
    if (!response?.ok || !Array.isArray(response.data)) throw new Error("fonts unavailable");
    installedFonts = response.data;
    fontsReady = true;
    selectedFont = resolveInstalledFontFamily(selectedFont);
  } catch {
    fontsFailed = true;
  }
  if (state) renderFonts();
}

function renderGeneral({ resetAppearance = false } = {}) {
  if (!state) return;
  if (resetAppearance) {
    selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
    selectedFontSize = Number(state.appearance.fontSize) || 12;
  }
  replaceOptions(
    $("#pet"),
    state.pets.map((pet) => new Option(pet.label, pet.key)),
    state.petKey
  );
  $("#bubble-mode").value = state.activityBubbleMode;
  $("#autostart").checked = state.autoStart;
  $("#work-mode").checked = Boolean(state.appearance.workMode);

  const bgVal = state.appearance.bubbleBgColor || "";
  $("#bubble-bg-color").value = bgVal;
  if (/^#[0-9a-fA-F]{6}$/.test(bgVal) || /^#[0-9a-fA-F]{3}$/.test(bgVal) || /^#[0-9a-fA-F]{8}$/.test(bgVal)) {
    $("#bubble-bg-picker").value = bgVal.slice(0, 7);
  } else {
    $("#bubble-bg-picker").value = "#ffffff";
  }

  const textVal = state.appearance.bubbleTextColor || "";
  $("#bubble-text-color").value = textVal;
  if (/^#[0-9a-fA-F]{6}$/.test(textVal) || /^#[0-9a-fA-F]{3}$/.test(textVal)) {
    $("#bubble-text-picker").value = textVal.slice(0, 7);
  } else {
    $("#bubble-text-picker").value = "#09090b";
  }

  renderFonts();
}

function accountInitial(account, provider) {
  const source = account.email || account.label || provider.label || "C";
  return source.trim().slice(0, 1).toLocaleUpperCase("ko") || "C";
}

function createEmptyState(title) {
  const empty = createElement("div", "empty-state");
  empty.appendChild(createElement("strong", "", title));
  return empty;
}

function createGrokDockerRow(provider) {
  const status = provider.dockerRead;
  const hostSync = status.loginMode === "host-sync";
  const row = createElement("article", "list-row docker-runtime-row");
  const identity = createElement("div", "list-identity");
  identity.appendChild(createElement("span", "account-avatar", "D"));

  const copy = createElement("div", "list-copy");
  const titleRow = createElement("span");
  titleRow.appendChild(createElement("strong", "", "Workspace Docker"));
  if (status.authenticated) titleRow.appendChild(createElement("span", "active-chip", "Conectada"));
  copy.append(
    titleRow,
    createElement("small", "", status.reason || "Isola só um projeto, somente leitura.")
  );
  identity.appendChild(copy);

  let actionLabel = hostSync ? "Sincronizar autenticação" : "Login do Docker";
  if (status.available === false) actionLabel = "Indisponível";
  else if (status.authenticated) actionLabel = hostSync ? "Sincronizar de novo" : "Entrar de novo";
  const button = createElement(
    "button",
    "button",
    actionLabel
  );
  button.type = "button";
  button.disabled = status.available === false;
  button.addEventListener("click", () =>
    runAccountAction({ provider: provider.id, action: "docker-login" }, button)
  );
  row.append(identity, button);
  return row;
}

function createProviderGroup(provider) {
  const group = createElement("section", "provider-group");
  const heading = createElement("header", "provider-heading");
  const title = createElement("div", "provider-title");
  title.append(
    createElement("span", "provider-mark", provider.label.slice(0, 1)),
    createElement("h2", "", provider.label)
  );

  const addButton = createElement("button", "button", "Adicionar conta");
  addButton.type = "button";
  addButton.addEventListener("click", () =>
    runAccountAction({ provider: provider.id, action: "login" }, addButton)
  );
  heading.append(title, addButton);
  group.appendChild(heading);

  const list = createElement("div", "stack-list");
  if (provider.id === "grok" && provider.dockerRead) {
    list.appendChild(createGrokDockerRow(provider));
  }
  if (!provider.accounts?.length) {
    list.appendChild(createEmptyState("Nenhuma conta salva"));
  }

  for (const account of provider.accounts || []) {
    const row = createElement("article", "list-row");
    const identity = createElement("div", "list-identity");
    identity.appendChild(
      createElement("span", "account-avatar", accountInitial(account, provider))
    );

    const copy = createElement("div", "list-copy");
    const titleRow = createElement("span");
    titleRow.appendChild(createElement("strong", "", account.email || account.label));
    if (account.active) titleRow.appendChild(createElement("span", "active-chip", "Atual"));
    copy.appendChild(titleRow);
    if (account.plan) copy.appendChild(createElement("small", "", account.plan));
    identity.appendChild(copy);

    const actions = createElement("div", "list-actions");
    const switchButton = createElement(
      "button",
      "button",
      account.active ? "Em uso" : "Trocar"
    );
    switchButton.type = "button";
    switchButton.disabled = account.active;
    switchButton.addEventListener("click", () =>
      runAccountAction(
        { provider: provider.id, action: "switch", profileKey: account.key },
        switchButton
      )
    );
    actions.appendChild(switchButton);

    const deleteButton = createElement("button", "button danger-button", "Excluir");
    deleteButton.type = "button";
    deleteButton.disabled = account.active;
    deleteButton.addEventListener("click", () => {
      const accountLabel = account.email || account.label || provider.label;
      if (!window.confirm(`Excluir a conta salva "${accountLabel}"?`)) return;
      runAccountAction(
        { provider: provider.id, action: "delete", profileKey: account.key },
        deleteButton
      );
    });
    actions.appendChild(deleteButton);
    row.append(identity, actions);
    list.appendChild(row);
  }
  group.appendChild(list);
  return group;
}

function renderAccounts() {
  const root = $("#provider-groups");
  root.replaceChildren();
  for (const provider of state?.providers || []) {
    root.appendChild(createProviderGroup(provider));
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function resetLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(String(value))) {
    return String(value);
  }
  return `${new Intl.DateTimeFormat("pt-BR", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)} · reinicia`;
}

function createUsageGauge(gauge) {
  const used = clampPercent(gauge.usedPercent);
  const remaining = Math.round(100 - used);
  const container = createElement("div", "usage-gauge");
  const row = createElement("div", "usage-row");
  row.append(
    createElement("span", "", gauge.label),
    createElement("strong", "", `${remaining}% restante`)
  );
  const track = createElement("div", "usage-track");
  const fill = createElement("i", used >= 90 ? "is-danger" : used >= 70 ? "is-warn" : "");
  fill.style.width = `${remaining}%`;
  track.appendChild(fill);
  container.append(row, track, createElement("small", "", resetLabel(gauge.resetText)));
  return container;
}

function renderUsage() {
  const root = $("#usage-cards");
  root.replaceChildren();
  for (const item of state?.usage || []) {
    const card = createElement("article", "usage-card");
    const heading = createElement("header", "usage-card-heading");
    heading.append(
      createElement("span", "provider-mark", item.label.slice(0, 1)),
      createElement("h2", "", item.label)
    );
    card.appendChild(heading);

    if (item.error) {
      card.appendChild(createElement("p", "usage-error", item.error));
    } else if (!item.gauges?.length) {
      card.appendChild(createElement("p", "usage-error", "Sem informação de limite"));
    } else {
      for (const gauge of item.gauges) card.appendChild(createUsageGauge(gauge));
    }
    root.appendChild(card);
  }
}

function renderAll(options = {}) {
  renderGeneral(options);
  renderAccounts();
  renderUsage();
}

async function runAccountAction(input, sourceButton) {
  const busyLabel = input.action === "switch"
    ? "Trocando…"
    : input.action === "delete"
      ? "Excluindo…"
      : input.action === "docker-login"
        ? "Preparando…"
        : "Abrindo…";
  setButtonBusy(sourceButton, true, busyLabel);
  try {
    const response = await api.account(input);
    if (!response?.ok) throw new Error(responseError(response, "A operação da conta falhou."));
    state = response.data;
    renderAccounts();
    renderUsage();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setButtonBusy(sourceButton, false);
  }
}

function activateSection(button, { focus = false } = {}) {
  const sectionId = button.dataset.section;
  for (const navButton of document.querySelectorAll(".nav-item")) {
    const active = navButton === button;
    navButton.classList.toggle("is-active", active);
    navButton.setAttribute("aria-selected", String(active));
    navButton.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(".panel")) {
    const active = panel.id === sectionId;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  $("#section-label").textContent = button.dataset.label;
  if (focus) button.focus();
  $(".workspace").scrollTo({ top: 0, behavior: "smooth" });
}

function registerNavigation() {
  const buttons = [...document.querySelectorAll(".nav-item")];
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => activateSection(button));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      let targetIndex = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        targetIndex = (index + 1) % buttons.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        targetIndex = (index - 1 + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = buttons.length - 1;
      }
      activateSection(buttons[targetIndex], { focus: true });
    });
  });
  api.onNavigate((section) => {
    const target = buttons.find((button) => button.dataset.section === section);
    if (target) activateSection(target);
  });
}

function registerAppearanceControls() {
  fontSearch.addEventListener("input", () => {
    clearTimeout(fontSearchTimer);
    fontSearchTimer = setTimeout(renderFonts, 100);
  });
  fontSelect.addEventListener("scroll", scheduleFontPreviews, { passive: true });
  window.addEventListener("resize", scheduleFontPreviews);
  const fontVisibility = new IntersectionObserver(([entry]) => {
    fontListVisible = entry.isIntersecting;
    scheduleFontPreviews();
  });
  fontVisibility.observe(fontSelect);
  fontSelect.addEventListener("change", () => {
    if (fontSelect.value === "__empty__") return;
    selectedFont = fontSelect.value;
    updateFontPreview();
    scheduleFontPreviews();
  });
  fontSizeInput.addEventListener("input", () => {
    selectedFontSize = Number(fontSizeInput.value) || 12;
    updateFontPreview();
  });
  $("#save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "Aplicando…");
    try {
      const response = await api.save({
        fontFamily: selectedFont || null,
        fontSize: selectedFontSize,
        workMode: $("#work-mode").checked,
        petKey: $("#pet").value,
        activityBubbleMode: $("#bubble-mode").value,
        autoStart: $("#autostart").checked,
        bubbleBgColor: $("#bubble-bg-color").value.trim() || null,
        bubbleTextColor: $("#bubble-text-color").value.trim() || null,
      });
      if (!response?.ok) throw new Error(responseError(response, "Não foi possível aplicar as configurações."));
      state = response.data;
      renderAll({ resetAppearance: true });
      applyAppearance(state.appearance, selectedFont);
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerProviderControls() {
  $("#refresh-accounts").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "Verificando…");
    try {
      const response = await api.get();
      if (!response?.ok) throw new Error(responseError(response, "Não foi possível consultar as contas."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });

  $("#refresh-usage").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "Verificando…");
    try {
      const response = await api.usage();
      if (!response?.ok) throw new Error(responseError(response, "Não foi possível consultar o uso."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerAppearanceUpdates() {
  api.onAppearance((appearance) => {
    if (Number.isFinite(Number(appearance?.fontSize))) {
      selectedFontSize = Number(appearance.fontSize);
      fontSizeInput.value = String(selectedFontSize);
      fontSizeValue.value = `${selectedFontSize}px`;
    }
    applyAppearance(appearance, appearance?.fontFamily || selectedFont);
    if (state) state.appearance = { ...state.appearance, ...appearance };
  });
}

function registerTitlebarControls() {
  $("#btn-minimize").addEventListener("click", () => api.minimize());
  $("#btn-maximize").addEventListener("click", () => api.maximize());
  $("#btn-close").addEventListener("click", () => api.close());

  api.onMaximizedState((isMaximized) => {
    const btn = $("#btn-maximize");
    const maxIcon = btn.querySelector(".icon-maximize");
    const restoreIcon = btn.querySelector(".icon-restore");
    if (isMaximized) {
      if (maxIcon) maxIcon.style.display = "none";
      if (restoreIcon) restoreIcon.style.display = "block";
      btn.setAttribute("aria-label", "Restaurar tamanho");
    } else {
      if (maxIcon) maxIcon.style.display = "block";
      if (restoreIcon) restoreIcon.style.display = "none";
      btn.setAttribute("aria-label", "Maximizar");
    }
  });
}

function registerColorPickerControls() {
  const bgPicker = $("#bubble-bg-picker");
  const bgInput = $("#bubble-bg-color");
  const textPicker = $("#bubble-text-picker");
  const textInput = $("#bubble-text-color");

  function isValidColor(str) {
    const s = new Option().style;
    s.color = str;
    return s.color !== '';
  }

  bgPicker.addEventListener("input", () => {
    bgInput.value = bgPicker.value;
    updateLiveColors();
  });
  textPicker.addEventListener("input", () => {
    textInput.value = textPicker.value;
    updateLiveColors();
  });

  bgInput.addEventListener("input", () => {
    const val = bgInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val) || /^#[0-9a-fA-F]{8}$/.test(val)) {
      bgPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });
  textInput.addEventListener("input", () => {
    const val = textInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val)) {
      textPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });

  function updateLiveColors() {
    const bgVal = bgInput.value.trim();
    const textVal = textInput.value.trim();

    if (bgVal && isValidColor(bgVal)) {
      rootElement.style.setProperty("--bubble-bg", bgVal);
    } else {
      rootElement.style.removeProperty("--bubble-bg");
    }

    if (textVal && isValidColor(textVal)) {
      rootElement.style.setProperty("--bubble-ink", textVal);
    } else {
      rootElement.style.removeProperty("--bubble-ink");
    }
  }
}

async function initialize() {
  registerTitlebarControls();
  registerColorPickerControls();
  registerNavigation();
  registerAppearanceControls();
  registerProviderControls();
  registerAppearanceUpdates();
  registerUpdateControls();

  void loadFonts();
  try {
    const settingsResponse = await api.get();
    if (!settingsResponse?.ok) {
      throw new Error(responseError(settingsResponse, "Não foi possível carregar as configurações."));
    }
    state = settingsResponse.data;
    selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
    selectedFontSize = Number(state.appearance.fontSize) || 12;
    renderAll({ resetAppearance: true });
    applyAppearance(state.appearance, selectedFont);
  } catch (error) {
    showError(error.message || String(error));
  }
}

function registerUpdateControls() {
  const button = $("#download-update");
  const checkButton = $("#check-update");
  const feedback = $("#update-status");
  const version = $("#app-version");
  let checking = false;
  let busy = false;
  let currentVersion = version.textContent;
  let actionLabel = "Baixar versão nova";
  function renderProgress(update) {
    busy = ["downloading", "verifying", "restarting"].includes(update?.phase);
    button.disabled = busy;
    checkButton.disabled = checking || busy;
    button.setAttribute("aria-busy", String(busy));
    const label = update?.phase === "downloading" ? `Download ${update.percent || 0}%`
      : update?.phase === "verifying" ? "Conferindo o arquivo…"
        : update?.phase === "restarting" ? "Reiniciando…" : null;
    version.textContent = label || currentVersion;
    button.title = label || actionLabel;
    button.setAttribute("aria-label", button.title);
    if (busy) button.hidden = false;
  }
  async function refresh(force = false) {
    if (checking || busy) return;
    checking = true;
    checkButton.disabled = true;
    checkButton.setAttribute("aria-busy", "true");
    feedback.textContent = "Procurando atualizações…";
    try {
      const result = await api.checkUpdate(force);
      if (result?.currentVersion) currentVersion = `VERSION ${result.currentVersion}`;
      if (busy) return;
      button.hidden = result?.status !== "available";
      if (!button.hidden) {
        actionLabel = result.automatic ? `Atualizar para ${result.latestVersion} e reiniciar` : `Baixar a versão ${result.latestVersion}`;
      }
      renderProgress(result?.update);
      feedback.textContent = result?.status === "available" ? `A versão ${result.latestVersion} está disponível.`
        : result?.status === "up-to-date" ? "Esta é a versão mais recente."
          : "Não foi possível procurar atualizações. Confira a conexão e tente de novo.";
      if (result?.retryAfterMs) feedback.textContent += ` Você pode verificar de novo em ${Math.ceil(result.retryAfterMs / 1000)} s.`;
    } catch {
      button.hidden = true;
      feedback.textContent = "Não foi possível procurar atualizações. Tente de novo.";
    } finally {
      checking = false;
      checkButton.disabled = busy;
      checkButton.setAttribute("aria-busy", "false");
    }
  }
  button.addEventListener("click", async () => {
    if (busy) return;
    renderProgress({ phase: "downloading", percent: 0 });
    try {
      const result = await api.downloadUpdate();
      if (!result?.ok) {
        renderProgress({ phase: "error" });
        showError(responseError(result, "Não foi possível iniciar a atualização."));
      } else {
        renderProgress({ phase: result.restarting ? "restarting" : "idle" });
      }
    } catch {
      renderProgress({ phase: "error" });
      showError("Não foi possível iniciar a atualização. Tente de novo.");
    }
  });
  api.onUpdateProgress?.(renderProgress);
  checkButton.addEventListener("click", () => refresh(true));
  window.addEventListener("focus", () => refresh());
  void refresh();
}

initialize();
