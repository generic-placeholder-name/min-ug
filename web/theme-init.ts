// Run before the body is parsed so a saved theme does not flash the system theme first.
try {
  const savedTheme = localStorage.getItem("minug-theme");
  if (savedTheme === "light" || savedTheme === "dark") {
    document.documentElement.dataset.theme = savedTheme;
  }
} catch {}
