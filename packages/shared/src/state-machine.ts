import type { TaskEvent, TaskStatus } from "./schemas.js";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly event: TaskEvent["kind"],
  ) {
    super(`Invalid transition: cannot apply ${event} to a task in state ${from}`);
    this.name = "InvalidTransitionError";
  }
}

type Transition = Partial<Record<TaskEvent["kind"], TaskStatus>>;

const TRANSITIONS: Record<TaskStatus, Transition> = {
  init: {
    ready: "todo",
    cancel: "cancelled",
  },
  todo: {
    claim: "in_progress",
    cancel: "cancelled",
  },
  in_progress: {
    submit_for_review: "review",
    report_limit: "handoff_pending",
    timeout: "handoff_pending",
    cancel: "cancelled",
  },
  handoff_pending: {
    claim: "in_progress",
    cancel: "cancelled",
  },
  review: {
    approve: "done",
    bounce: "todo",
    cancel: "cancelled",
  },
  done: {},
  cancelled: {},
};

export function nextStatus(current: TaskStatus, event: TaskEvent): TaskStatus {
  const candidate = TRANSITIONS[current][event.kind];
  if (!candidate) {
    throw new InvalidTransitionError(current, event.kind);
  }
  return candidate;
}

export function canTransition(current: TaskStatus, event: TaskEvent["kind"]): boolean {
  return TRANSITIONS[current][event] !== undefined;
}

export function allowedEvents(current: TaskStatus): ReadonlyArray<TaskEvent["kind"]> {
  return Object.keys(TRANSITIONS[current]) as TaskEvent["kind"][];
}
