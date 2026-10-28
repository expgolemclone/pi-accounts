import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { AccountStore, type StoredCredential } from "../src/account-store.js";
import { QuotaRecoveryError } from "../src/quota-failure.js";
import { QuotaRecovery } from "../src/quota-recovery.js";
import { OpenAISelection } from "../src/shared-selection.js";
import { FileAccountStorageBackend } from "../src/storage.js";

const credential = (id: string): StoredCredential => ({
  type: "oauth",
  access: `access-${id}`,
  refresh: `refresh-${id}`,
  expires: 2_000_000_000_000,
  piAccountsGeneration: id,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture(run: (context: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "accounts-recovery-"));
  try {
    await run(await harness(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function harness(dir: string) {
  const store = new AccountStore(new FileAccountStorageBackend(join(dir, "accounts.json")));
  const selection = new OpenAISelection(store);
  await store.updateProvider("openai", () => ({
    active: "failed",
    accounts: {
      failed: credential("failed"),
      first: credential("first"),
      second: credential("second"),
    },
  }));
  const failed = await selection.ensure();
  const recoveryFile = join(dir, "recovery.json");
  const createRecovery = (timeout?: number) =>
    new QuotaRecovery(store, selection, new FileAccountStorageBackend(recoveryFile), timeout);
  return { store, selection, failed, createRecovery, recoveryFile };
}

test("reading a missing recovery token creates no runtime file or directory", async () =>
  fixture(async (h) => {
    const path = join(h.recoveryFile, "missing", "recovery.json");
    const recovery = new QuotaRecovery(h.store, h.selection, new FileAccountStorageBackend(path));
    assert.equal(await recovery.retryToken(h.failed), undefined);
    assert.equal(existsSync(h.recoveryFile), false);
  }));

test("one representative probes once; simultaneous and late failures share its result", async () =>
  fixture(async (h) => {
    const started = deferred<void>();
    const release = deferred<"pong">();
    let probes = 0;
    const probe = async () => {
      probes++;
      started.resolve();
      return release.promise;
    };
    const signal = new AbortController().signal;
    const leader = h.createRecovery().recover(h.failed, probe, signal);
    await started.promise;
    const waiter = h.createRecovery().recover(h.failed, probe, signal);
    assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    release.resolve("pong");
    const [a, b] = await Promise.all([leader, waiter]);
    assert.deepEqual(a, b);
    assert.equal(a.status, "ready");
    assert.equal(probes, 1);
    assert.deepEqual(await h.createRecovery().recover(h.failed, probe, signal), a);
    assert.equal(probes, 1);
    if (a.status === "ready") assert.equal((await h.selection.ensure()).revision, a.revision);
  }));

test("the failed account is excluded and each candidate is attempted once without inferring a reset time", async () =>
  fixture(async (h) => {
    const attempted: string[] = [];
    const result = await h.createRecovery().recover(
      h.failed,
      async (name) => {
        attempted.push(name);
        return "quota";
      },
      new AbortController().signal,
    );
    assert.equal(result.status, "stopped");
    assert.deepEqual([...attempted].sort(), ["first", "second"]);
    assert.equal(new Set(attempted).size, attempted.length);
    assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    assert.match(result.status === "stopped" ? result.message : "", /Send a new request to retry/);
    assert.doesNotMatch(JSON.stringify(result), /eligible at|hours|retryAt/);
  }));

test("non-quota probe failures stop without trying more candidates", async () =>
  fixture(async (h) => {
    let probes = 0;
    const result = await h.createRecovery().recover(
      h.failed,
      async () => {
        probes++;
        throw new Error("auth or malformed pong");
      },
      new AbortController().signal,
    );
    assert.equal(result.status, "stopped");
    assert.equal(probes, 1);
  }));

for (const reason of ["credential", "authentication"] as const) {
  test(`a candidate's ${reason} failure does not prevent trying the remaining accounts`, async () =>
    fixture(async (h) => {
      const attempted: string[] = [];
      const signal = new AbortController().signal;
      const probe = async (name: string) => {
        attempted.push(name);
        if (name === "first") throw new QuotaRecoveryError(reason);
        return "pong" as const;
      };
      const ready = await h.createRecovery().recover(h.failed, probe, signal);
      assert.equal(ready.status, "ready");
      assert.deepEqual(attempted, ["first", "second"]);
      assert.equal((await h.selection.ensure()).account, "second");
      if (ready.status !== "ready") return;
      const stopped = await h
        .createRecovery()
        .recover(await h.selection.ensure(), probe, signal, undefined, ready.round);
      assert.equal(stopped.status, "stopped");
      assert.deepEqual(attempted, ["first", "second"]);
    }));

  test(`all candidates with ${reason} failures finish one sweep and late failures do not probe again`, async () =>
    fixture(async (h) => {
      const attempted: string[] = [];
      const signal = new AbortController().signal;
      const probe = async (name: string) => {
        attempted.push(name);
        throw new QuotaRecoveryError(reason);
      };
      const recovery = h.createRecovery();
      const stopped = await recovery.recover(h.failed, probe, signal);
      assert.equal(stopped.status, "stopped");
      assert.deepEqual(attempted, ["first", "second"]);
      assert.deepEqual(await h.createRecovery().recover(h.failed, probe, signal), stopped);
      assert.deepEqual(attempted, ["first", "second"]);
      const token = await recovery.retryToken(h.failed, signal);
      assert.ok(token);
      assert.equal((await recovery.recover(h.failed, async () => "pong", signal, token)).status, "ready");
    }));

  test(`a candidate's ${reason} failure cannot swallow cancellation`, async () =>
    fixture(async (h) => {
      const attempted: string[] = [];
      const controller = new AbortController();
      const stopped = await h.createRecovery().recover(
        h.failed,
        async (name) => {
          attempted.push(name);
          controller.abort();
          throw new QuotaRecoveryError(reason);
        },
        controller.signal,
      );
      assert.equal(stopped.status, "stopped");
      assert.deepEqual(attempted, ["first"]);
      assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    }));
}

for (const reason of ["modules", "initialization", "transport", "provider", "reply"] as const) {
  test(`safe ${reason} failure is published to late waiters without another probe`, async () =>
    fixture(async (h) => {
      let probes = 0;
      const failure = new QuotaRecoveryError(reason);
      const probe = async () => {
        probes++;
        throw failure;
      };
      const signal = new AbortController().signal;
      const result = await h.createRecovery().recover(h.failed, probe, signal);
      assert.deepEqual(result, { status: "stopped", message: failure.message });
      assert.deepEqual(await h.createRecovery().recover(h.failed, probe, signal), result);
      assert.equal(probes, 1);
      assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    }));
}

test("unexpected probe exceptions cannot leak credentials or terminal controls into shared results", async () =>
  fixture(async (h) => {
    const result = await h.createRecovery().recover(
      h.failed,
      async () => {
        throw new Error("Bearer access-secret rt.refresh-secret \u001b[31m private-response");
      },
      new AbortController().signal,
    );
    assert.equal(result.status, "stopped");
    assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret|private-response|31m/);
    assert.doesNotMatch(await readFile(h.recoveryFile, "utf8"), /access-secret|refresh-secret|private-response|31m/);
  }));

test("newer manual selection wins over an in-flight successful probe", async () =>
  fixture(async (h) => {
    const started = deferred<void>();
    const release = deferred<"pong">();
    const task = h.createRecovery().recover(
      h.failed,
      async () => {
        started.resolve();
        return release.promise;
      },
      new AbortController().signal,
    );
    await started.promise;
    const manual = await h.selection.select(null);
    release.resolve("pong");
    assert.equal((await task).status, "stopped");
    assert.deepEqual(await h.selection.ensure(), manual);
  }));

test("cancellation is published to waiters and the candidate sees abort", async () =>
  fixture(async (h) => {
    const started = deferred<void>();
    const controller = new AbortController();
    let aborted = false;
    const task = h.createRecovery().recover(
      h.failed,
      async (_name, _credential, signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return "pong";
      },
      controller.signal,
    );
    await started.promise;
    const waiter = h.createRecovery().recover(
      h.failed,
      async () => {
        throw new Error("must not probe");
      },
      new AbortController().signal,
    );
    controller.abort();
    assert.equal((await task).status, "stopped");
    assert.equal((await waiter).status, "stopped");
    assert.equal(aborted, true);
  }));

test("a verified replacement revision can initiate a later recovery round", async () =>
  fixture(async (h) => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return "pong" as const;
    };
    const signal = new AbortController().signal;
    assert.equal((await h.createRecovery().recover(h.failed, probe, signal)).status, "ready");
    const replacement = await h.selection.ensure();
    assert.ok(replacement.account);
    assert.equal((await h.createRecovery().recover(replacement, probe, signal)).status, "ready");
    assert.equal(probes, 2);
  }));

test("real quota failures resume the same sweep and concurrent continuations share the remaining candidates", async () =>
  fixture(async (h) => {
    const attempted: string[] = [];
    const signal = new AbortController().signal;
    const probe = async (name: string) => {
      attempted.push(name);
      return "pong" as const;
    };
    const first = await h.createRecovery().recover(h.failed, probe, signal);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    assert.equal(first.round, h.failed.revision);
    const replacement = await h.selection.ensure();
    const started = deferred<void>();
    const release = deferred<"pong">();
    const nextProbe = async (name: string) => {
      attempted.push(name);
      started.resolve();
      return release.promise;
    };
    const leader = h.createRecovery().recover(replacement, nextProbe, signal, undefined, first.round);
    await started.promise;
    const waiter = h.createRecovery().recover(replacement, nextProbe, signal, undefined, first.round);
    const fresh = h.createRecovery().recover(replacement, nextProbe, signal);
    release.resolve("pong");
    const [second, shared, joined] = await Promise.all([leader, waiter, fresh]);
    assert.equal(second.status, "ready");
    assert.deepEqual(shared, second);
    assert.deepEqual(joined, second);
    if (second.status !== "ready") return;
    assert.equal(second.round, first.round);
    const stopped = await h
      .createRecovery()
      .recover(await h.selection.ensure(), probe, signal, undefined, second.round);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(attempted, ["first", "second"]);
    assert.deepEqual(
      await h.createRecovery().recover(await h.selection.ensure(), probe, signal, undefined, second.round),
      stopped,
    );
    assert.deepEqual(attempted, ["first", "second"]);
  }));

test("a delayed waiter follows the same sweep across verified replacements", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    const started = deferred<void>();
    const release = deferred<"pong">();
    const attempted: string[] = [];
    const leader = h.createRecovery().recover(
      h.failed,
      async (name) => {
        attempted.push(name);
        started.resolve();
        return release.promise;
      },
      signal,
    );
    await started.promise;
    const waiterStarted = deferred<void>();
    const releaseWaiter = deferred<void>();
    const backend = new FileAccountStorageBackend(h.recoveryFile);
    const read = backend.readAsync.bind(backend);
    backend.readAsync = async (reader, operation) => {
      waiterStarted.resolve();
      await releaseWaiter.promise;
      return read(reader, operation);
    };
    const waiter = new QuotaRecovery(h.store, h.selection, backend).recover(
      h.failed,
      async () => {
        throw new Error("Waiters must not probe");
      },
      signal,
    );
    await waiterStarted.promise;
    release.resolve("pong");
    const first = await leader;
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    const second = await h.createRecovery().recover(
      await h.selection.ensure(),
      async (name) => {
        attempted.push(name);
        return "pong";
      },
      signal,
      undefined,
      first.round,
    );
    assert.equal(second.status, "ready");
    releaseWaiter.resolve();
    assert.deepEqual(await waiter, second);
    assert.deepEqual(attempted, ["first", "second"]);
  }));

