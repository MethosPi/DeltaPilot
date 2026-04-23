import { describe, expect, it } from "vitest";
import {
  agentKindSchema,
  agentSchema,
  agentRoleSchema,
  agentRuntimeModeSchema,
  createTaskAcceptanceSchema,
  humanReviewReasonSchema,
  normalizeAcceptanceCriteria,
  normalizeTaskBudget,
  taskAttemptSchema,
  taskBudgetSchema,
  normalizeTaskPriorityRank,
  taskPullRequestSchema,
  taskPriorityLabelFromRank,
  taskPriorityRankFromLabel,
  taskStatusSchema,
} from "./schemas.js";

describe("agentKindSchema", () => {
  it("accepts claude-sdk", () => {
    expect(agentKindSchema.parse("claude-sdk")).toBe("claude-sdk");
  });

  it("accepts openclaw", () => {
    expect(agentKindSchema.parse("openclaw")).toBe("openclaw");
  });

  it("accepts ollama", () => {
    expect(agentKindSchema.parse("ollama")).toBe("ollama");
  });

  it("rejects unknown kinds", () => {
    expect(() => agentKindSchema.parse("gpt-4")).toThrow();
  });
});

describe("new role/runtime/status schemas", () => {
  it("accepts merger role", () => {
    expect(agentRoleSchema.parse("merger")).toBe("merger");
  });

  it("accepts managed runtime", () => {
    expect(agentRuntimeModeSchema.parse("managed")).toBe("managed");
  });

  it("accepts human_review task status", () => {
    expect(taskStatusSchema.parse("human_review")).toBe("human_review");
  });

  it("accepts merging task status", () => {
    expect(taskStatusSchema.parse("merging")).toBe("merging");
  });

  it("accepts merge_conflict human review reason", () => {
    expect(humanReviewReasonSchema.parse("merge_conflict")).toBe("merge_conflict");
  });
});

describe("task priority helpers", () => {
  it("maps labels to numeric ranks", () => {
    expect(taskPriorityRankFromLabel("max")).toBe(100);
    expect(taskPriorityRankFromLabel("medium")).toBe(50);
  });

  it("maps arbitrary ranks back to the nearest label", () => {
    expect(taskPriorityLabelFromRank(82)).toBe("high");
    expect(taskPriorityLabelFromRank(12)).toBe("low");
    expect(normalizeTaskPriorityRank(82)).toBe(75);
  });
});

describe("createTaskAcceptanceSchema", () => {
  it("accepts deliverables-only payloads", () => {
    expect(
      createTaskAcceptanceSchema.parse({
        deliverables: ["task.md"],
      }),
    ).toEqual({
      deliverables: ["task.md"],
    });
  });
});

describe("normalizeAcceptanceCriteria", () => {
  it("normalizes legacy acceptancegoal payloads", () => {
    expect(
      normalizeAcceptanceCriteria({
        acceptancegoal: "Ship the task",
        deliverables: ["task.md"],
        files_in_scope: ["src/task.ts"],
      }),
    ).toEqual({
      goal: "Ship the task",
      deliverables: ["task.md"],
      files_in_scope: ["src/task.ts"],
    });
  });

  it("returns null for effectively empty acceptance payloads", () => {
    expect(normalizeAcceptanceCriteria({ deliverables: ["   "] })).toBeNull();
  });
});

describe("taskBudgetSchema", () => {
  it("accepts cost and attempt thresholds", () => {
    expect(taskBudgetSchema.parse({
      soft_cost_usd: 1.25,
      hard_attempts: 4,
    })).toEqual({
      soft_cost_usd: 1.25,
      hard_attempts: 4,
    });
  });

  it("normalizes valid raw budget payloads", () => {
    expect(normalizeTaskBudget({
      hard_cost_usd: 5,
    })).toEqual({
      hard_cost_usd: 5,
    });
  });
});

describe("taskPullRequestSchema", () => {
  it("accepts GitHub pull request metadata", () => {
    expect(taskPullRequestSchema.parse({
      provider: "github",
      base_branch: "main",
      head_branch: "deltapilot/task/123",
      head_sha: "abc123",
      number: 12,
      url: "https://github.com/example/repo/pull/12",
      review_decision: "APPROVED",
      merged_sha: null,
      last_synced_at: "2026-04-23T10:00:00.000Z",
      last_error: null,
    }).number).toBe(12);
  });
});

describe("agentSchema", () => {
  it("accepts capability and health fields", () => {
    expect(agentSchema.parse({
      id: "9d40a5b4-4f69-4d9e-b2c0-5fd1f7594ccb",
      name: "ollama-planner",
      kind: "ollama",
      role: "planner",
      runtime_mode: "managed",
      transport: "http",
      enabled: true,
      registered_at: "2026-04-23T10:00:00.000Z",
      last_seen_at: null,
      cooldown_until: null,
      last_limit_reason: null,
      provider_family: "ollama",
      model_id: "qwen2.5-coder:7b",
      context_window: 32768,
      cost_tier: "local",
      supports_tools: false,
      supports_patch: false,
      supports_review: true,
      max_concurrency: 1,
      fallback_priority: 20,
      health_state: "healthy",
    }).kind).toBe("ollama");
  });
});

describe("taskAttemptSchema", () => {
  it("accepts usage and checkpoint fields", () => {
    expect(taskAttemptSchema.parse({
      id: "a0ff40f7-6e7d-4122-bb6a-d1f5f1335b2d",
      task_id: "6fa86677-16b1-4832-adf9-4bbcb4bdd814",
      agent_id: "7abf39eb-416d-42fc-b1c4-6d937707fbbe",
      role: "executor",
      provider: "openai",
      model: "gpt-5.4",
      attempt_number: 2,
      started_at: "2026-04-23T10:00:00.000Z",
      ended_at: "2026-04-23T10:00:10.000Z",
      outcome: "handoff",
      handoff_reason: "rate_limit",
      prompt_tokens: 1200,
      completion_tokens: 450,
      estimated_cost_usd: 0.42,
      latency_ms: 9000,
      checkpoint_artifact_id: "b64f22e8-7765-4d4b-a449-ce4d6b4d7e70",
    }).outcome).toBe("handoff");
  });
});
