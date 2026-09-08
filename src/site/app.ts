import { $, enableThemeControl, renderInvalid, shellAppRevision } from './route-common.js';

async function start(): Promise<void> {
  const appRevision = shellAppRevision();
  if (!appRevision) {
    renderInvalid($('[data-view]'), undefined, true);
    return;
  }
  if (document.body.dataset.page === 'collection') {
    const { startCollection } = await import('./collection.js');
    await startCollection(appRevision);
    return;
  }
  if (document.body.dataset.page === 'index') {
    const { renderHome } = await import('./home.js');
    await renderHome();
    return;
  }
  throw new Error('Unsupported page');
}

enableThemeControl();
await start();
