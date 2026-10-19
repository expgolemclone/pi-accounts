import type { PersistSelection, SessionSelectionOwner, SyncProvider } from "./account-session.js";
import { type AccountStore, getOwnCredential, parseAccountName } from "./account-store.js";
import type {
  AccountActivationErrorCode,
  AccountActivationResult,
  AccountsActivationRequest,
} from "./accounts-protocol.js";
import type { AccountProviderId } from "./oauth.js";
import { type EnsureActiveProviderAuthResult, redactTokenText } from "./runtime-auth.js";

export type AccountActivationRequest = Omit<AccountsActivationRequest, "reply"> & { isCurrent?: () => boolean };
export type AccountActivationOutcome = AccountActivationResult & { message?: string };
export type ActivateAccount = (request: AccountActivationRequest) => Promise<AccountActivationOutcome>;

// A replacement sync belongs to the session, not the requesting consumer. Stop waiting on
// cancellation without aborting that shared work, and release the listener on settlement.
async function waitForActivation<T>(task: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createAccountActivation(
  store: AccountStore,
  adapters: ReadonlyMap<AccountProviderId, unknown>,
  getOwner: (session: object) => SessionSelectionOwner | undefined,
  isOwnerCurrent: (owner: SessionSelectionOwner) => boolean,
  persistSelection: PersistSelection,
  syncProvider: SyncProvider,
): ActivateAccount {
  return async (request) => {
    const error = (code: AccountActivationErrorCode, cause?: unknown): AccountActivationOutcome => ({
      status: "error",
      providerId: request.provider,
      accountName: request.account,
      code,
      ...(cause === undefined
        ? {}
        : { message: redactTokenText(cause instanceof Error ? cause.message : String(cause)) }),
    });
    const providerId = request.provider as AccountProviderId;
    if (!adapters.has(providerId)) return error("provider_unsupported");
    const owner = getOwner(request.session);
    if (!owner || !isOwnerCurrent(owner)) return error("session_unavailable");
    if (request.signal?.aborted) return error("cancelled");
    // A process override owns every managed provider; explicit selection must not bypass it.
    if (owner.environmentAccount !== undefined || owner.environmentError !== undefined)
      return error("activation_failed");
    if (request.account !== null) {
      const parsed = parseAccountName(request.account);
      if (!parsed.ok || parsed.name !== request.account) return error("account_not_found");
    }
    // Reads can wait behind refreshes; only the newest explicit request may publish its selection.
    const provider = owner.providers.get(providerId);
    if (!provider) return error("session_unavailable");
    const generation = ++provider.activationRequest;
    let selectionRevision = provider.selectionRevision;
    const isRequestCurrent = () =>
      provider.activationRequest === generation &&
      provider.selectionRevision === selectionRevision &&
      !request.signal?.aborted &&
      (request.isCurrent?.() ?? true);
    const unavailable = (): AccountActivationOutcome | undefined => {
      if (!isOwnerCurrent(owner) || owner.sessionId !== owner.sessionManager.getSessionId())
        return error("session_unavailable");
      if (request.signal?.aborted) return error("cancelled");
      if (!isRequestCurrent()) return error("activation_superseded");
    };
    const activationSignal = AbortSignal.any([owner.signal, ...(request.signal ? [request.signal] : [])]);
    await waitForActivation(owner.ready, activationSignal);
    const staleAfterStartup = unavailable();
    if (staleAfterStartup) return staleAfterStartup;
    if (request.account !== null) {
      try {
        const data = await store.readAsync(activationSignal);
        const staleAfterRead = unavailable();
        if (staleAfterRead) return staleAfterRead;
        if (!getOwnCredential(data.providers[providerId]?.accounts ?? {}, request.account))
          return error("account_not_found");
      } catch (cause) {
        return unavailable() ?? error("store_unavailable", cause);
      }
    }
    try {
      if (!(await persistSelection(owner, providerId, request.account, isRequestCurrent)))
        return unavailable() ?? error("session_unavailable");
    } catch (cause) {
      return unavailable() ?? error("store_unavailable", cause);
    }
    selectionRevision = provider.selectionRevision;
    const staleAfterPersistence = unavailable();
    if (staleAfterPersistence) return staleAfterPersistence;
    let task = syncProvider(providerId, owner.context, owner, request.signal);
    let result: EnsureActiveProviderAuthResult;
    try {
      // Routine model/turn syncs may replace this task without changing the selection.
      while (true) {
        const settled = await waitForActivation(task, activationSignal);
        const staleAfterSync = unavailable();
        if (staleAfterSync) return staleAfterSync;
        if (!settled) return error("activation_failed");
        result = settled;
        const latest = provider.syncTask;
        if (!latest || latest === task) break;
        task = latest;
      }
    } catch {
      return unavailable() ?? error("activation_failed");
    }

    if (result.status === "error") return error(result.code ?? "activation_failed", result.message);
    if (result.status === "inactive") {
      return request.account === null
        ? { status: "inactive", providerId, accountName: null }
        : error("activation_failed");
    }
    if (result.accountName !== request.account) return error("activation_superseded");
    if (request.model && !provider.coordinator.isModelAvailable(request.model)) return error("model_unavailable");
    return { status: "active", providerId, accountName: result.accountName };
  };
}
