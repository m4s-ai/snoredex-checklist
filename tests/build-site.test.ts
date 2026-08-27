import assert from "node:assert/strict";
import test from "node:test";

import { replaceOutput } from "../scripts/site-output.ts";

test("reports the recovery path when replacement and restore both fail", async () => {
  const output = "/site";
  const previous = "/site.previous-123";
  const staging = "/site.staging-123";
  const calls: Array<[string, string]> = [];

  await assert.rejects(
    () => replaceOutput({
      output,
      previous,
      staging,
      renamePath: async (source, destination) => {
        calls.push([source, destination]);
        if (source === staging) throw new Error("install failed");
        if (source === previous) throw new Error("restore failed");
      },
      removePath: async () => {
        throw new Error("previous output should not be removed after a failed restore");
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      if (!(error instanceof AggregateError)) return false;
      assert.match(error.message, /install failed/);
      assert.match(error.message, /restore failed/);
      assert.match(error.message, /\/site\.previous-123/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  assert.deepEqual(calls, [[output, previous], [staging, output], [previous, output]]);
});
