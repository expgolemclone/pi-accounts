import { createParser } from "eventsource-parser";

export const OPENAI_QUOTA_CODE = "subscription_sharing_usage_limit_exceeded";
export const OPENAI_QUOTA_MESSAGE =
  "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
const USAGE_SUFFIX = "\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only call for a failed, attributed native OpenAI OAuth request, never for conversation text. */
export function isOpenAIQuotaError(message: string | undefined): boolean {
  if (!message) return false;
  let text = message.startsWith("Error: ") ? message.slice(7) : message;
  if (text.endsWith(USAGE_SUFFIX)) text = text.slice(0, -USAGE_SUFFIX.length);
  if (text === OPENAI_QUOTA_MESSAGE) return true;
  // response.failed and parsed stream errors preserve a code prefix. An unknown/missing
  // code may accompany exactly the user-requested sentence, never arbitrary diagnostic prose.
  for (const prefix of ["", "Error Code "]) {
    if (text.startsWith(`${prefix}${OPENAI_QUOTA_CODE}: `)) return true;
    if (text === `${prefix}unknown: ${OPENAI_QUOTA_MESSAGE}`) return true;
    if (text === `${prefix}undefined: ${OPENAI_QUOTA_MESSAGE}`) return true;
  }
  const http = /^(?:OpenAI API error \((\d{3})\): |(\d{3}) )(.+)$/u.exec(text);
  if (!http || (http[1] ?? http[2]) !== "429") return false;
  let body = http[3] ?? "";
  if (body.startsWith("429 ")) body = body.slice(4);
  if (body === OPENAI_QUOTA_MESSAGE) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return isQuotaEnvelope(parsed);
}

function isQuotaEnvelope(value: unknown): boolean {
  if (!record(value)) return false;
  const error = Object.hasOwn(value, "error") ? value.error : value;
  if (!record(error)) return false;
  let exactCode = false;
  for (const item of [value, error]) {
    if (typeof item.status === "number" && item.status >= 400 && item.status !== 429) return false;
    if (item.code !== undefined && item.code !== null && item.code !== "") {
      if (item.code !== OPENAI_QUOTA_CODE) return false;
      exactCode = true;
    }
  }
  if (exactCode) return true;
  return error.message === OPENAI_QUOTA_MESSAGE || error.detail === OPENAI_QUOTA_MESSAGE;
}

/** Preserve transport evidence before the OpenAI SDK discards SSE error codes.
 * Bytes and normal retry behavior pass through unchanged. Only a verified HTTP
 * quota response gets the SDK's supported no-retry header. Never tee whole streams.
 */
export function captureQuotaEvidence(fetchRequest: typeof globalThis.fetch = globalThis.fetch) {
  let limited: boolean | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    limited = undefined;
    const response = await fetchRequest(input, init);
    if (!response.ok) {
      limited = false;
      if (response.status !== 429 || !response.body) return response;
      const copy = response.clone();
      const reader = copy.body?.getReader();
      if (!reader) return response;
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (text.length <= 16_384) {
          const part = await reader.read();
          if (part.done) {
            text += decoder.decode();
            limited = isOpenAIQuotaError(`429 ${text}`);
            break;
          }
          text += decoder.decode(part.value, { stream: true });
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      if (!limited) return response;
      const headers = new Headers(response.headers);
      headers.set("x-should-retry", "false");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
    let disabled = false;
    const decoder = new TextDecoder();
    const parser = createParser({
      maxBufferSize: 1_048_576,
      onError(error) {
        if (error.type === "max-buffer-size-exceeded") {
          disabled = true;
          limited = false;
        }
      },
      onEvent(event) {
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!record(value)) return;
        if (event.event === "error" || value.type === "error") limited = isQuotaEnvelope(value);
        else if (value.type === "response.failed" && record(value.response)) limited = isQuotaEnvelope(value.response);
      },
    });
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!disabled) {
            try {
              parser.feed(decoder.decode(chunk, { stream: true }));
            } catch {
              disabled = true;
              limited = false;
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch, limited: () => limited };
}
