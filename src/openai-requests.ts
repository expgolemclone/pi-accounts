import { type Api, lazyStream, type Model, type ModelAuth, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountStore, StoredCredential } from "./account-store.js";
import type { AccountProviderAdapter } from "./oauth.js";
import type { probeAccount } from "./quota-probe.js";
import type { QuotaRecovery, RecoveryResult } from "./quota-recovery.js";
import { QuotaTracker, type StreamWrapper } from "./quota-tracking.js";
import type { SharedSelection } from "./shared-selection.js";

type RequestAuth = { selection: SharedSelection; credential?: StoredCredential; auth: ModelAuth };
type Pending = { revision: string; controller: AbortController; outcome?: RecoveryResult; completion?: Promise<void> };
type SessionRequests = {
  tail: Promise<void>;
  pending?: Pending;
  inputRevision: number;
  sent?: string;
  compactionFailed?: boolean;
  sweep?: string;
};

/** Request-local dispatch; never recursively calls modelRegistry.stream or mutates a stream already sent. */
export class OpenAIRequests {
  private readonly sessions = new WeakMap<object, SessionRequests>();
  private readonly tracker: QuotaTracker;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly store: AccountStore,
    private readonly recovery: QuotaRecovery,
    private readonly adapter: AccountProviderAdapter,
    private readonly prepare: (ctx: ExtensionContext, signal: AbortSignal, model: Model<Api>) => Promise<RequestAuth>,
    private readonly current: (ctx: ExtensionContext) => boolean,
    private readonly snapshot: () => SharedSelection | undefined,
    private readonly probe: typeof probeAccount = async (...args) => {
      const { probeAccount } = await import("./quota-probe.js");
      return probeAccount(...args);
    },
  ) {
    this.tracker = new QuotaTracker(
      store,
      (ctx, selection, model, signal, retryToken, round) =>
        this.recover(ctx, selection, model, signal, retryToken, round),
      (ctx, round) => {
        const session = this.sessions.get(ctx.sessionManager);
        if (session && session.sweep === round) session.sweep = undefined;
      },
    );
  }

  private async recover(
    ctx: ExtensionContext,
    selection: SharedSelection,
    model: Model<Api>,
    signal: AbortSignal,
    retryToken?: string,
    round?: string,
  ): Promise<void> {
    const session = this.session(ctx);
    if (session.pending?.revision === selection.revision) {
      await session.pending.completion;
      return;
    }
    if (session.pending && selection.revision !== this.snapshot()?.revision) return;
    session.pending?.controller.abort();
    const controller = new AbortController();
    const operation = AbortSignal.any([signal, controller.signal]);
    const pending: Pending = { revision: selection.revision, controller };
    if (!ctx.isIdle()) session.pending = pending;
    ctx.ui.notify("OpenAI usage limit reached; trying the remaining accounts in this recovery round.", "warning");
    // Await while the request's operation signal is still active. Escape cancels
    // the child here; there must be no asynchronous waiting at the final boundary.
    pending.completion = this.recovery
      .recover(
        selection,
        (name, credential, probeSignal) =>
          this.probe(this.store, this.adapter, ctx, model, name, credential, probeSignal),
        operation,
        retryToken,
        round,
      )
      .then((outcome) => {
        pending.outcome = outcome;
        if (outcome.status === "ready" && session.pending === pending && !operation.aborted && this.current(ctx)) {
          session.sweep = outcome.round;
        }
      });
    await pending.completion;
  }

  private session(ctx: ExtensionContext): SessionRequests {
    let session = this.sessions.get(ctx.sessionManager);
    if (!session) {
      session = { tail: Promise.resolve(), inputRevision: 0 };
      this.sessions.set(ctx.sessionManager, session);
    }
    return session;
  }

  cancel(ctx: ExtensionContext, resetSweep = false): void {
    const session = this.sessions.get(ctx.sessionManager);
    session?.pending?.controller.abort();
    if (session) {
      session.pending = undefined;
      session.compactionFailed = false;
      if (resetSweep) session.sweep = undefined;
      session.inputRevision++;
    }
  }

  dispose(ctx: ExtensionContext): void {
    this.cancel(ctx);
    this.sessions.delete(ctx.sessionManager);
  }

  wrap(
    ctx: ExtensionContext,
    _name: string | null,
    _credential: StoredCredential | undefined,
    ownerSignal: AbortSignal,
  ): StreamWrapper {
    return (stream) => (model, context, options) => {
      if (
        model.provider !== "openai" ||
        model.api !== "openai-responses" ||
        new URL(model.baseUrl).origin !== "https://api.openai.com"
      ) {
        return stream(model, context, options);
      }
      const session = this.session(ctx);
      const inputRevision = session.inputRevision;
      return lazyStream(model, async () => {
        const signal = options?.signal ? AbortSignal.any([ownerSignal, options.signal]) : ownerSignal;
        if (_credential && options?.apiKey !== (_credential.type === "oauth" ? _credential.access : _credential.key)) {
          throw new Error("OpenAI request credential conflicts with the captured account.");
        }
        const previous = session.tail;
        let release!: () => void;
        session.tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        let ready: RequestAuth;
        try {
          await previous;
          signal.throwIfAborted();
          ready = await this.prepare(ctx, signal, model);
        } finally {
          release();
        }
        signal.throwIfAborted();
        if (!this.current(ctx)) throw new Error("Accounts session was replaced before the request.");
        const headers = { ...options?.headers, ...ready.auth.headers };
        for (const [name, value] of Object.entries(options?.headers ?? {})) {
          if (name.toLowerCase() !== "authorization") continue;
          if (value !== `Bearer ${options?.apiKey}`)
            throw new Error("OpenAI request authentication conflicts with the shared selection.");
          delete headers[name];
          if (ready.auth.apiKey) headers.Authorization = `Bearer ${ready.auth.apiKey}`;
        }
        const next: SimpleStreamOptions = { ...options, apiKey: ready.auth.apiKey, headers, signal };
        const account = ready.selection.account;
        const credential = ready.credential;
        if (account !== null && credential?.type === "oauth") {
          const round = session.sweep;
          const retryToken = round === undefined ? await this.recovery.retryToken(ready.selection, signal) : undefined;
          signal.throwIfAborted();
          if (!this.current(ctx)) throw new Error("Accounts session was replaced before the request.");
          const tracked = this.tracker.wrap(
            ctx,
            account,
            credential,
            signal,
            ready.selection,
            () => this.current(ctx) && session.inputRevision === inputRevision,
            retryToken,
            round,
          );
          return tracked ? tracked(stream)(model, context, next) : stream(model, context, next);
        }
        return stream(model, context, next);
      });
    };
  }

  registerLifecycle(): void {
    this.pi.on("input", (_event, ctx) => {
      this.cancel(ctx, true);
    });
    this.pi.on("agent_settled", (_event, ctx) => {
      const session = this.sessions.get(ctx.sessionManager);
      if (session) session.sweep = undefined;
    });
    this.pi.on("session_compact_failed", (event, ctx) => {
      const session = this.sessions.get(ctx.sessionManager);
      if (session) session.compactionFailed = event.reason !== "manual" && !event.aborted;
    });
    this.pi.on("agent_before_settle", (event, ctx) => {
      const session = this.sessions.get(ctx.sessionManager);
      const pending = session?.pending;
      if (!session || !pending) return;
      session.pending = undefined;
      try {
        const result = pending.outcome;
        if (
          !result ||
          !this.current(ctx) ||
          pending.controller.signal.aborted ||
          ctx.signal?.aborted ||
          (event.outcome !== "error" && !session.compactionFailed) ||
          event.outcome === "aborted" ||
          event.context.pendingMessages.length > 0
        )
          return;
        session.compactionFailed = false;
        if (result.status === "stopped") {
          ctx.ui.notify(result.message, "warning");
          return;
        }
        // This transaction is synchronous and bounded. User cancellation cannot race an
        // await here and leave a continue queued after Escape cancelled the boundary.
        if (this.snapshot()?.revision !== result.revision || session.sent === pending.revision) return;
        session.sent = pending.revision;
        // Pi commits this boundary message atomically and converts its literal content
        // to a user message for inference. No fire-and-forget sendUserMessage race, no
        // agent_end/notification-only agent_settled actions, and no tool/prompt replay.
        return {
          entries: [
            ...event.entries,
            {
              type: "custom_message" as const,
              customType: "accounts:quota-continue",
              content: "continue",
              display: true,
              details: { failedRevision: pending.revision },
            },
          ],
          continue: true,
        };
      } catch {
        if (this.current(ctx) && !pending.controller.signal.aborted)
          ctx.ui.notify("OpenAI recovery could not complete safely. No continue was sent.", "error");
      }
    });
  }
}
