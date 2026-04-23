import { describe, expect, it } from "vitest";
import {
  agentKindSchema,
  agentRoleSchema,
  agentRuntimeModeSchema,
  createTaskAcceptanceSchema,
  normalizeAcceptanceCriteria,
  normalizeTaskPriorityRank,
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

  it("rejects unknown kinds", () => {
    expect(() => agentKindSchema.parse("gpt-4")).toThrow();
  });
});

describe("new role/runtime/status schemas", () => {
  it("accepts reviewer role", () => {
    expect(agentRoleSchema.parse("reviewer")).toBe("reviewer");
  });

  it("accepts managed runtime", () => {
    expect(agentRuntimeModeSchema.parse("managed")).toBe("managed");
  });

  it("accepts human_review task status", () => {
    expect(taskStatusSchema.parse("human_review")).toBe("human_review");
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
