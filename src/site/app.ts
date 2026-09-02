const page = document.body.dataset.page;

export {};

if (page === 'collection') {
  await import('./collection.js');
} else if (page === 'index') {
  await import('./index.js');
} else {
  throw new Error('Unsupported page');
}
