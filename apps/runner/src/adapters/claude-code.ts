import type { AgentAdapter } from "../adapters.js";
import { ShellPromptAdapter } from "./shell.js";

export function createClaudeAdapter(): AgentAdapter {
  return new ShellPromptAdapter({
    kind: "claude-code",
    defaultCommand: "claude",
    promptMode: "claude",
  });
}
