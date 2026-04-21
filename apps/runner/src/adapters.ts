import type { Task } from "@deltapilot/shared";

export interface AdapterContext {
  task: Task;
  worktreePath: string;
  repoRoot: string;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface AdapterResult {
  kind: "ok" | "error" | "rate_limit" | "context_limit";
  message?: string;
}

export interface AgentAdapter {
  readonly kind: string;
  execute(ctx: AdapterContext): Promise<AdapterResult>;
}

type Factory = () => AgentAdapter;

const registry = new Map<string, Factory>();

export function registerAdapter(kind: string, factory: Factory): void {
  registry.set(kind, factory);
}

export function getAdapter(kind: string): AgentAdapter {
  const factory = registry.get(kind);
  if (!factory) throw new Error(`no adapter registered for kind "${kind}"`);
  return factory();
}

export function resetAdapters(): void {
  registry.clear();
}
