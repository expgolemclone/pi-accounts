import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type ProviderStreams } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { AccountStore } from "../src/account-store.js";
import accountsExtension, { type AccountsDependencies } from "../src/accounts.js";
import type { AccountProviderAdapter } from "../src/oauth.js";
import { OPENAI_QUOTA_MESSAGE } from "../src/quota-errors.js";
import { QuotaRecovery } from "../src/quota-recovery.js";
import { OpenAISelection } from "../src/shared-selection.js";
import { FileAccountStorageBackend } from "../src/storage.js";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";

isolateAccountEnvironment();
function completed(text: string) {
  const item = {
    type: "message",
    id: "offline-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "offline-response" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "offline-response", status: "completed", output: [item] } },
  ];
  return streamed(events);
}
function streamed(events: Array<{ type: string; [key: string]: unknown }>) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
function toolCall() {
  const item = {
    type: "function_call",
    id: "fc-offline",
    call_id: "call-offline",
    name: "switch_fixture",
    arguments: "{}",
    status: "completed",
  };
  return streamed([
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item] } },
  ]);
}
const provider: AccountProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",
  requiresApiKeyBridge: false,
  supportsApiKey: true,
  runtimeAuthMode: "api-key",
  oauth: {
    login: async () => {
      throw new Error("No login in offline fixture");
    },
    refresh: async (credential) => ({
      ...credential,
      access: `${credential.access}-refreshed`,
      expires: Date.now() + 3_600_000,
    }),
    toAuth: async (credential) => ({ apiKey: credential.access }),
  },
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(
  fetch: typeof globalThis.fetch,
  probe: AccountsDependencies["probe"],
  extra?: (pi: ExtensionAPI, selection: OpenAISelection) => void,
  names: readonly string[] = ["a", "b"],
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  const directory = await mkdtemp(join(tmpdir(), "accounts-shared-runtime-"));
  const store = new AccountStore(new FileAccountStorageBackend(join(directory, "accounts.json")));
  const selection = new OpenAISelection(store);
  await store.updateProvider("openai", () => ({
    active: "a",
    accounts: Object.fromEntries(
      names.map((name) => [
        name,
        {
          type: "oauth",
          access: `offline-${name}`,
          refresh: `refresh-${name}`,
          expires: Date.now() + 3_600_000,
        },
      ]),
    ),
  }));
  const eventBus = createEventBus();
  const settings = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
  });
  const moduleId = "@earendil-works/pi-ai/api/openai-responses";
  const native = (await import(moduleId)) as ProviderStreams;
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    eventBus,
    extensionFactories: [
      (pi) => {
        pi.registerProvider("openai", {
          api: "openai-responses",
          streamSimple: (model, context, options) =>
            native.streamSimple(model, context, { ...options, fetch: options?.fetch ?? fetch }),
        });
        accountsExtension(pi, {
          store,
          recoveryBackend: new FileAccountStorageBackend(join(directory, "recovery.json")),
          providers: [provider],
          probe,
        });
        extra?.(pi, selection);
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = runtime.getModel("openai", "gpt-4o");
  assert.ok(model);
  const manager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    tools: extra ? ["switch_fixture"] : [],
    noTools: extra ? undefined : "all",
  });
  const errors: unknown[] = [];
  await session.bindExtensions({
    onError: (error) => {
      errors.push(error);
    },
  });
  const pending: Promise<unknown>[] = [];
  eventBus.emit("oauth:credential-readiness:v1", {
    session: manager,
    provider: "openai",
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
  return {
    store,
    directory,
    selection,
    session,
    manager,
    runtime,
    errors,
    cleanup: async () => {
      session.dispose();
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function use(h: Fixture, run: (h: Fixture) => Promise<void>) {
  try {
    await run(h);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.cleanup();
  }
}

test("exact message-only quota recovers once and sends literal continue through the real actionable boundary", async () => {
  const keys: string[] = [];
  const inputs: string[] = [];
  let probes = 0;
  const h = await fixture(
    async (input, init) => {
      const request = new Request(input, init);
      const key = request.headers.get("authorization");
      assert.ok(key);
      keys.push(key);
      inputs.push(await request.text());
      if (key === "Bearer offline-a")
        return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      return completed("recovered");
    },
    async () => {
      probes++;
      return "pong";
    },
  );
  await use(h, async ({ session, manager, selection }) => {
    await session.prompt("original offline request");
    assert.equal(probes, 1);
    assert.deepEqual(keys, ["Bearer offline-a", "Bearer offline-b"]);
    assert.equal((await selection.ensure()).account, "b");
    const continuations = manager
      .getEntries()
      .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue");
    assert.equal(continuations.length, 1);
    assert.ok(continuations[0]?.type === "custom_message");
    assert.equal(continuations[0].content, "continue");
    assert.match(inputs[1] ?? "", /continue/);
    assert.equal(session.getLastAssistantText(), "recovered");
    assert.equal(session.isIdle, true);
  });
});

test("manual shared switch is adopted by a nested request without reload or another user turn", async () => {
  const keys: string[] = [];
  const h = await fixture(
    async (input, init) => {
      keys.push(new Request(input, init).headers.get("authorization") ?? "");
      return completed("ok");
    },
    async () => {
      throw new Error("No quota probes expected");
    },
  );
  await use(h, async ({ session, selection, runtime }) => {
    await session.prompt("first");
    await selection.select("b");
    const model = runtime.getModel("openai", "gpt-4o");
    assert.ok(model);
    const result = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "nested", timestamp: 0 }],
    });
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(keys, ["Bearer offline-a", "Bearer offline-b"]);
  });
});

