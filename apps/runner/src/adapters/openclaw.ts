import type { AgentAdapter } from "../adapters.js";
import { ShellPromptAdapter } from "./shell.js";

export function createOpenClawAdapter(): AgentAdapter {
  return new ShellPromptAdapter({
    kind: "openclaw",
    defaultCommand: "openclaw gateway start",
    promptMode: "flag-prompt",
  });
}