test("a competing fresh sweep supersedes an older continuation without borrowing its candidates", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    const ready = await h.createRecovery().recover(h.failed, async () => "pong", signal);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") return;
    const replacement = await h.selection.ensure();
    const started = deferred<void>();
    const release = deferred<"pong">();
    const fresh = h.createRecovery().recover(
      replacement,
      async (name) => {
        assert.equal(name, "failed");
        started.resolve();
        return release.promise;
      },
      signal,
    );
    await started.promise;
    const superseded = await h.createRecovery().recover(
      replacement,
      async () => {
        throw new Error("A competing continuation must not probe");
      },
      signal,
      undefined,
      ready.round,
    );
    assert.equal(superseded.status, "stopped");
    release.resolve("pong");
    const result = await fresh;
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.round, replacement.revision);
  }));

test("quota probes consume candidates too and accounts added mid-sweep do not extend it", async () =>
  fixture(async (h) => {
    const attempted: string[] = [];
    const signal = new AbortController().signal;
    const probe = async (name: string) => {
      attempted.push(name);
      return name === "first" ? ("quota" as const) : ("pong" as const);
    };
    const ready = await h.createRecovery().recover(h.failed, probe, signal);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") return;
    await h.store.updateProvider("openai", (state) => ({
      ...state,
      accounts: { ...state.accounts, later: credential("later") },
    }));
    const stopped = await h.createRecovery().recover(await h.selection.ensure(), probe, signal, undefined, ready.round);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(attempted, ["first", "second"]);
    // A separate request has no exclusion inherited from the completed sweep.
    const fresh = await h.createRecovery().recover(await h.selection.ensure(), probe, signal);
    assert.equal(fresh.status, "ready");
    assert.deepEqual(attempted, ["first", "second", "failed"]);
  }));

