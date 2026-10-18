import assert from "node:assert/strict";
import { type Model, normalizeContext, type ProviderStreams } from "@earendil-works/pi-ai";
import { test } from "vitest";
import {
  captureQuotaEvidence,
  OPENAI_QUOTA_CODE as code,
  isOpenAIQuotaError,
  OPENAI_QUOTA_MESSAGE as message,
} from "../src/quota-errors.js";

const suffix = "\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage";
const http = (body: unknown, status = 429) => `OpenAI API error (${status}): ${JSON.stringify(body)}`;

test.each([
  message,
  `Error: ${message}`,
  `${code}: ${message}`,
  `Error Code ${code}: ${message}`,
  `unknown: ${message}`,
  `Error Code undefined: ${message}`,
  http({ code, message }),
  http({ error: { code, message } }),
  http({ message }),
  http({ detail: message }),
  `OpenAI API error (429): 429 ${message}`,
  `OpenAI API error (429): 429 ${JSON.stringify({ detail: message })}`,
  `429 ${JSON.stringify({ error: { code } })}`,
  `${code}: ${message}${suffix}`,
])("recognizes an exact supported quota envelope: %s", (error) => {
  assert.equal(isOpenAIQuotaError(error), true);
});

test.each([
  undefined,
  "",
  "429 Too many requests",
  "The ChatGPT user has reached their Subscription Sharing usage limit.",
  `Diagnostic: ${message}`,
  `"${message}"`,
  `Error: Error: ${message}`,
  `${message} Please retry.`,
  `some_error: ${message}`,
  http({ code: "invalid_api_key", message }),
  http({ code: "subscription_sharing_usage_unavailable", message }),
  http({ message: `Diagnostic: ${message}` }),
  http({ message: `Quoted ${code}` }),
  http({ error: { detail: `Diagnostic: ${message}` } }),
  http({ error: [] }),
  http({ error: null }),
  http({ code, message }, 401),
  http({ message }, 403),
  http({ message }, 503),
  JSON.stringify({ code, message }),
  `${http({ code })} trailing diagnostic`,
])("rejects unrelated or ambiguous text: %s", (error) => {
  assert.equal(isOpenAIQuotaError(error), false);
});

const model: Model<"openai-responses"> = {
  id: "offline-fixture",
  name: "Offline fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 64,
};
const response =
  (body: unknown, status = 429) =>
  () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
    });
const sse = (event: { type: string; [key: string]: unknown }) => () =>
  new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

test.each([
  ["HTTP code", response({ error: { code, message } }), true],
  ["HTTP message", response({ error: { message } }), true],
  ["HTTP text", response(message), true],
  ["HTTP detail", response({ detail: message }), true],
  ["SDK SSE code loss", sse({ type: "error", code, message }), true],
  ["SSE message", sse({ type: "error", message }), true],
  ["SSE conflicting code", sse({ type: "error", code: "invalid_api_key", message }), false],
  ["SSE nested conflicting code", sse({ type: "error", error: { code: "invalid_api_key", message } }), false],
  ["SSE conflicting status", sse({ type: "error", status: 403, message }), false],
  ["SSE exact code with different text", sse({ type: "error", code, message: "Subscription exhausted" }), true],
  ["failed code", sse({ type: "response.failed", response: { status: "failed", error: { code, message } } }), true],
  ["failed message", sse({ type: "response.failed", response: { status: "failed", error: { message } } }), true],
  ["generic 429", response({ error: { code: "rate_limit_exceeded", message: "Too many requests" } }), false],
  ["conflicting code", response({ error: { code: "invalid_api_key", message } }), false],
  ["auth", response({ error: { message } }, 401), false],
  ["policy", response({ error: { message } }, 403), false],
  ["server", response({ error: { message } }, 503), false],
  ["quoted diagnostic", response({ error: { message: `Diagnostic: ${message}` } }), false],
] as const)("classifies the real native adapter result: %s", async (_name, respond, expected) => {
  // A variable import is intentional: Pi's Jiti can misresolve static API subpaths.
  const moduleId = "@earendil-works/pi-ai/api/openai-responses";
  const { streamSimple } = (await import(moduleId)) as ProviderStreams;
  let requests = 0;
  const evidence = captureQuotaEvidence(async () => {
    requests++;
    return respond();
  });
  const stream = streamSimple(
    model,
    normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 0 }] }),
    {
      apiKey: "offline-synthetic-access",
      maxRetries: 0,
      fetch: evidence.fetch,
    },
  );
  const result = await stream.result();
  assert.equal(requests, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(
    evidence.limited() ?? isOpenAIQuotaError(result.errorMessage),
    expected,
    result.errorMessage ?? "Missing native error",
  );
});

test.each([true, false])("transport suppresses only exact quota retries, limited=%s", async (limited) => {
  const moduleId = "@earendil-works/pi-ai/api/openai-responses";
  const { streamSimple } = (await import(moduleId)) as ProviderStreams;
  let requests = 0;
  const evidence = captureQuotaEvidence(async () => {
    requests++;
    return new Response(JSON.stringify({ error: { message: limited ? message : "Try again later" } }), {
      status: 429,
      headers: { "retry-after-ms": "1" },
    });
  });
  const result = await streamSimple(
    model,
    normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 0 }] }),
    {
      apiKey: "offline-synthetic",
      maxRetries: 2,
      fetch: evidence.fetch,
    },
  ).result();
  assert.equal(result.stopReason, "error");
  assert.equal(requests, limited ? 1 : 3);
});

test("SSE transport preserves split UTF-8 bytes and captures a conflicting nested code", async () => {
  const bytes = new TextEncoder().encode(
    `: comment\r\nevent: error\r\ndata: ${JSON.stringify({ error: { code: "invalid_api_key", message } })}\r\n\r\n`,
  );
  const evidence = captureQuotaEvidence(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const response = await evidence.fetch("https://api.openai.com/v1/responses");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(evidence.limited(), false);
});
