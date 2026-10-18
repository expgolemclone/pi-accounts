import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { QuotaRecoveryError } from "../src/quota-failure.js";
import { runProbeProcess } from "../src/quota-probe.js";

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<object>()),
  getPackageDir: () => {
    throw new Error("Bearer private-access rt.private-refresh \u001b[31m");
  },
}));

test("host resolution failure is safe and occurs before any subprocess or inference", async () => {
  await assert.rejects(
    runProbeProcess({} as never, { apiKey: "private-access" }, new AbortController().signal),
    (error) => {
      assert.ok(error instanceof QuotaRecoveryError);
      assert.equal(error.reason, "modules");
      assert.doesNotMatch(error.message, /private-access|private-refresh|31m/);
      return true;
    },
  );
});
