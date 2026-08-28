(() => {
  let stored;
  try {
    stored = localStorage.getItem('snoredex-theme');
  } catch {
    stored = null;
  }
  const theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = theme;
})();
