import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountProviderId } from "./oauth.js";
import type { EnsureActiveProviderAuthResult, RuntimeAuthCoordinator } from "./runtime-auth.js";
import type { ProviderAccountSelections } from "./session-selection.js";

type SessionEntryWriter = { appendCustomEntry(customType: string, data?: unknown): string };

export type ProviderSessionState = {
  coordinator: RuntimeAuthCoordinator;
  selectionRevision: number;
  activationRequest: number;
  result?: EnsureActiveProviderAuthResult;
  appliedIdentity?: string;
  abortTurn: boolean;
  syncTask?: Promise<EnsureActiveProviderAuthResult>;
  pendingSync?: Promise<EnsureActiveProviderAuthResult>;
  startupTask?: Promise<EnsureActiveProviderAuthResult>;
  started: boolean;
};

export class SessionSelectionOwner {
  readonly sessionManager: ExtensionContext["sessionManager"] & SessionEntryWriter;
  readonly sessionId: string;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly providers: Map<AccountProviderId, ProviderSessionState>;
  selections: ProviderAccountSelections = Object.create(null) as ProviderAccountSelections;
  ready: Promise<void> = Promise.resolve();
  error?: string;

  constructor(
    readonly context: ExtensionContext,
    coordinators: Iterable<RuntimeAuthCoordinator>,
    readonly environmentAccount?: string,
    readonly environmentError?: string,
  ) {
    // Pi exposes a read-only view, but factory-bound pi.appendEntry() cannot target concurrent sessions.
    this.sessionManager = context.sessionManager as SessionSelectionOwner["sessionManager"];
    this.sessionId = context.sessionManager.getSessionId();
    this.providers = new Map(
      [...coordinators].map((coordinator) => [
        coordinator.provider.id,
        { coordinator, selectionRevision: 0, activationRequest: 0, abortTurn: false, started: false },
      ]),
    );
  }

  async dispose(context: ExtensionContext, restoreDefault = false): Promise<void> {
    this.controller.abort(new DOMException("Accounts session disposed", "AbortError"));
    const states = [...this.providers.values()];
    this.providers.clear();
    await Promise.allSettled(
      states.map(async ({ coordinator }) => {
        // The previous event context may already be stale after replacement.
        coordinator.invalidate(context, !restoreDefault);
        if (restoreDefault) await coordinator.clear(context, true);
      }),
    );
  }
}

export type SyncProvider = (
  providerId: AccountProviderId,
  ctx: ExtensionContext,
  owner: SessionSelectionOwner,
  ownerSignal?: AbortSignal,
  model?: ExtensionContext["model"],
) => Promise<EnsureActiveProviderAuthResult>;

export type PersistSelection = (
  owner: SessionSelectionOwner,
  providerId: AccountProviderId,
  accountName: string | null,
  isCurrent: () => boolean,
) => boolean | Promise<boolean>;
