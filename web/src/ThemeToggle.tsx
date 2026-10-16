export type ThemeMode = "system" | "light" | "dark";

export default function ThemeToggle({
  mode,
  onCycle,
}: {
  mode: ThemeMode;
  onCycle: () => void;
}) {
  const label = mode === "system" ? "System" : mode === "light" ? "Light" : "Dark";
  return (
    <button
      className="theme-toggle"
      data-mode={mode}
      type="button"
      onClick={onCycle}
      aria-label={`Theme: ${label}. Activate to cycle themes`}
      title="Cycles between system, light, and dark themes"
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        <svg className="theme-icon-system" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 0 0 18V3Z" className="theme-icon-half" />
        </svg>
        <svg className="theme-icon-sun" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
        </svg>
        <svg className="theme-icon-moon" viewBox="0 0 24 24">
          <path d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.7 8.7 0 1 0 20.2 15.1Z" />
          <path d="M16.5 3.5v3m-1.5-1.5h3" />
        </svg>
      </span>
      <span>{label}</span>
    </button>
  );
}