test("removed remaining candidates are skipped without repeating earlier probes", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    const attempted: string[] = [];
    const probe = async (name: string) => {
      attempted.push(name);
      return "pong" as const;
    };
    const ready = await h.createRecovery().recover(h.failed, probe, signal);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") return;
    await h.store.updateProvider("openai", (state) => {
      delete state.accounts.second;
      return state;
    });
    assert.equal(
      (await h.createRecovery().recover(await h.selection.ensure(), probe, signal, undefined, ready.round)).status,
      "stopped",
    );
    assert.deepEqual(attempted, ["first"]);
  }));

test("a manual selection invalidates a continuation instead of starting another sweep", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    const ready = await h.createRecovery().recover(h.failed, async () => "pong", signal);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") return;
    const manual = await h.selection.select("second");
    assert.ok(manual);
    const stopped = await h.createRecovery().recover(
      manual,
      async () => {
        throw new Error("A superseded sweep must not probe");
      },
      signal,
      undefined,
      ready.round,
    );
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(await h.selection.ensure(), manual);
  }));

test("a replaced credential prevents publication of a stale successful probe", async () =>
  fixture(async (h) => {
    const started = deferred<string>();
    const release = deferred<"pong">();
    const task = h.createRecovery().recover(
      h.failed,
      async (name) => {
        started.resolve(name);
        return release.promise;
      },
      new AbortController().signal,
    );
    const candidate = await started.promise;
    await h.store.updateProvider("openai", (state) => ({
      ...state,
      accounts: { ...state.accounts, [candidate]: credential("replacement") },
    }));
    release.resolve("pong");
    assert.equal((await task).status, "stopped");
    assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    assert.equal((await h.store.readProviderAsync("openai")).accounts[candidate]?.piAccountsGeneration, "replacement");
  }));

