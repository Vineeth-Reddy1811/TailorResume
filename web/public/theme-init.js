(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("tailorresume-theme");
    if (saved === "light" || saved === "dark") preference = saved;
  } catch {}

  const active = preference === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
  document.documentElement.dataset.theme = active;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = active === "dark" ? "#111713" : "#f5f5f1";
})();
