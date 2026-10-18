import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { OPENAI_QUOTA_MESSAGE } from "../src/quota-errors.js";
import { runProbeProcess } from "../src/quota-probe.js";

const model: Model<"openai-responses"> = {
  id: "offline-fixture",
  name: "Offline fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 64,
};

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
function pong(response: ServerResponse, text = "pong") {
  const item = {
    id: "msg-offline",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "response-offline" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-offline", status: "completed", output: [item] } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

test("fresh headless Pi probe sends only ping, no tools/history, and verifies terminal pong", async () => {
  let body: Record<string, unknown> | undefined;
  let authorization: string | undefined;
  let requests = 0;
  await server(
    (request, response) => {
      requests++;
      authorization = request.headers.authorization;
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        text += chunk;
      });
      request.on("end", () => {
        body = JSON.parse(text);
        pong(response);
      });
    },
    async (baseUrl) => {
      assert.equal(
        await runProbeProcess(
          { ...model, baseUrl },
          { apiKey: "offline-synthetic-access" },
          new AbortController().signal,
        ),
        "pong",
      );
    },
  );
  assert.equal(requests, 1);
  assert.equal(authorization, "Bearer offline-synthetic-access");
  assert.ok(body);
  assert.equal(body.model, model.id);
  assert.equal(body.tools, undefined);
  const input = JSON.stringify(body.input);
  assert.match(input, /ping/);
  assert.doesNotMatch(input, /AGENTS|PLAN|original conversation|powershell/);
});

test("probe accepts the exact message-only quota failure without retrying the request", async () => {
  let requests = 0;
  await server(
    (_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: error\ndata: ${JSON.stringify({ type: "error", message: OPENAI_QUOTA_MESSAGE })}\n\n`);
    },
    async (baseUrl) => {
      assert.equal(
        await runProbeProcess(
          { ...model, baseUrl },
          { apiKey: "offline-synthetic-access" },
          new AbortController().signal,
        ),
        "quota",
      );
    },
  );
  assert.equal(requests, 1);
});

test("successful inference with the wrong reply is not verified pong", async () => {
  await server(
    (_request, response) => pong(response, "not pong"),
    async (baseUrl) => {
      await assert.rejects(
        runProbeProcess({ ...model, baseUrl }, { apiKey: "offline-synthetic-access" }, new AbortController().signal),
        /pong/,
      );
    },
  );
});

for (const fixture of [
  { status: 429, message: OPENAI_QUOTA_MESSAGE, expected: "quota" },
  { status: 429, message: "Try again later", expected: "invalid" },
  { status: 503, message: "Server unavailable secret-provider-body", expected: "invalid" },
  { status: 401, message: "Bearer synthetic-access rt.synthetic-refresh", expected: "authentication" },
]) {
  test(`headless probe performs exactly one HTTP ${fixture.status} attempt for ${fixture.expected}`, async () => {
    let calls = 0;
    await server(
      (_request, response) => {
        calls++;
        response.writeHead(fixture.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: fixture.message } }));
      },
      async (baseUrl) => {
        const operation = runProbeProcess(
          { ...model, baseUrl },
          { apiKey: "offline-synthetic-token" },
          new AbortController().signal,
        );
        if (fixture.expected === "quota") assert.equal(await operation, "quota");
        else
          await assert.rejects(operation, (error: Error) => {
            assert.match(error.message, fixture.expected === "authentication" ? /authentication/ : /non-quota/);
            assert.doesNotMatch(error.message, /secret-provider-body|synthetic-access|synthetic-refresh/);
            return true;
          });
        assert.equal(calls, 1);
      },
    );
  });
}

test("a fresh probe rejects a contradictory SSE code despite SDK code loss", async () => {
  await server(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `event: error\ndata: ${JSON.stringify({ type: "error", code: "invalid_api_key", message: OPENAI_QUOTA_MESSAGE })}\n\n`,
      );
    },
    async (baseUrl) => {
      await assert.rejects(
        runProbeProcess({ ...model, baseUrl }, { apiKey: "offline-synthetic" }, new AbortController().signal),
        /non-quota/,
      );
    },
  );
});

test("cancelling a live probe kills its owned child and releases the operation", async () => {
  const controller = new AbortController();
  await server(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      controller.abort();
    },
    async (baseUrl) => {
      await assert.rejects(
        runProbeProcess({ ...model, baseUrl }, { apiKey: "offline-synthetic-access" }, controller.signal),
        /cancelled/,
      );
    },
  );
});
