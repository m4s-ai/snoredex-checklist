import { $, enableThemeControl, renderUnavailable, shellAppRevision } from './route-common.js';

async function start(): Promise<void> {
  const appRevision = shellAppRevision();
  if (!appRevision) {
    renderUnavailable($('[data-view]'));
    return;
  }
  let startRoute: () => Promise<void>;
  try {
    if (document.body.dataset.page === 'collection') {
      const { startCollection } = await import('./collection.js');
      startRoute = () => startCollection(appRevision);
    } else if (document.body.dataset.page === 'index') {
      const { renderHome } = await import('./home.js');
      startRoute = renderHome;
    } else {
      throw new Error('Unsupported page');
    }
  } catch {
    renderUnavailable($('[data-view]'));
    return;
  }
  await startRoute();
}

enableThemeControl();
await start();
