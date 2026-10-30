function rateWindowLabel(rateWindow) {
  const windowMinutes = Number(
    typeof rateWindow === "object" ? rateWindow?.window_minutes : rateWindow
  );
  let label;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) label = "Limite de uso";
  else if (Math.abs(windowMinutes - 300) < 0.01) label = "Limite de 5 horas";
  else if (Math.abs(windowMinutes - 10080) < 0.01) label = "Limite semanal";
  else if (windowMinutes >= 28 * 1440 && windowMinutes <= 31 * 1440) label = "Limite mensal";
  else if (windowMinutes % 1440 === 0) label = `limite de ${windowMinutes / 1440} dias`;
  else if (windowMinutes % 60 === 0) label = `limite de ${windowMinutes / 60} horas`;
  else label = `limite de ${Math.round(windowMinutes)} min`;
  return rateWindow?.scope ? `${rateWindow.scope} · ${label}` : label;
}

module.exports = { rateWindowLabel };
