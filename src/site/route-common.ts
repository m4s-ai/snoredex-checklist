import { serializeQuery } from './query.js';

export const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

export function text(tag: string, value?: unknown, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}

export function setViewStatus(message: string): void {
  const status = document.querySelector<HTMLElement>('[data-view-status]');
  if (status) status.textContent = message;
}

export function link(href: string, label: string, className?: string): HTMLAnchorElement {
  const element = text('a', label, className) as HTMLAnchorElement;
  element.href = href;
  return element;
}

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

export function renderInvalid(container: HTMLElement, recoverableLocalization?: string, failClosed = false): void {
  if (failClosed) {
    for (const element of document.querySelectorAll<HTMLElement>('[data-catalogue-dependent]')) element.hidden = true;
  }
  container.hidden = false;
  const section = text('section', undefined, 'state-panel');
  section.setAttribute('aria-live', 'polite');
  const stateMessage = failClosed
    ? 'The complete link could not be validated. No catalogue or private collection state was read.'
    : 'The complete link could not be validated. No private collection state was read.';
  section.append(text('h2', 'Invalid checklist link'), text('p', stateMessage));
  const actions = text('p');
  if (recoverableLocalization || window.location.search) {
    actions.append(
      link(
        recoverableLocalization ? `./${serializeQuery({ localization: recoverableLocalization })}` : './',
        'Clear invalid criteria',
      ),
    );
  }
  const homeHref = document.body.dataset.page === 'collection' ? '../' : './';
  if (actions.childElementCount > 0) actions.append(' · ');
  actions.append(link(homeHref, 'Home'));
  section.append(actions);
  container.replaceChildren(section);
  setViewStatus(failClosed ? 'Catalogue unavailable.' : 'Invalid checklist link.');
}

export function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shellAppRevision(): string | undefined {
  const value = document.querySelector<HTMLMetaElement>('meta[name="snoredex-app-revision"]')?.content;
  return value && /^[0-9a-f]{40}$/u.test(value) ? value : undefined;
}

export function matchesShellRevision(provenance: unknown, appRevision: string): boolean {
  return isRuntimeRecord(provenance) && provenance.appRevision === appRevision;
}
