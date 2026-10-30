function buildAccountSubmenu({ profiles = [], formatLabel, onSwitch, onLogin }) {
  const savedProfiles = Array.isArray(profiles) ? profiles : [];
  const labelFor = typeof formatLabel === "function" ? formatLabel : (profile) => profile.label;

  return [
    ...(savedProfiles.length
      ? savedProfiles.map((profile) => ({
          label: labelFor(profile),
          type: "radio",
          checked: Boolean(profile.active),
          enabled: profile.hasAuth !== false,
          click: () => onSwitch(profile.key),
        }))
      : [{ label: "Nenhuma conta salva", enabled: false }]),
    { type: "separator" },
    { label: "Entrar / adicionar conta", click: onLogin },
  ];
}

module.exports = { buildAccountSubmenu };
