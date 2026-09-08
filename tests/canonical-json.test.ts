import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize } from '../src/site/canonical-json.ts';
import { directoryProjectionDigest, directoryEnvelopeDigest } from '../src/site/directory.ts';
import { semanticFingerprint } from '../src/catalogue/validate.ts';

test('shared ordering preserves existing distinct semantic, projection and envelope vectors', async () => {
  const value = {
    z: [{ b: 2, a: 1 }, null, 'ä'],
    a: { '10': 'ten', '2': 'two', z: false },
    meta: { catalogueFingerprint: 'ignored', x: 1 },
  };
  assert.equal(
    JSON.stringify(canonicalize(value)),
    '{"a":{"2":"two","10":"ten","z":false},"meta":{"catalogueFingerprint":"ignored","x":1},"z":[{"a":1,"b":2},null,"ä"]}',
  );
  assert.equal(
    await directoryProjectionDigest(value),
    'sha256:0f6f676ba2b7ccd4500e78af5ff2f128def39d3665ef563631e21f800603c02d',
  );
  assert.equal(
    await directoryEnvelopeDigest(value, { z: 1, a: 2 }),
    'sha256:871ca537e14d3be60ca4014decbb022898f7b3b1286aecc57d8af2f576fdb047',
  );
  assert.equal(semanticFingerprint(value), 'sha256:75919211d49995c7033e9d115dc805e5fe4be654206add7731eaa5b49bbea301');
  const changedFingerprint = { ...value, meta: { ...value.meta, catalogueFingerprint: 'changed' } };
  assert.equal(semanticFingerprint(changedFingerprint), semanticFingerprint(value));
  assert.notEqual(await directoryProjectionDigest(changedFingerprint), await directoryProjectionDigest(value));
  assert.notEqual(await directoryEnvelopeDigest(value, {}), await directoryProjectionDigest(value));
});
