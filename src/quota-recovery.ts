import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type AccountStore,
  credentialGeneration,
  getOwnCredential,
  parseAccountName,
  type StoredCredential,
} from "./account-store.js";
import { QuotaRecoveryError } from "./quota-failure.js";
import { type OpenAISelection, readSharedSelection, type SharedSelection } from "./shared-selection.js";
import { type AccountStorageBackend, FileAccountStorageBackend } from "./storage.js";

export type RecoveryResult =
  | { status: "ready"; revision: string; round: string }
  | { status: "stopped"; message: string };
type Round = {
  // Ownership spans the sweep; the selection revision fences each representative.
  owner: string;
  revision: string;
  remaining: string[];
  startedAt: number;
  deadline: number;
  result?: RecoveryResult;
};
type RecoveryData = { version: 2; rounds: Record<string, Round>; [key: string]: unknown };
export type CandidateProbe = (
  name: string,
  credential: StoredCredential,
  signal: AbortSignal,
) => Promise<"pong" | "quota">;
const ROUND_TIMEOUT_MS = 180_000;
const SUPERSEDED_ROUND: RecoveryResult = {
  status: "stopped",
  message: "A newer OpenAI recovery round superseded this failure. No automatic retry was scheduled.",
};

function parse(raw: string | undefined): RecoveryData {
  const value = raw === undefined ? { version: 2, rounds: {} } : JSON.parse(raw);
  // This is transient coordination state, not account data. Discard obsolete rounds.
  if (value?.version === 1) return { version: 2, rounds: {} };
  if (value?.version !== 2 || !value.rounds || typeof value.rounds !== "object" || Array.isArray(value.rounds)) {
    throw new Error("Invalid accounts recovery.json.");
  }
  const rounds = Object.create(null) as Record<string, Round>;
  for (const [id, item] of Object.entries(value.rounds)) {
    const round = item as Partial<Round> | null;
    if (
      !id ||
      !round ||
      typeof round !== "object" ||
      typeof round.owner !== "string" ||
      !round.owner ||
      typeof round.revision !== "string" ||
      !round.revision ||
      !Array.isArray(round.remaining) ||
      round.remaining.some((name) => typeof name !== "string" || !parseAccountName(name).ok) ||
      new Set(round.remaining).size !== round.remaining.length ||
      !Number.isSafeInteger(round.startedAt) ||
      (round.startedAt as number) < 0 ||
      !Number.isSafeInteger(round.deadline) ||
      (round.deadline as number) < 0 ||
      (round.result !== undefined &&
        (!round.result ||
          (round.result.status === "ready"
            ? typeof round.result.revision !== "string" || !round.result.revision || round.result.round !== id
            : round.result.status !== "stopped" || typeof round.result.message !== "string")))
    ) {
      throw new Error("Invalid accounts recovery.json.");
    }
    rounds[id] = round as Round;
  }
  return { ...value, rounds };
}

/** Short atomic elections/results only; inference and waiter delays never hold any file lock. */
export class QuotaRecovery {
  constructor(
    private readonly store: AccountStore,
    private readonly selection: OpenAISelection,
    private readonly backend: AccountStorageBackend = new FileAccountStorageBackend(
      join(getAgentDir(), "extensions", "accounts", "recovery.json"),
    ),
    private readonly timeoutMs = ROUND_TIMEOUT_MS,
  ) {}

  /** Only a request begun after a stopped round may authorize a fresh sweep. */
  async retryToken(selection: SharedSelection, signal?: AbortSignal): Promise<string | undefined> {
    return this.backend.readAsync(async (raw) => {
      const round = parse(raw).rounds[selection.revision];
      return round?.result?.status === "stopped" ? round.owner : undefined;
    }, signal);
  }

