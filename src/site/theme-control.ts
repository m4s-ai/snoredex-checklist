export function enableThemeControl(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;
  const update = (): void => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    button.textContent = 'Dark theme';
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  };
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('snoredex-theme', next);
    } catch {
      /* theme preference stays local */
    }
    update();
  });
  update();
}
