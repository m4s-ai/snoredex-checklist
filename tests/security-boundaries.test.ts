import assert from 'node:assert/strict';
import test from 'node:test';

import { parseQuery } from '../src/site/query.ts';
import { presentText, safeExternalUrl } from '../src/site/item-presentation.ts';
import { SECURITY_PAYLOADS } from './fixtures/security-payloads.ts';

const localizationIds = new Set(['fixture-loc-west-es']);

test('hostile strings stay bounded data at text, URL and query boundaries', () => {
  for (const payload of SECURITY_PAYLOADS) {
    const normalized = payload.normalize('NFC').trim().replace(/\s+/gu, ' ');
    assert.equal(presentText(payload), normalized);
    assert.equal(safeExternalUrl(payload), undefined);
    const parsed = parseQuery(`?q=${encodeURIComponent(payload)}`, localizationIds);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.criteria.q, payload.trim());
  }
});

test('query parsing rejects malformed and over-bounded untrusted input', () => {
  assert.deepEqual(parseQuery(`?q=${encodeURIComponent('term '.repeat(13))}`, localizationIds), { ok: false });
  assert.deepEqual(parseQuery('?q=%FF', localizationIds), { ok: false });
  assert.deepEqual(parseQuery('?unknown=ignore', localizationIds), { ok: false });
});