test("tool continuation adopts a shared manual switch and preserves the completed tool result", async () => {
  const keys: string[] = [];
  const inputs: string[] = [];
  const h = await fixture(
    async (input, init) => {
      const request = new Request(input, init);
      keys.push(request.headers.get("authorization") ?? "");
      inputs.push(await request.text());
      if (keys.length > 1) return completed("tool result preserved");
      return toolCall();
    },
    async () => {
      throw new Error("No quota expected");
    },
    (pi, selection) => {
      pi.registerTool({
        name: "switch_fixture",
        label: "Switch fixture",
        description: "Offline fixture",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          await selection.select("b");
          return { content: [{ type: "text", text: "COMPLETED_TOOL_RESULT" }], details: {} };
        },
      });
    },
  );
  await use(h, async ({ session }) => {
    await session.prompt("call the fixture");
    assert.deepEqual(keys, ["Bearer offline-a", "Bearer offline-b"]);
    assert.match(inputs[1] ?? "", /COMPLETED_TOOL_RESULT/);
    assert.equal(session.getLastAssistantText(), "tool result preserved");
  });
});

test("native manual compaction reconciles the shared identity without reload", async () => {
  const keys: string[] = [];
  const h = await fixture(
    async (input, init) => {
      keys.push(new Request(input, init).headers.get("authorization") ?? "");
      return completed("offline summary");
    },
    async () => {
      throw new Error("No quota expected");
    },
  );
  await use(h, async ({ session, selection }) => {
    await session.prompt("first offline turn");
    await selection.select("b");
    const result = await session.compact();
    assert.match(result.summary, /offline summary$/);
    assert.deepEqual(keys, ["Bearer offline-a", "Bearer offline-b"]);
  });
});

test.each([{ names: ["a", "b"] }, { names: ["a", "b", "c"] }])(
  "quota during overflow compaction uses one sweep without a false successful compaction: $names",
  async ({ names }) => {
    const keys: string[] = [];
    let probes = 0;
    const h = await fixture(
      async (input, init) => {
        keys.push(new Request(input, init).headers.get("authorization") ?? "");
        if (keys.length === 2)
          return new Response(JSON.stringify({ error: { message: "maximum context length exceeded" } }), {
            status: 400,
          });
        if (keys.length >= 3 && keys.at(-1) !== `Bearer offline-${names.at(-1)}`)
          return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
        return completed("finished");
      },
      async () => {
        probes++;
        return "pong";
      },
      undefined,
      names,
    );
    await use(h, async ({ session, manager }) => {
      await session.prompt("seed context");
      session.setAutoCompactionEnabled(true);
      await session.prompt("trigger offline overflow");
      assert.equal(probes, names.length - 1);
      assert.deepEqual(keys, [
        "Bearer offline-a",
        "Bearer offline-a",
        ...names.map((name) => `Bearer offline-${name}`),
      ]);
      assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
      assert.equal(
        manager
          .getEntries()
          .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length,
        names.length - 1,
      );
      assert.equal(session.getLastAssistantText(), "finished");
    });
  },
);

