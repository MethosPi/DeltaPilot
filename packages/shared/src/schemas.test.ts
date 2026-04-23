import { describe, expect, it } from "vitest";
import { agentKindSchema, agentRoleSchema, agentRuntimeModeSchema, taskStatusSchema } from "./schemas.js";

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