  async recover(
    failed: SharedSelection,
    probe: CandidateProbe,
    signal: AbortSignal,
    retryToken?: string,
    continuation?: string,
  ): Promise<RecoveryResult> {
    signal.throwIfAborted();
    const owner = randomUUID();
    const { id, round, elected } = await this.backend.withLockAsync(async (raw) => {
      const id = continuation ?? failed.revision;
      const data = parse(raw);
      const state = await this.store.readProviderAsync("openai", signal);
      const shared = readSharedSelection(state);
      for (const [key, value] of Object.entries(data.rounds)) {
        if (
          value.revision !== shared?.revision &&
          !(value.result?.status === "ready" && value.result.revision === shared?.revision)
        ) {
          delete data.rounds[key];
        }
      }
      const existing = data.rounds[id];
      const advance =
        continuation !== undefined &&
        existing?.result?.status === "ready" &&
        existing.result.revision === failed.revision;
      const restart =
        continuation === undefined && existing?.result?.status === "stopped" && existing.owner === retryToken;
      if (existing && !advance && !restart) return { result: { id, round: existing, elected: false } };
      const representative = Object.entries(data.rounds).find(
        ([key, value]) => key !== id && value.revision === failed.revision && value.result?.status !== "stopped",
      );
      // Fresh failures can share the current representative, including late results.
      // Competing continuations must not borrow candidates and repeat earlier accounts.
      if (representative && continuation === undefined)
        return { result: { id: representative[0], round: representative[1], elected: false } };
      const startedAt = Date.now();
      if (representative || shared?.revision !== failed.revision || (continuation !== undefined && !existing)) {
        return {
          result: {
            id,
            elected: false,
            round: {
              owner,
              revision: failed.revision,
              remaining: [],
              startedAt,
              deadline: startedAt,
              result: SUPERSEDED_ROUND,
            } satisfies Round,
          },
          next: `${JSON.stringify(data, null, 2)}\n`,
        };
      }
      const remaining = advance
        ? existing.remaining
        : Object.entries(state.accounts)
            .filter(([name, credential]) => credential.type === "oauth" && name !== failed.account)
            .map(([name]) => name);
      const created: Round = {
        owner: advance ? existing.owner : owner,
        revision: failed.revision,
        remaining,
        startedAt,
        deadline: startedAt + this.timeoutMs,
      };
      data.rounds[id] = created;
      return { result: { id, round: created, elected: true }, next: `${JSON.stringify(data, null, 2)}\n` };
    }, signal);
    if (round.result) return round.result;
    if (!elected) return this.wait(id, round, signal);
    let result: RecoveryResult;
    const deadline = AbortSignal.timeout(Math.max(1, round.deadline - Date.now()));
    const operation = AbortSignal.any([signal, deadline]);
    try {
      result = await this.lead(id, failed, round, probe, operation);
    } catch (error) {
      result = {
        status: "stopped",
        message: operation.aborted
          ? "OpenAI account recovery cancelled or timed out. No automatic retry was scheduled."
          : error instanceof QuotaRecoveryError
            ? error.message
            : "OpenAI account recovery stopped. Check account authentication, storage and transport.",
      };
    }
    // Publish cancellation too, so other processes stop waiting. Never use the cancelled
    // operation signal for the short cleanup transaction.
    return result.status === "ready" ? this.wait(id, round, signal) : this.finish(id, round, result);
  }

  private async finish(id: string, round: Round, result: RecoveryResult): Promise<RecoveryResult> {
    return this.backend.withLockAsync(async (raw) => {
      const data = parse(raw);
      const current = data.rounds[id];
      if (!current || current.owner !== round.owner || current.revision !== round.revision)
        return { result: SUPERSEDED_ROUND };
      if (current.result) return { result: current.result };
      current.result = result;
      return { result, next: `${JSON.stringify(data, null, 2)}\n` };
    });
  }

