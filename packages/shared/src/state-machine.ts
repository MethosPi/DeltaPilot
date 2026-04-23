import type { ReviewDecision, TaskEvent, TaskStatus } from "./schemas.js";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly event: TaskEvent["kind"],
  ) {
    super(`Invalid transition: cannot apply ${event} to a task in state ${from}`);
    this.name = "InvalidTransitionError";
  }
}

type StaticEventKind = Exclude<TaskEvent["kind"], "review_decision" | "merge_result">;
type Transition = Partial<Record<StaticEventKind, TaskStatus>>;

const STATIC_TRANSITIONS: Record<TaskStatus, Transition> = {
  todo: {
    start_planning: "planning",
    cancel: "cancelled",
    claim: "planning",
  },
  planning: {
    start_planning: "planning",
    plan_ready: "in_progress",
    report_limit: "planning",
    cancel: "cancelled",
  },
  in_progress: {
    start_execution: "in_progress",
    execution_ready: "review",
    report_limit: "in_progress",
    submit_for_review: "review",
    cancel: "cancelled",
  },
  review: {
    start_review: "review",
    enter_human_review: "human_review",
    report_limit: "review",
    approve: "human_review",
    bounce: "todo",
    cancel: "cancelled",
  },
  human_review: {
    return_to_todo: "todo",
    queue_merge: "merging",
    cancel: "cancelled",
  },
  merging: {
    start_merge: "merging",
    report_limit: "merging",
    cancel: "cancelled",
  },
  done: {},
  cancelled: {},
};

function reviewDecisionTarget(decision: ReviewDecision): TaskStatus {
  return decision === "approve" ? "human_review" : "todo";
}

function mergeResultTarget(event: Extract<TaskEvent, { kind: "merge_result" }>): TaskStatus {
  return event.result === "merged" ? "done" : "human_review";
}

export function nextStatus(current: TaskStatus, event: TaskEvent): TaskStatus {
  if (event.kind === "review_decision") {
    if (current !== "review") {
      throw new InvalidTransitionError(current, event.kind);
    }
    return reviewDecisionTarget(event.decision);
  }

  if (event.kind === "merge_result") {
    if (current !== "merging") {
      throw new InvalidTransitionError(current, event.kind);
    }
    return mergeResultTarget(event);
  }

  const candidate = STATIC_TRANSITIONS[current][event.kind as StaticEventKind];
  if (!candidate) {
    throw new InvalidTransitionError(current, event.kind);
  }
  return candidate;
}

export function canTransition(current: TaskStatus, event: TaskEvent["kind"]): boolean {
  if (event === "review_decision") {
    return current === "review";
  }
  if (event === "merge_result") {
    return current === "merging";
  }
  return STATIC_TRANSITIONS[current][event as StaticEventKind] !== undefined;
}

export function allowedEvents(current: TaskStatus): ReadonlyArray<TaskEvent["kind"]> {
  const base = Object.keys(STATIC_TRANSITIONS[current]) as TaskEvent["kind"][];
  if (current === "review") {
    return [...base, "review_decision"];
  }
  if (current === "merging") {
    return [...base, "merge_result"];
  }
  return base;
}
