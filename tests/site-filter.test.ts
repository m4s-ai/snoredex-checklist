import assert from "node:assert/strict";
import test from "node:test";

import { matchesResearch } from "../src/site/filter.ts";

test("partitions research rows by the explicit criterion", () => {
  assert.equal(matchesResearch("current-known"), true);
  assert.equal(matchesResearch("research"), false);
  assert.equal(matchesResearch("current-known", "false"), true);
  assert.equal(matchesResearch("research", "false"), false);
  assert.equal(matchesResearch("current-known", "true"), false);
  assert.equal(matchesResearch("research", "true"), true);
});
