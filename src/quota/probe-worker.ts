import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { captureQuotaEvidence, isOpenAIQuotaError } from "../quota-errors.js";
import type { QuotaFailureReason } from "../quota-failure.js";
import type { ProbeInput, ProbeReply } from "./probe-protocol.js";

export const workerModuleURL = import.meta.url;

// Only the owned child calls this entrypoint. Importing its URL in the parent has no side effects.
export function startProbeWorker(): void {
  process.once("message", async (input: ProbeInput) => {
    let session: AgentSession | undefined;
    let failure: QuotaFailureReason = "initialization";
    let status: number | undefined;
    let result: ProbeReply;
    try {
      const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(input.sdk);
      const ai: typeof import("@earendil-works/pi-ai") = await import(input.ai);
      const evidence = captureQuotaEvidence(async (...args) => {
        const response = await fetch(...args);
        status = response.status;
        return response;
      });
      const runtime = await sdk.ModelRuntime.create({
        credentials: new ai.InMemoryCredentialStore(),
        modelsStore: new ai.InMemoryModelsStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const native = runtime.getProvider("openai");
      if (!native) throw new Error("Native OpenAI provider unavailable");
      runtime.registerProvider("openai", {
        api: "openai-responses",
        streamSimple: (model, context, options) =>
          native.streamSimple(model, context, {
            ...options,
            maxRetries: 0,
            fetch: evidence.fetch,
          }),
      });
      await runtime.setRuntimeApiKey("openai", input.auth.apiKey);
      const resolved = await runtime.getAuth(input.model);
      failure = "authentication";
      if (resolved?.auth.apiKey !== input.auth.apiKey) throw new Error("Probe auth conflict");
      for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) {
        if (name.toLowerCase() === "authorization" && value !== `Bearer ${input.auth.apiKey}`) {
          throw new Error("Probe header conflict");
        }
      }
      failure = "initialization";
      const resources: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "Reply to ping with exactly pong. Do not use tools.",
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
      };
      ({ session } = await sdk.createAgentSession({
        cwd: input.directory,
        agentDir: input.directory,
        model: input.model,
        modelRuntime: runtime,
        resourceLoader: resources,
        tools: [],
        noTools: "all",
        thinkingLevel: "off",
        sessionManager: sdk.SessionManager.inMemory(input.directory),
        settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      }));
      failure = "transport";
      await session.prompt("ping");
      failure = "reply";
      const terminal = session.messages
        .filter((message): message is AssistantMessage => message.role === "assistant")
        .at(-1);
      if (!terminal) throw new Error("Missing probe result");
      const text = terminal.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (
        terminal.stopReason === "stop" &&
        text === "pong" &&
        terminal.content.every((part) => part.type === "text" || part.type === "thinking")
      ) {
        result = { kind: "pong" };
      } else if (terminal.stopReason === "error") {
        result =
          (evidence.limited() ?? isOpenAIQuotaError(terminal.errorMessage))
            ? { kind: "quota" }
            : {
                kind: "failed",
                reason:
                  status === 401 || status === 403 ? "authentication" : status === undefined ? "transport" : "provider",
              };
      } else result = { kind: "failed", reason: "reply" };
    } catch {
      result = { kind: "failed", reason: failure };
    } finally {
      session?.dispose();
    }
    process.send?.(result, () => process.disconnect?.());
  });
  process.send?.({ kind: "ready" } satisfies ProbeReply);
}
