export type HandoffReason = "rate_limit" | "context_limit" | "crash";

export interface HandoffClient {
  reportLimit(taskId: string, reason: HandoffReason): Promise<unknown>;
}

export interface WithAutoHandoffOptions {
  client: HandoffClient;
  taskId: string;
  /**
   * Classify a thrown error. Return a HandoffReason to trigger report_limit,
   * or null to let the error propagate without a handoff. Caller owns error
   * shape — the SDK intentionally does not ship provider-specific regexes.
   */
  isLimit: (err: unknown) => HandoffReason | null;
}

/**
 * Wrap an async unit of agent work. If `fn` throws and `isLimit` classifies
 * the error as a handoff trigger, report to the orchestrator *before*
 * rethrowing so the task lands in handoff_pending with snapshotted artifacts.
 * A failure inside reportLimit is swallowed — the original error is always
 * what the caller sees, because losing it would mask the real bug.
 */
export async function withAutoHandoff<T>(
  fn: () => Promise<T>,
  { client, taskId, isLimit }: WithAutoHandoffOptions,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const reason = isLimit(err);
    if (reason !== null) {
      try {
        await client.reportLimit(taskId, reason);
      } catch {
        // Intentionally swallowed — see docstring.
      }
    }
    throw err;
  }
}