test("new user work cancels pending verification and cannot inherit an automatic continue", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let probes = 0;
  let requests = 0;
  const h = await fixture(
    async () => {
      requests++;
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async (_store, _adapter, _ctx, _model, _name, _credential, signal) => {
      if (++probes > 1) return "quota";
      entered();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "pong";
    },
  );
  await use(h, async ({ session, manager, selection }) => {
    const original = session.prompt("original");
    await started;
    await session.prompt("unrelated new work", { streamingBehavior: "followUp" });
    await original;
    assert.equal(probes, 2);
    assert.equal(requests, 2);
    assert.equal((await selection.ensure()).account, "a");
    assert.equal(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length,
      0,
    );
  });
});

test("an unconfigured explicit built-in login does not prevent adopting a later shared saved account", async () => {
  const keys: string[] = [];
  const h = await fixture(
    async (input, init) => {
      keys.push(new Request(input, init).headers.get("authorization") ?? "");
      return completed("adopted");
    },
    async () => {
      throw new Error("No quota expected");
    },
  );
  await use(h, async ({ selection, runtime, session }) => {
    const model = runtime.getModel("openai", "gpt-4o");
    assert.ok(model);
    await selection.select(null);
    const unavailable = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "no login", timestamp: 0 }],
    });
    assert.equal(unavailable.stopReason, "error");
    assert.deepEqual(keys, []);
    await selection.select("b");
    await session.prompt("adopt later selection");
    assert.deepEqual(keys, ["Bearer offline-b"]);
    assert.equal(session.getLastAssistantText(), "adopted");
  });
});