  private async wait(id: string, round: Round, signal: AbortSignal): Promise<RecoveryResult> {
    while (true) {
      signal.throwIfAborted();
      const current = await this.backend.readAsync(async (raw) => parse(raw).rounds[id], signal);
      if (!current || current.owner !== round.owner) return SUPERSEDED_ROUND;
      if (current.result) return current.result;
      if (Date.now() >= current.deadline)
        return this.finish(id, current, {
          status: "stopped",
          message: "OpenAI recovery representative did not finish before its deadline. No new probe was started.",
        });
      await delay(Math.min(100, Math.max(1, current.deadline - Date.now())), undefined, { signal });
    }
  }

  private async lead(
    id: string,
    failed: SharedSelection,
    round: Round,
    probe: CandidateProbe,
    signal: AbortSignal,
  ): Promise<RecoveryResult> {
    while (true) {
      signal.throwIfAborted();
      const state = await this.store.readProviderAsync("openai", signal);
      if (readSharedSelection(state)?.revision !== failed.revision)
        return {
          status: "stopped",
          message: "OpenAI shared selection changed; pending quota recovery was superseded.",
        };
      const candidate = round.remaining.shift();
      if (candidate === undefined)
        return {
          status: "stopped",
          message:
            "All OpenAI OAuth accounts were tried. No automatic retry was scheduled. Send a new request to retry.",
        };
      const credential = getOwnCredential(state.accounts, candidate);
      if (credential?.type !== "oauth") continue;
      const generation = credentialGeneration(credential);
      if (!generation) throw new Error("OpenAI probe account unavailable.");
      const watchController = new AbortController();
      const probeController = new AbortController();
      const probeSignal = AbortSignal.any([signal, probeController.signal]);
      const watchSignal = AbortSignal.any([signal, watchController.signal]);
      // Bounded polling exists only during this explicitly requested recovery. A manual
      // switch cancels the owned child; it never competes with a late probe publication.
      const watch = (async () => {
        try {
          while (!watchSignal.aborted) {
            await delay(100, undefined, { signal: watchSignal });
            const latest = await this.store.readProviderAsync("openai", watchSignal);
            if (readSharedSelection(latest)?.revision !== failed.revision) {
              probeController.abort();
              return;
            }
          }
        } catch {
          if (!watchSignal.aborted) probeController.abort();
        }
      })();
      let outcome: "pong" | "quota";
      try {
        outcome = await probe(candidate, credential, probeSignal);
      } catch (error) {
        probeSignal.throwIfAborted();
        // A broken login belongs to this candidate, not to the whole sweep.
        if (error instanceof QuotaRecoveryError && (error.reason === "credential" || error.reason === "authentication"))
          continue;
        throw error;
      } finally {
        watchController.abort();
        await watch;
      }
      probeSignal.throwIfAborted();
      const latest = await this.store.readProviderAsync("openai", signal);
      if (credentialGeneration(getOwnCredential(latest.accounts, candidate)) !== generation) {
        throw new Error("OpenAI probe account was replaced.");
      }
      if (outcome === "quota") continue;
      // Serialize result publication with waiter expiry. No inference runs under this
      // lock; a timed-out/dead representative cannot publish after its round stopped.
      return this.backend.withLockAsync(async (raw) => {
        const data = parse(raw);
        const current = data.rounds[id];
        if (!current || current.owner !== round.owner || current.revision !== round.revision)
          return { result: SUPERSEDED_ROUND };
        if (current.result) return { result: current.result };
        signal.throwIfAborted();
        const published = await this.selection.select(
          candidate,
          signal,
          () => !signal.aborted && Date.now() < round.deadline,
          failed.revision,
          generation,
        );
        const result: RecoveryResult = published
          ? { status: "ready", revision: published.revision, round: id }
          : {
              status: "stopped",
              message: "A newer OpenAI selection or credential superseded the verified probe.",
            };
        current.remaining = round.remaining;
        current.result = result;
        return { result, next: `${JSON.stringify(data, null, 2)}\n` };
      }, signal);
    }
  }
}
