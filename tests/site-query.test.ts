import assert from "node:assert/strict";
import test from "node:test";

import { parseQuery, serializeQuery } from "../src/site/query.ts";

const ids = new Set(["west-es", "latam-es"]);
const editionIds = new Set(["edition-west", "edition-latam"]);

test("round-trips canonical public criteria", () => {
  const criteria = { localization: "west-es", q: "Snorlax & friends", kind: "verified-printing" as const, research: "false" as const };
  const encoded = serializeQuery(criteria);
  assert.equal(encoded, "?localization=west-es&q=Snorlax+%26+friends&kind=verified-printing&research=false");
  assert.deepEqual(parseQuery(encoded, ids), { ok: true, criteria });
});

test("round-trips a validated set-edition deep link", () => {
  const criteria = { localization: "west-es", edition: "edition-west" };
  const encoded = serializeQuery(criteria);
  assert.equal(encoded, "?localization=west-es&edition=edition-west");
  assert.deepEqual(parseQuery(encoded, ids, editionIds), { ok: true, criteria });
  assert.deepEqual(parseQuery("?edition=unknown", ids, editionIds), { ok: false });
});

test("normalizes surrounding search whitespace without changing the URL contract", () => {
  assert.deepEqual(parseQuery("?q=%20Snorlax%20", ids), { ok: true, criteria: { q: "Snorlax" } });
  assert.equal(serializeQuery({ q: "  Snorlax  " }), "?q=Snorlax");
});

test("rejects the whole query when one criterion is invalid", () => {
  assert.deepEqual(parseQuery("?localization=west-es&q=ok&unknown=x", ids), { ok: false, recoverableLocalization: "west-es" });
  assert.deepEqual(parseQuery("?localization=west-es&status=maybe", ids), { ok: false, recoverableLocalization: "west-es" });
  assert.deepEqual(parseQuery("?localization=west-es&localization=latam-es", ids), { ok: false });
  assert.deepEqual(parseQuery("?localization=west-es&q=", ids), { ok: false, recoverableLocalization: "west-es" });
  assert.deepEqual(parseQuery("?localization=west-es&bad=%", ids), { ok: false });
});

test("keeps a status filter as a criterion without serializing collection records", () => {
  assert.deepEqual(parseQuery("?localization=west-es&status=have", ids), {
    ok: true,
    criteria: { localization: "west-es", status: "have" },
  });
  assert.equal(serializeQuery({ localization: "west-es", status: "have" }), "?localization=west-es&status=have");
});

test("allows non-ASCII search text within the decoded length limit", () => {
  const query = `?q=${encodeURIComponent("界".repeat(57))}`;
  const parsed = parseQuery(query, ids);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.criteria.q, "界".repeat(57));
});

test("rejects percent escapes that are not valid UTF-8", () => {
  assert.deepEqual(parseQuery("?q=%FF", ids), { ok: false });
  assert.deepEqual(parseQuery("?q=%C3%28", ids), { ok: false });
});
