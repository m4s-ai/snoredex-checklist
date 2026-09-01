import assert from 'node:assert/strict';
import test from 'node:test';

import fixture from './fixtures/collector-catalogue.fixture.json' with { type: 'json' };
import {
  collectorNumberLabel,
  evidenceCueLabel,
  imageScopeLabel,
  itemCueLabel,
  linkValues,
  presentText,
  safeExternalUrl,
} from '../src/site/item-presentation.ts';

test('keeps item presentation labels explicit and distinct', () => {
  const verified = fixture.catalogue.items[0];
  assert.equal(collectorNumberLabel(verified), '1/10');
  assert.equal(imageScopeLabel(verified, true), 'Authored placeholder (image scope unknown)');
  assert.equal(itemCueLabel(verified), 'Trackable');
  assert.equal(evidenceCueLabel(verified), 'Producer evidence: confirmed');

  const research = fixture.catalogue.items[1];
  assert.equal(itemCueLabel(research), 'Research · read-only');
  assert.equal(evidenceCueLabel(research), 'Producer evidence: marketplace-claimed');
  assert.equal(
    imageScopeLabel({ ...research, imageScope: 'card-release' }, true),
    'Card-release placeholder (broader release)',
  );
});

test('only publishes safe external links from untrusted snapshot fields', () => {
  assert.equal(presentText('  Poke\u0301mon  '), 'Pokémon');
  assert.equal(safeExternalUrl('https://example.test/evidence'), 'https://example.test/evidence');
  assert.equal(safeExternalUrl('javascript:alert(1)'), undefined);
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>'), undefined);
  assert.equal(safeExternalUrl('https://user:pass@example.test/private'), undefined);
  assert.equal(safeExternalUrl('https://example.test/\u202eevil'), undefined);
  assert.equal(safeExternalUrl('https://example.test/\nforged'), undefined);
  assert.deepEqual(linkValues(['https://example.test/a', 'javascript:alert(1)', 42, '<script>']), [
    'https://example.test/a',
  ]);
});
