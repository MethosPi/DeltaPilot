import { describe, expect, it, vi } from "vitest";
import { withAutoHandoff, type HandoffClient, type HandoffReason } from "./interceptor.js";

function makeClient(): HandoffClient & { calls: Array<[string, HandoffReason]> } {
  const calls: Array<[string, HandoffReason]> = [];
  return {
    calls,
    reportLimit: vi.fn(async (taskId: string, reason: HandoffReason) => {
      calls.push([taskId, reason]);
    }),
  };
}

describe("withAutoHandoff", () => {
  it("returns the wrapped function's value when it succeeds", async () => {
    const client = makeClient();
    const result = await withAutoHandoff(async () => "ok", {
      client,
      taskId: "task-1",
      isLimit: () => null,
    });
    expect(result).toBe("ok");
    expect(client.reportLimit).not.toHaveBeenCalled();
  });

  it("calls reportLimit with the classified reason and rethrows when isLimit matches", async () => {
    const client = makeClient();
    const err = new Error("429 rate limited");
    await expect(
      withAutoHandoff(
        async () => {
          throw err;
        },
        {
          client,
          taskId: "task-2",
          isLimit: (e) => ((e as Error).message.includes("429") ? "rate_limit" : null),
        },
      ),
    ).rejects.toBe(err);
    expect(client.calls).toEqual([["task-2", "rate_limit"]]);
  });

  it("rethrows without calling reportLimit when isLimit returns null", async () => {
    const client = makeClient();
    const err = new Error("ECONNRESET");
    await expect(
      withAutoHandoff(
        async () => {
          throw err;
        },
        {
          client,
          taskId: "task-3",
          isLimit: () => null,
        },
      ),
    ).rejects.toBe(err);
    expect(client.reportLimit).not.toHaveBeenCalled();
  });

  it("still rethrows the original error when reportLimit itself fails", async () => {
    const originalErr = new Error("context window exceeded");
    const reportErr = new Error("transport closed");
    const client: HandoffClient = {
      reportLimit: vi.fn(async () => {
        throw reportErr;
      }),
    };
    await expect(
      withAutoHandoff(
        async () => {
          throw originalErr;
        },
        {
          client,
          taskId: "task-4",
          isLimit: () => "context_limit",
        },
      ),
    ).rejects.toBe(originalErr);
    expect(client.reportLimit).toHaveBeenCalledWith("task-4", "context_limit");
  });
});
