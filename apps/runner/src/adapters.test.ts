import { beforeEach, describe, expect, it } from "vitest";
import { MockAdapter } from "./adapters/mock.js";
import { getAdapter, registerAdapter, resetAdapters } from "./adapters.js";

beforeEach(() => {
  resetAdapters();
});

describe("adapter registry", () => {
  it("returns registered adapter by kind", () => {
    const mock = new MockAdapter({ result: { kind: "ok" } });
    registerAdapter("mock", () => mock);
    expect(getAdapter("mock")).toBe(mock);
  });

  it("throws on unknown kind", () => {
    expect(() => getAdapter("nonexistent-kind")).toThrow(/no adapter/i);
  });
});

describe("MockAdapter", () => {
  it("returns configured result", async () => {
    const adapter = new MockAdapter({ result: { kind: "error", message: "boom" } });
    const result = await adapter.execute({
      task: { id: "t1" } as never,
      worktreePath: "/tmp/x",
      repoRoot: "/tmp",
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(result).toEqual({ kind: "error", message: "boom" });
  });
});
