import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InMemoryCredentialStore, InMemoryModelsStore, type ProviderStreams } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AccountStore } from "../../src/account-store.js";
import accountsExtension from "../../src/accounts.js";
import { OPENAI_QUOTA_MESSAGE } from "../../src/quota-errors.js";
import { FileAccountStorageBackend } from "../../src/storage.js";

const send = (message: unknown) => process.send?.(message);
let release!: () => void;
const released = new Promise<void>((resolve) => {
  release = resolve;
});
process.on("message", (message) => {
  if (message === "release") release();
});
process.once("message", async (directory: string) => {
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const store = new AccountStore(new FileAccountStorageBackend(join(directory, "accounts.json")));
    const settings = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      compaction: { enabled: false },
    });
    const manager = SessionManager.inMemory(directory);
    const events = createEventBus();
    const moduleId = "@earendil-works/pi-ai/api/openai-responses";
    const native = (await import(moduleId)) as ProviderStreams;
    const keys: string[] = [];
    globalThis.fetch = async (input, init) => {
      const key = new Request(input, init).headers.get("authorization") === "Bearer offline-a" ? "a" : "b";
      keys.push(key);
      send({ kind: "request", key });
      if (key === "a") {
        await released;
        return new Response(JSON.stringify({ error: { message: OPENAI_QUOTA_MESSAGE } }), { status: 429 });
      }
      const item = {
        type: "message",
        id: "offline",
        role: "assistant",
        content: [{ type: "output_text", text: "recovered", annotations: [] }],
      };
      const output = [
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { status: "completed", output: [item] } },
      ];
      return new Response(output.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      eventBus: events,
      extensionFactories: [
        (pi) => {
          pi.registerProvider("openai", { api: "openai-responses", streamSimple: native.streamSimple });
          accountsExtension(pi, {
            store,
            recoveryBackend: new FileAccountStorageBackend(join(directory, "recovery.json")),
            providers: [
              {
                id: "openai",
                displayName: "OpenAI",
                requiresApiKeyBridge: false,
                supportsApiKey: true,
                runtimeAuthMode: "api-key",
                oauth: {
                  login: async () => {
                    throw new Error("No login");
                  },
                  refresh: async (credential) => credential,
                  toAuth: async (credential) => ({ apiKey: credential.access }),
                },
              },
            ],
            probe: async () => {
              send({ kind: "probe" });
              await delay(50);
              return "pong";
            },
          });
        },
      ],
    });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error("Loader failed");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = runtime.getModel("openai", "gpt-4o");
    if (!model) throw new Error("Model unavailable");
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager: settings,
      tools: [],
      noTools: "all",
    }));
    await session.bindExtensions({
      onError: () => {
        throw new Error("Extension failed");
      },
    });
    const ready: Promise<unknown>[] = [];
    events.emit("oauth:credential-readiness:v1", {
      session: manager,
      provider: "openai",
      waitUntil: (promise: Promise<unknown>) => ready.push(promise),
    });
    await Promise.all(ready);
    send({ kind: "ready" });
    await new Promise<void>((resolve) =>
      process.on("message", (message) => {
        if (message === "run") resolve();
      }),
    );
    await session.prompt("offline original");
    const continuations = manager
      .getEntries()
      .filter((entry) => entry.type === "custom_message" && entry.customType === "accounts:quota-continue").length;
    send({ kind: "result", keys, continuations, text: session.getLastAssistantText() });
    session.dispose();
    session = undefined;
    process.disconnect?.();
  } catch {
    session?.dispose();
    process.send?.({ kind: "failed" }, () => process.disconnect?.());
  }
});
send({ kind: "boot" });
