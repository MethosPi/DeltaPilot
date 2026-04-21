import { describe, expect, it } from "vitest";
import { agentKindSchema } from "./schemas.js";

describe("agentKindSchema", () => {
  it("accepts claude-sdk", () => {
    expect(agentKindSchema.parse("claude-sdk")).toBe("claude-sdk");
  });

  it("rejects unknown kinds", () => {
    expect(() => agentKindSchema.parse("gpt-4")).toThrow();
  });
});
