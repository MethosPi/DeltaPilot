import { describe, it, expect } from "vitest";
import { nextStatus, canTransition, allowedEvents, InvalidTransitionError } from "./state-machine.js";
import type { TaskEvent, TaskStatus } from "./schemas.js";

const agentId = "11111111-1111-1111-1111-111111111111";

describe("state machine — golden path", () => {
  it("walks init → todo → in_progress → review → done", () => {
    let s: TaskStatus = "init";
    s = nextStatus(s, { kind: "ready" });
    expect(s).toBe("todo");
    s = nextStatus(s, { kind: "claim", agent_id: agentId });
    expect(s).toBe("in_progress");
    s = nextStatus(s, { kind: "submit_for_review" });
    expect(s).toBe("review");
    s = nextStatus(s, { kind: "approve" });
    expect(s).toBe("done");
  });
});

describe("state machine — handoff path", () => {
  it("moves in_progress → handoff_pending on report_limit then back to in_progress on claim", () => {
    let s: TaskStatus = "in_progress";
    s = nextStatus(s, { kind: "report_limit", reason: "rate_limit" });
    expect(s).toBe("handoff_pending");
    s = nextStatus(s, { kind: "claim", agent_id: agentId });
    expect(s).toBe("in_progress");
  });

  it("treats heartbeat timeout the same as report_limit for routing", () => {
    const s = nextStatus("in_progress", { kind: "timeout" });
    expect(s).toBe("handoff_pending");
  });
});

describe("state machine — review bounce", () => {
  it("returns bounced task to todo so any agent can reclaim", () => {
    const s = nextStatus("review", { kind: "bounce", note: "missing tests" });
    expect(s).toBe("todo");
  });
});

describe("state machine — terminal states", () => {
  it.each<TaskStatus>(["done", "cancelled"])("%s accepts no further events", (terminal) => {
    expect(allowedEvents(terminal)).toHaveLength(0);
    expect(() => nextStatus(terminal, { kind: "claim", agent_id: agentId })).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("state machine — cancellation", () => {
  it.each<TaskStatus>(["init", "todo", "in_progress", "handoff_pending", "review"])(
    "cancels from non-terminal %s",
    (from) => {
      expect(nextStatus(from, { kind: "cancel" })).toBe("cancelled");
    },
  );
});

describe("state machine — invalid transitions", () => {
  it("rejects claim from init", () => {
    expect(() => nextStatus("init", { kind: "claim", agent_id: agentId })).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects approve from in_progress", () => {
    expect(() => nextStatus("in_progress", { kind: "approve" })).toThrow(InvalidTransitionError);
  });

  it("rejects submit_for_review from handoff_pending", () => {
    expect(() => nextStatus("handoff_pending", { kind: "submit_for_review" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("canTransition returns false for forbidden event", () => {
    expect(canTransition("todo", "approve")).toBe(false);
    expect(canTransition("todo", "claim")).toBe(true);
  });
});

describe("state machine — event payload surface", () => {
  it("carries metadata through but doesn't affect transition", () => {
    const claim: TaskEvent = { kind: "claim", agent_id: agentId };
    expect(nextStatus("todo", claim)).toBe("in_progress");
    expect(nextStatus("handoff_pending", claim)).toBe("in_progress");
  });
});
