import { validateProvenance } from './catalogue.js';
import { validateDirectorySnapshot } from './directory.js';
import directory, { provenance } from './directory-snapshot.js';
import { renderLocalizationLinks, renderProvenance } from './directory-view.js';
import { enableThemeControl } from './theme-control.js';

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

function renderInvalid(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-catalogue-dependent]')) element.hidden = true;
  const container = $<HTMLElement>('[data-view]');
  const section = document.createElement('section');
  section.className = 'state-panel';
  section.setAttribute('aria-live', 'polite');
  const heading = document.createElement('h2');
  heading.textContent = 'Invalid checklist link';
  const message = document.createElement('p');
  message.textContent = 'The complete link could not be validated. No catalogue or private collection state was read.';
  const home = document.createElement('a');
  home.href = './';
  home.textContent = 'Home';
  const actions = document.createElement('p');
  actions.append(home);
  section.append(heading, message, actions);
  container.hidden = false;
  container.replaceChildren(section);
}

enableThemeControl();
if (!validateDirectorySnapshot(directory) || !validateProvenance(provenance, directory)) {
  renderInvalid();
} else {
  renderProvenance($('[data-provenance]'), directory, provenance);
  renderLocalizationLinks($('[data-localizations]'), directory);
}