test("a fresh native request can restart a stopped round immediately; concurrent and late failures still coalesce", async () =>
  fixture(async (h) => {
    const recovery = h.createRecovery();
    const signal = new AbortController().signal;
    assert.equal(await recovery.retryToken(h.failed, signal), undefined);
    const attempted: string[] = [];
    const quota = async (name: string) => {
      attempted.push(name);
      return "quota" as const;
    };
    const first = await recovery.recover(h.failed, quota, signal);
    assert.equal(first.status, "stopped");
    const token = await recovery.retryToken(h.failed, signal);
    assert.ok(token);
    assert.deepEqual(await recovery.recover(h.failed, quota, signal), first);
    assert.equal(attempted.length, 2);

    const started = deferred<void>();
    const release = deferred<"quota">();
    const probe = async (name: string) => {
      attempted.push(name);
      started.resolve();
      return release.promise;
    };
    const leader = recovery.recover(h.failed, probe, signal, token);
    await started.promise;
    // Capturing during an active round never authorizes restarting it afterward.
    assert.equal(await h.createRecovery().retryToken(h.failed, signal), undefined);
    const waiter = h.createRecovery().recover(h.failed, probe, signal, token);
    release.resolve("quota");
    const results = await Promise.all([leader, waiter]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(attempted.length, 4);
    assert.deepEqual(attempted.slice(2).sort(), ["first", "second"]);
    const nextToken = await recovery.retryToken(h.failed, signal);
    assert.ok(nextToken);
    assert.notEqual(nextToken, token);
    assert.deepEqual(await recovery.recover(h.failed, quota, signal, token), results[0]);
    assert.equal(attempted.length, 4);

    const success = await recovery.recover(h.failed, async () => "pong", signal, nextToken);
    assert.equal(success.status, "ready");
    assert.notEqual((await h.selection.ensure()).account, "failed");
  }));

test("a delayed waiter stops safely when a fresh request has already replaced its completed round", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<"quota">();
    const leader = h.createRecovery().recover(
      h.failed,
      async () => {
        probeStarted.resolve();
        return releaseProbe.promise;
      },
      signal,
    );
    await probeStarted.promise;
    const waiterStarted = deferred<void>();
    const releaseWaiter = deferred<void>();
    const backend = new FileAccountStorageBackend(h.recoveryFile);
    const read = backend.readAsync.bind(backend);
    backend.readAsync = async (reader, operation) => {
      waiterStarted.resolve();
      await releaseWaiter.promise;
      return read(reader, operation);
    };
    const waiter = new QuotaRecovery(h.store, h.selection, backend).recover(
      h.failed,
      async () => {
        throw new Error("Waiters must not probe");
      },
      signal,
    );
    await waiterStarted.promise;
    releaseProbe.resolve("quota");
    assert.equal((await leader).status, "stopped");
    const recovery = h.createRecovery();
    const token = await recovery.retryToken(h.failed, signal);
    const ready = await recovery.recover(h.failed, async () => "pong", signal, token);
    assert.equal(ready.status, "ready");
    releaseWaiter.resolve();
    const stale = await waiter;
    assert.equal(stale.status, "stopped");
    assert.match(stale.status === "stopped" ? stale.message : "", /superseded/);
  }));

