import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AccountStore } from "../../src/account-store.js";
import { QuotaRecovery } from "../../src/quota-recovery.js";
import { OpenAISelection, type SharedSelection } from "../../src/shared-selection.js";
import { FileAccountStorageBackend } from "../../src/storage.js";

type Start = {
  directory: string;
  failed: SharedSelection;
  timeoutMs: number;
  hold: boolean;
  quota: boolean;
  retryToken?: string;
};
process.once("message", async (input: Start) => {
  const store = new AccountStore(new FileAccountStorageBackend(join(input.directory, "accounts.json")));
  const selection = new OpenAISelection(store);
  const recovery = new QuotaRecovery(
    store,
    selection,
    new FileAccountStorageBackend(join(input.directory, "recovery.json")),
    input.timeoutMs,
  );
  try {
    const result = await recovery.recover(
      input.failed,
      async () => {
        process.send?.({ kind: "probe" });
        await delay(input.hold ? 30_000 : 100);
        return input.quota ? "quota" : "pong";
      },
      AbortSignal.timeout(10_000),
      input.retryToken,
    );
    process.send?.({ kind: "result", result }, () => process.disconnect?.());
  } catch {
    process.send?.({ kind: "failed" }, () => process.disconnect?.());
  }
});
process.send?.({ kind: "ready" });
