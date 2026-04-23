import { describe, expect, it } from "vitest";
import { allowedEvents, canTransition, InvalidTransitionError, nextStatus } from "./state-machine.js";
import type { TaskEvent, TaskStatus } from "./schemas.js";

const agentId = "11111111-1111-1111-1111-111111111111";

describe("state machine — planner/executor/reviewer flow", () => {
  it("walks todo -> planning -> in_progress -> review -> human_review -> merging -> done", () => {
    let s: TaskStatus = "todo";
    s = nextStatus(s, { kind: "start_planning", agent_id: agentId });
    expect(s).toBe("planning");
    s = nextStatus(s, { kind: "plan_ready" });
    expect(s).toBe("in_progress");
    s = nextStatus(s, { kind: "start_execution", agent_id: agentId });
    expect(s).toBe("in_progress");
    s = nextStatus(s, { kind: "execution_ready" });
    expect(s).toBe("review");
    s = nextStatus(s, { kind: "review_decision", decision: "approve" });
    expect(s).toBe("human_review");
    s = nextStatus(s, { kind: "queue_merge" });
    expect(s).toBe("merging");
    s = nextStatus(s, { kind: "start_merge", agent_id: agentId });
    expect(s).toBe("merging");
    s = nextStatus(s, { kind: "merge_result", result: "merged" });
    expect(s).toBe("done");
  });
});

describe("state machine — retries and escalation", () => {
  it("keeps a planning handoff in planning", () => {
    expect(nextStatus("planning", { kind: "report_limit", reason: "rate_limit" })).toBe("planning");
  });

  it("returns bounced review tasks to todo", () => {
    expect(nextStatus("review", { kind: "review_decision", decision: "bounce", note: "missing tests" })).toBe("todo");
  });

  it("allows human_review -> todo reset", () => {
    expect(nextStatus("human_review", { kind: "return_to_todo", note: "approved retry" })).toBe("todo");
  });

  it("allows merge failures to return to human_review", () => {
    expect(nextStatus("merging", { kind: "merge_result", result: "blocked", note: "conflict" })).toBe("human_review");
    expect(nextStatus("merging", { kind: "merge_result", result: "reapproval_required" })).toBe("human_review");
  });
});

describe("state machine — terminal states", () => {
  it.each<TaskStatus>(["done", "cancelled"])("%s accepts no further events", (terminal) => {
    expect(allowedEvents(terminal)).toHaveLength(0);
    expect(() => nextStatus(terminal, { kind: "start_execution", agent_id: agentId })).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("state machine — cancellation", () => {
  it.each<TaskStatus>(["todo", "planning", "in_progress", "review", "human_review", "merging"])(
    "cancels from non-terminal %s",
    (from) => {
      expect(nextStatus(from, { kind: "cancel" })).toBe("cancelled");
    },
  );
});

describe("state machine — invalid transitions", () => {
  it("rejects execution_ready from planning", () => {
    expect(() => nextStatus("planning", { kind: "execution_ready" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects review_decision from in_progress", () => {
    expect(() => nextStatus("in_progress", { kind: "review_decision", decision: "approve" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects merge_result outside merging", () => {
    expect(() => nextStatus("review", { kind: "merge_result", result: "merged" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("canTransition reflects review decision routing", () => {
    expect(canTransition("todo", "review_decision")).toBe(false);
    expect(canTransition("review", "review_decision")).toBe(true);
  });
});

describe("state machine — legacy compatibility events", () => {
  it("still accepts legacy claim + submit_for_review", () => {
    const claim: TaskEvent = { kind: "claim", agent_id: agentId };
    expect(nextStatus("todo", claim)).toBe("planning");
    expect(nextStatus("in_progress", { kind: "submit_for_review" })).toBe("review");
  });
});