test("old stopped records do not impose a waiting period and unknown recovery fields survive a new election", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    await writeFile(
      h.recoveryFile,
      JSON.stringify({
        version: 2,
        future: { keep: true },
        rounds: {
          [h.failed.revision]: {
            owner: "old-runtime",
            revision: h.failed.revision,
            remaining: [],
            startedAt: Date.now(),
            deadline: Date.now(),
            result: { status: "stopped", message: "Old five-hour result" },
          },
        },
      }),
    );
    const recovery = h.createRecovery();
    const token = await recovery.retryToken(h.failed, signal);
    assert.equal(token, "old-runtime");
    const result = await recovery.recover(h.failed, async () => "pong", signal, token);
    assert.equal(result.status, "ready");
    assert.deepEqual(JSON.parse(await readFile(h.recoveryFile, "utf8")).future, { keep: true });
  }));

test("obsolete recovery state is discarded without inheriting an earlier sweep or cooldown", async () =>
  fixture(async (h) => {
    await writeFile(
      h.recoveryFile,
      JSON.stringify({
        version: 1,
        rounds: { [h.failed.revision]: { result: { status: "stopped", message: "obsolete" } } },
      }),
    );
    const recovery = h.createRecovery();
    assert.equal(await recovery.retryToken(h.failed), undefined);
    assert.equal((await recovery.recover(h.failed, async () => "pong", new AbortController().signal)).status, "ready");
    assert.equal(JSON.parse(await readFile(h.recoveryFile, "utf8")).version, 2);
  }));

test.each(["{", "[]", '{"version":3,"rounds":{}}', '{"version":2,"rounds":{"invalid":1}}'])(
  "invalid recovery files are not overwritten: %s",
  async (raw) =>
    fixture(async (h) => {
      await writeFile(h.recoveryFile, raw);
      const recovery = h.createRecovery();
      const signal = new AbortController().signal;
      await assert.rejects(recovery.retryToken(h.failed, signal));
      await assert.rejects(recovery.recover(h.failed, async () => "pong", signal));
      assert.equal(await readFile(h.recoveryFile, "utf8"), raw);
    }),
);
