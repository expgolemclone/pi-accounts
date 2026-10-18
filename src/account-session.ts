import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountProviderId } from "./oauth.js";
import type { EnsureActiveProviderAuthResult, RuntimeAuthCoordinator } from "./runtime-auth.js";
import type { ProviderAccountSelections } from "./session-selection.js";

type SessionEntryWriter = { appendCustomEntry(customType: string, data?: unknown): string };

export type SessionSelectionOwner = {
  context: ExtensionContext;
  sessionManager: ExtensionContext["sessionManager"] & SessionEntryWriter;
  sessionId: string;
  selections: ProviderAccountSelections;
  selectionRevisions: Map<AccountProviderId, number>;
  activationRequests: Map<AccountProviderId, number>;
  error?: string;
  environmentAccount?: string;
  environmentError?: string;
  controller: AbortController;
  signal: AbortSignal;
  ready: Promise<void>;
  coordinators: Map<AccountProviderId, RuntimeAuthCoordinator>;
  results: Map<AccountProviderId, EnsureActiveProviderAuthResult>;
  appliedIdentities: Map<AccountProviderId, string>;
  abortProviders: Set<AccountProviderId>;
  syncTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
  pendingSyncTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
  startupTask: Promise<void>;
  startupTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
  startupCompletedProviders: Set<AccountProviderId>;
};

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