test("contradictory SSE codes cannot enter recovery even when the SDK strips the code", async () => {
  let probes = 0;
  const h = await fixture(
    async () =>
      new Response(
        `event: error\ndata: ${JSON.stringify({ type: "error", code: "invalid_api_key", message: OPENAI_QUOTA_MESSAGE })}\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
    async () => {
      probes++;
      return "pong";
    },
  );
  await use(h, async ({ session }) => {
    await session.prompt("conflicting native code");
    assert.equal(probes, 0);
  });
});

test("an idle nested quota call may recover the selection but never submits unsolicited continue", async () => {
  let probes = 0;
  const h = await fixture(
    async () => new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 }),
    async () => {
      probes++;
      return "pong";
    },
  );
  await use(h, async ({ runtime, selection, manager }) => {
    const model = runtime.getModel("openai", "gpt-4o");
    assert.ok(model);
    const result = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "nested", timestamp: 0 }],
    });
    assert.equal(result.stopReason, "error");
    assert.equal(probes, 1);
    assert.equal((await selection.ensure()).account, "b");
    assert.equal(manager.getEntries().filter((entry) => entry.type === "custom_message").length, 0);
  });
});

test("unrelated native errors retain normal Pi retries and never create cooldown or probe", async () => {
  let calls = 0;
  let probes = 0;
  const h = await fixture(
    async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "server unavailable" } }), { status: 503 });
    },
    async () => {
      probes++;
      return "pong";
    },
  );
  await use(h, async ({ session }) => {
    await session.prompt("transient error fixture");
    assert.equal(calls, 3);
    assert.equal(probes, 0);
  });
});

test("Escape during verification cancels the probe and never publishes or queues continue", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let requests = 0;
  const h = await fixture(
    async () => {
      requests++;
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async (_store, _adapter, _ctx, _model, _name, _credential, signal) => {
      entered();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "pong";
    },
  );
  await use(h, async ({ session, manager, selection }) => {
    const run = session.prompt("cancel verification");
    await started;
    await session.abort();
    await run;
    assert.equal(requests, 1);
    assert.equal((await selection.ensure()).account, "a");
    assert.equal(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length,
      0,
    );
  });
});

test.each([
  JSON.stringify({ version: 1, accounts: { a: { generation: "old", revision: "old", retryAt: 9_000_000_000_000 } } }),
  "malformed legacy cooldown data",
])("legacy cooldown records never veto a manual retry and remain untouched: %s", async (legacy) => {
  const keys: string[] = [];
  let available = false;
  let probes = 0;
  const h = await fixture(
    async (input, init) => {
      const key = new Request(input, init).headers.get("authorization") ?? "";
      keys.push(key);
      if (key === "Bearer offline-a" && !available)
        return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
      return completed("available");
    },
    async () => {
      probes++;
      return "pong";
    },
  );
  await use(h, async ({ session, selection, directory, store }) => {
    const state = await store.readProviderAsync("openai");
    const raw = legacy.startsWith("{")
      ? legacy.replace('"generation":"old"', `"generation":${JSON.stringify(state.accounts.a?.piAccountsGeneration)}`)
      : legacy;
    const legacyDirectory = join(directory, "extensions", "accounts");
    await mkdir(legacyDirectory, { recursive: true });
    const path = join(legacyDirectory, "cooldowns.json");
    await writeFile(path, raw);
    await session.prompt("original request");
    assert.equal((await selection.ensure()).account, "b");
    available = true;
    await selection.select("a");
    await session.prompt("manual retry");
    assert.deepEqual(keys, ["Bearer offline-a", "Bearer offline-b", "Bearer offline-a"]);
    assert.equal(probes, 1);
    assert.equal(session.getLastAssistantText(), "available");
    assert.equal(await readFile(path, "utf8"), raw);
  });
});

test("new input retries a stopped recovery immediately without reload or account switching", async () => {
  let probes = 0;
  let requests = 0;
  let quota = true;
  const h = await fixture(
    async (input, init) => {
      requests++;
      const key = new Request(input, init).headers.get("authorization");
      if (!quota && key === "Bearer offline-b") return completed("recovered on explicit retry");
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async () => {
      probes++;
      return quota ? "quota" : "pong";
    },
  );
  await use(h, async ({ session, selection, manager }) => {
    await session.prompt("first request");
    assert.equal(probes, 1);
    assert.equal(requests, 1);
    assert.equal((await selection.ensure()).account, "a");
    quota = false;
    await session.prompt("continue");
    assert.equal(probes, 2);
    assert.equal(requests, 3);
    assert.equal((await selection.ensure()).account, "b");
    assert.equal(session.getLastAssistantText(), "recovered on explicit retry");
    assert.equal(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length,
      1,
    );
  });
});

test.each([
  {
    name: "all real requests limited",
    available: undefined,
    limitedProbe: undefined,
    requests: ["a", "b", "c"],
    continues: 2,
  },
  {
    name: "last real request succeeds",
    available: "c",
    limitedProbe: undefined,
    requests: ["a", "b", "c"],
    continues: 2,
  },
  { name: "limited probe is consumed", available: "c", limitedProbe: "b", requests: ["a", "c"], continues: 1 },
])("one three-account sweep: $name", async ({ available, limitedProbe, requests: expected, continues }) => {
  const requests: string[] = [];
  const probes: string[] = [];
  const h = await fixture(
    async (input, init) => {
      const name = new Request(input, init).headers.get("authorization")?.replace("Bearer offline-", "") ?? "";
      requests.push(name);
      if (name === available) return completed("recovered");
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async (_store, _adapter, _ctx, _model, name) => {
      probes.push(name);
      return name === limitedProbe ? "quota" : "pong";
    },
    undefined,
    ["a", "b", "c"],
  );
  await use(h, async ({ session, manager }) => {
    await session.prompt("try every account once");
    assert.deepEqual(requests, expected);
    assert.deepEqual(probes, ["b", "c"]);
    assert.equal(session.isIdle, true);
    assert.equal(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length,
      continues,
    );
    if (available) {
      assert.equal(session.getLastAssistantText(), "recovered");
    } else {
      await session.prompt("explicit new sweep");
      assert.deepEqual(requests, ["a", "b", "c", "c", "a", "b"]);
      assert.deepEqual(probes, ["b", "c", "a", "b"]);
    }
  });
});

test.each([false, true])(
  "a lagging session adopts the same sweep after another representative advances it; success=%s",
  async (succeeds) => {
    const requests: string[] = [];
    const probes: string[] = [];
    let advanced = false;
    const h = await fixture(
      async (input, init) => {
        const name = new Request(input, init).headers.get("authorization")?.replace("Bearer offline-", "") ?? "";
        requests.push(name);
        if (succeeds && requests.length === 2) return toolCall();
        if (succeeds && requests.length === 4) return completed("fresh sweep recovered");
        return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
      },
      async (_store, _adapter, _ctx, _model, name) => {
        probes.push(name);
        return "pong";
      },
      (pi) => {
        pi.registerTool({
          name: "switch_fixture",
          label: "Fixture",
          description: "Offline fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "COMPLETED_TOOL_RESULT" }], details: {} }),
        });
        pi.on("agent_before_settle", async (event, ctx) => {
          const entry = event.entries.find(
            (item) => item.type === "custom_message" && item.customType === "accounts:quota-continue",
          );
          if (advanced || entry?.type !== "custom_message") return;
          advanced = true;
          const { failedRevision } = entry.details as { failedRevision: string };
          // Another process exhausts B while this session is about to continue on it.
          const recovery = new QuotaRecovery(
            h.store,
            h.selection,
            new FileAccountStorageBackend(join(h.directory, "recovery.json")),
          );
          const ready = await recovery.recover(
            await h.selection.ensure(),
            async (name) => {
              probes.push(name);
              return "pong";
            },
            ctx.signal ?? new AbortController().signal,
            undefined,
            failedRevision,
          );
          assert.equal(ready.status, "ready");
        });
      },
      ["a", "b", "c"],
    );
    await use(h, async ({ session }) => {
      await session.prompt("adopt the shared continuation without restarting the sweep");
      assert.deepEqual(requests, succeeds ? ["a", "c", "c", "a"] : ["a", "c"]);
      assert.deepEqual(probes, succeeds ? ["b", "c", "a"] : ["b", "c"]);
      assert.equal(session.isIdle, true);
      if (succeeds) assert.equal(session.getLastAssistantText(), "fresh sweep recovered");
    });
  },
);

test("a successful real tool response ends the sweep before another quota in the same user run", async () => {
  const requests: string[] = [];
  const inputs: string[] = [];
  const probes: string[] = [];
  const h = await fixture(
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.headers.get("authorization") ?? "");
      inputs.push(await request.text());
      if (requests.length === 2) return toolCall();
      if (requests.length === 4) return completed("second sweep recovered");
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async (_store, _adapter, _ctx, _model, name) => {
      probes.push(name);
      return "pong";
    },
    (pi) => {
      pi.registerTool({
        name: "switch_fixture",
        label: "Fixture",
        description: "Offline fixture",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "COMPLETED_TOOL_RESULT" }], details: {} }),
      });
    },
    ["a", "b", "c"],
  );
  await use(h, async ({ session }) => {
    await session.prompt("finish both recoveries");
    assert.deepEqual(requests, ["Bearer offline-a", "Bearer offline-b", "Bearer offline-b", "Bearer offline-a"]);
    assert.deepEqual(probes, ["b", "a"]);
    assert.match(inputs[3] ?? "", /COMPLETED_TOOL_RESULT/);
    assert.equal(session.getLastAssistantText(), "second sweep recovered");
  });
});

test("an account used earlier in the session remains eligible for a later quota sweep", async () => {
  const requests: string[] = [];
  const probes: string[] = [];
  const h = await fixture(
    async (input, init) => {
      const key = new Request(input, init).headers.get("authorization") ?? "";
      requests.push(key);
      if (key === "Bearer offline-a") return completed("available");
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async (_store, _adapter, _ctx, _model, name) => {
      probes.push(name);
      return "pong";
    },
  );
  await use(h, async ({ session, selection }) => {
    await session.prompt("use a normally");
    await selection.select("b");
    await session.prompt("a is still eligible");
    assert.deepEqual(requests, ["Bearer offline-a", "Bearer offline-b", "Bearer offline-a"]);
    assert.deepEqual(probes, ["a"]);
    assert.equal(session.getLastAssistantText(), "available");
  });
});

test("a successful probe followed by real quota consumes the last account; new input starts a fresh sweep", async () => {
  let probes = 0;
  let requests = 0;
  const h = await fixture(
    async () => {
      requests++;
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async () => {
      probes++;
      return "pong";
    },
  );
  await use(h, async ({ session, manager }) => {
    await session.prompt("first run");
    assert.equal(probes, 1);
    assert.equal(requests, 2);
    assert.equal(session.isIdle, true);
    await session.prompt("explicit second run");
    assert.equal(probes, 2);
    assert.equal(requests, 4);
    assert.equal(session.isIdle, true);
    assert.equal(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length,
      2,
    );
  });
});

test("Escape during a later candidate stops the sweep and new input can reuse earlier accounts", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const requests: string[] = [];
  const probes: string[] = [];
  let retrying = false;
  const h = await fixture(
    async (input, init) => {
      const name = new Request(input, init).headers.get("authorization")?.replace("Bearer offline-", "") ?? "";
      requests.push(name);
      if (retrying && name === "a") return completed("recovered after cancellation");
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async (_store, _adapter, _ctx, _model, name, _credential, signal) => {
      probes.push(name);
      if (!retrying && name === "c") {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return "pong";
    },
    undefined,
    ["a", "b", "c"],
  );
  await use(h, async ({ session, selection }) => {
    const run = session.prompt("cancel the second candidate");
    await started;
    await session.abort();
    await run;
    assert.deepEqual(requests, ["a", "b"]);
    assert.deepEqual(probes, ["b", "c"]);
    assert.equal((await selection.ensure()).account, "b");
    retrying = true;
    await session.prompt("start a new sweep");
    assert.deepEqual(requests, ["a", "b", "b", "a"]);
    assert.deepEqual(probes, ["b", "c", "a"]);
    assert.equal(session.getLastAssistantText(), "recovered after cancellation");
  });
});

test("a settled non-quota failure discards the sweep before an independent idle request", async () => {
  const requests: string[] = [];
  const probes: string[] = [];
  let nextRequest = false;
  const h = await fixture(
    async (input, init) => {
      const name = new Request(input, init).headers.get("authorization")?.replace("Bearer offline-", "") ?? "";
      requests.push(name);
      if (name === "a" || nextRequest)
        return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
      return new Response(JSON.stringify({ error: { message: "server unavailable" } }), { status: 503 });
    },
    async (_store, _adapter, _ctx, _model, name) => {
      probes.push(name);
      return "pong";
    },
    undefined,
    ["a", "b", "c"],
  );
  await use(h, async ({ session, runtime, selection }) => {
    await session.prompt("quota then unrelated native failure");
    assert.deepEqual(requests, ["a", "b", "b", "b"]);
    assert.deepEqual(probes, ["b"]);
    assert.equal(session.isIdle, true);
    nextRequest = true;
    const model = runtime.getModel("openai", "gpt-4o");
    assert.ok(model);
    const result = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "independent idle request", timestamp: 0 }],
    });
    assert.equal(result.stopReason, "error");
    assert.deepEqual(probes, ["b", "a"]);
    assert.equal((await selection.ensure()).account, "a");
    assert.equal(session.isIdle, true);
  });
});

test("a single saved account can retry natively after quota without a cooldown or probe loop", async () => {
  let requests = 0;
  const h = await fixture(
    async () => {
      if (++requests === 1)
        return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
      return completed("available again");
    },
    async () => {
      throw new Error("No other account to probe");
    },
  );
  await use(h, async ({ session, store }) => {
    await store.updateProvider("openai", (state) => {
      assert.ok(state.accounts.a);
      return { ...state, accounts: { a: state.accounts.a } };
    });
    await session.prompt("limited request");
    assert.equal(requests, 1);
    await session.prompt("new request");
    assert.equal(requests, 2);
    assert.equal(session.getLastAssistantText(), "available again");
  });
});

test("a manual shared selection wins while the representative is verifying", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let requests = 0;
  const h = await fixture(
    async () => {
      requests++;
      return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
    },
    async (_store, _adapter, _ctx, _model, _name, _credential, signal) => {
      entered();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "pong";
    },
  );
  await use(h, async ({ session, manager, selection }) => {
    const run = session.prompt("manual selection during verification");
    await started;
    const manual = await selection.select("b");
    await run;
    assert.equal(requests, 1);
    assert.deepEqual(await selection.ensure(), manual);
    assert.equal(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length,
      0,
    );
  });
});
