// Fixed summaries are the only probe diagnostics allowed into shared recovery state.
const messages = {
  modules: "Probe modules could not be resolved from the running Pi host.",
  storage: "Probe temporary storage could not be created or cleaned up.",
  launch: "Probe process could not be launched.",
  startup_timeout: "Probe process startup timed out.",
  inference_timeout: "Probe inference timed out.",
  cancelled: "Probe was cancelled.",
  protocol: "Probe process returned an invalid handshake or result.",
  initialization: "Probe SDK initialization failed.",
  authentication: "Probe authentication was rejected or conflicted with the selected credential.",
  transport: "Probe request failed before an HTTP response was received.",
  provider: "Probe provider returned a non-quota error.",
  reply: "Probe did not complete with exactly pong.",
  credential: "Probe candidate credentials could not be read, refreshed or converted.",
} as const;

export type QuotaFailureReason = keyof typeof messages;

export class QuotaRecoveryError extends Error {
  constructor(readonly reason: QuotaFailureReason) {
    super(`OpenAI account recovery stopped: ${messages[reason]}`);
    this.name = "QuotaRecoveryError";
  }
}

export function isQuotaFailureReason(value: unknown): value is QuotaFailureReason {
  return typeof value === "string" && Object.hasOwn(messages, value);
}
