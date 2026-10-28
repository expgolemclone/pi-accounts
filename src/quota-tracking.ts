import {
  type Api,
  isRetryableAssistantError,
  lazyStream,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AccountStore, credentialGeneration, getOwnCredential, type StoredCredential } from "./account-store.js";
import { captureQuotaEvidence, isOpenAIQuotaError, OPENAI_QUOTA_CODE, OPENAI_QUOTA_MESSAGE } from "./quota-errors.js";
import type { SharedSelection } from "./shared-selection.js";

export type StreamWrapper = (stream: ProviderStreams["streamSimple"]) => ProviderStreams["streamSimple"];

export class QuotaTracker {
  constructor(
    private readonly store: AccountStore,
    private readonly limited: (
      ctx: ExtensionContext,
      selection: SharedSelection,
      model: Model<Api>,
      signal: AbortSignal,
      retryToken?: string,
      round?: string,
    ) => Promise<void>,
    private readonly succeeded: (ctx: ExtensionContext, round: string | undefined) => void,
  ) {}

  wrap(
    ctx: ExtensionContext,
    name: string,
    credential: StoredCredential,
    signal: AbortSignal,
    selection: SharedSelection,
    isOperationCurrent: () => boolean,
    retryToken?: string,
    round?: string,
  ): StreamWrapper | undefined {
    if (credential.type !== "oauth") return undefined;
    const access = credential.access;
    const generation = credentialGeneration(credential);
    if (!generation) throw new Error("OpenAI account generation is missing.");
    return (stream) => (model, context, options) => {
      if (
        model.provider !== "openai" ||
        new URL(model.baseUrl).origin !== "https://api.openai.com" ||
        options?.apiKey !== access
      ) {
        return stream(model, context, options);
      }
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (key.toLowerCase() === "authorization" && value !== `Bearer ${access}`)
          return stream(model, context, options);
      }
      return lazyStream(model, async () => {
        signal.throwIfAborted();
        const evidence = captureQuotaEvidence(options.fetch);
        const source = stream(model, context, { ...options, fetch: evidence.fetch });
        const recover = async () => {
          try {
            const state = await this.store.readProviderAsync("openai", signal);
            if (credentialGeneration(getOwnCredential(state.accounts, name)) === generation && isOperationCurrent()) {
              await this.limited(ctx, selection, model, signal, retryToken, round);
            }
          } catch {
            if (!signal.aborted) {
              try {
                ctx.ui.notify("OpenAI account recovery could not complete safely.", "error");
              } catch {
                /* Stale UI. */
              }
            }
          }
        };
        const succeeded = this.succeeded;
        return (async function* () {
          for await (const event of source) {
            if (event.type === "done" && !signal.aborted && isOperationCurrent()) succeeded(ctx, round);
            if (
              event.type === "error" &&
              event.error.stopReason === "error" &&
              (evidence.limited() ?? isOpenAIQuotaError(event.error.errorMessage))
            ) {
              await recover();
              // Prevent Pi from retrying the exhausted account before its actionable
              // boundary. Unrelated provider errors retain normal retry behavior.
              if (isRetryableAssistantError(event.error)) {
                yield {
                  ...event,
                  error: {
                    ...event.error,
                    errorMessage: `${OPENAI_QUOTA_CODE}: ${OPENAI_QUOTA_MESSAGE}`,
                  },
                };
                continue;
              }
            }
            yield event;
          }
        })();
      });
    };
  }
}
