import type { Agent, AgentRole, ApprovalRequestKind, Task } from "@deltapilot/shared";
import type { Orchestrator } from "@deltapilot/core";
import { createCodexAdapter } from "./adapters/codex.js";
import { createClaudeAdapter } from "./adapters/claude-code.js";
import { createOpenClawAdapter } from "./adapters/openclaw.js";
import { createOllamaAdapter } from "./adapters/ollama.js";

export interface AdapterContext {
  task: Task;
  worktreePath: string;
  repoRoot: string;
  signal: AbortSignal;
  log: (line: string) => void;
  agent?: Agent;
  agentRole?: AgentRole;
  sessionId?: string;
  orchestrator?: Orchestrator;
}

export interface AdapterResult {
  kind: "ok" | "error" | "rate_limit" | "context_limit" | "budget_exceeded" | "approval" | "question";
  message?: string;
  output?: string;
  decision?: "approve" | "bounce";
  approvalTitle?: string;
  approvalBody?: string;
  approvalKind?: ApprovalRequestKind;
}

export interface AgentAdapter {
  readonly kind: string;
  execute(ctx: AdapterContext): Promise<AdapterResult>;
}

type Factory = () => AgentAdapter;

const registry = new Map<string, Factory>();
const builtinRegistry = new Map<string, Factory>([
  ["codex", createCodexAdapter],
  ["claude-code", createClaudeAdapter],
  ["claude-sdk", createClaudeAdapter],
  ["openclaw", createOpenClawAdapter],
  ["ollama", createOllamaAdapter],
]);

export function registerAdapter(kind: string, factory: Factory): void {
  registry.set(kind, factory);
}

export function hasAdapter(kind: string): boolean {
  return registry.has(kind) || builtinRegistry.has(kind);
}

export function getAdapter(kind: string): AgentAdapter {
  const factory = registry.get(kind) ?? builtinRegistry.get(kind);
  if (!factory) throw new Error(`no adapter registered for kind "${kind}"`);
  return factory();
}

export function resetAdapters(): void {
  registry.clear();
}
