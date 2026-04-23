import type { AgentAdapter } from "../adapters.js";
import { ShellPromptAdapter } from "./shell.js";

export function createOllamaAdapter(): AgentAdapter {
  return new ShellPromptAdapter({
    kind: "ollama",
    defaultCommand: "ollama run qwen2.5-coder:7b",
    promptMode: "ollama",
  });
}
