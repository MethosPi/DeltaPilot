import type {
  Agent,
  AgentCostTier,
  AgentHealthState,
  AgentKind,
  AgentProviderFamily,
  AgentRole,
  HandoffReason,
  RoutingPolicy,
  Task,
  TaskAttempt,
  TaskBudget,
} from "@deltapilot/shared";

export interface AgentProfileDefaults {
  providerFamily: AgentProviderFamily;
  modelId: string | null;
  contextWindow: number | null;
  costTier: AgentCostTier;
  supportsTools: boolean;
  supportsPatch: boolean;
  supportsReview: boolean;
  maxConcurrency: number;
  fallbackPriority: number;
  healthState: AgentHealthState;
}

export interface BudgetSummary {
  totalCostUsd: number;
  totalAttempts: number;
  softCostRemainingUsd: number | null;
  hardCostRemainingUsd: number | null;
  softAttemptsRemaining: number | null;
  hardAttemptsRemaining: number | null;
  softExceeded: boolean;
  hardExceeded: boolean;
}

export interface RoutingCandidate {
  agent_id: string;
  score: number;
  blocked: boolean;
  reasons: string[];
}

const COST_TIER_RANK: Record<AgentCostTier, number> = {
  local: 0,
  low: 1,
  medium: 2,
  high: 3,
  premium: 4,
};

const DEFAULT_POLICIES: Record<AgentRole, RoutingPolicy> = {
  planner: {
    role: "planner",
    preferred_kinds: ["ollama", "codex", "claude-code", "claude-sdk", "openclaw", "other", "mock"],
    max_cost_tier: "high",
    large_context_only: false,
  },
  executor: {
    role: "executor",
    preferred_kinds: ["codex", "claude-code", "openclaw", "claude-sdk", "ollama", "other", "mock"],
    max_cost_tier: "premium",
    large_context_only: false,
  },
  reviewer: {
    role: "reviewer",
    preferred_kinds: ["claude-code", "codex", "openclaw", "claude-sdk", "ollama", "other", "mock"],
    max_cost_tier: "premium",
    large_context_only: false,
  },
  merger: {
    role: "merger",
    preferred_kinds: ["other", "mock", "codex", "claude-code", "openclaw", "ollama"],
    large_context_only: false,
  },
};

export function defaultAgentProfile(
  kind: AgentKind,
  role: AgentRole,
): AgentProfileDefaults {
  switch (kind) {
    case "codex":
      return {
        providerFamily: "openai",
        modelId: "codex",
        contextWindow: 200_000,
        costTier: "premium",
        supportsTools: true,
        supportsPatch: true,
        supportsReview: true,
        maxConcurrency: 1,
        fallbackPriority: role === "executor" ? 10 : 25,
        healthState: "healthy",
      };
    case "claude-code":
    case "claude-sdk":
      return {
        providerFamily: "anthropic",
        modelId: kind === "claude-sdk" ? "claude-sdk" : "claude-code",
        contextWindow: 200_000,
        costTier: "high",
        supportsTools: true,
        supportsPatch: true,
        supportsReview: true,
        maxConcurrency: 1,
        fallbackPriority: role === "reviewer" ? 10 : 20,
        healthState: "healthy",
      };
    case "openclaw":
      return {
        providerFamily: "openclaw",
        modelId: "openclaw",
        contextWindow: 128_000,
        costTier: "medium",
        supportsTools: true,
        supportsPatch: true,
        supportsReview: true,
        maxConcurrency: 1,
        fallbackPriority: 30,
        healthState: "healthy",
      };
    case "ollama":
      return {
        providerFamily: "ollama",
        modelId: "qwen2.5-coder:7b",
        contextWindow: 32_768,
        costTier: "local",
        supportsTools: false,
        supportsPatch: role === "executor" ? false : true,
        supportsReview: true,
        maxConcurrency: 1,
        fallbackPriority: role === "planner" ? 5 : 60,
        healthState: "healthy",
      };
    case "mock":
      return {
        providerFamily: "generic",
        modelId: "mock",
        contextWindow: 8_192,
        costTier: "low",
        supportsTools: true,
        supportsPatch: true,
        supportsReview: true,
        maxConcurrency: 1,
        fallbackPriority: 90,
        healthState: "healthy",
      };
    case "opendevin":
    case "hermes":
    case "other":
      return {
        providerFamily: "generic",
        modelId: kind,
        contextWindow: 64_000,
        costTier: "medium",
        supportsTools: true,
        supportsPatch: true,
        supportsReview: true,
        maxConcurrency: 1,
        fallbackPriority: 50,
        healthState: "healthy",
      };
  }
}

export function defaultRoutingPolicy(role: AgentRole): RoutingPolicy {
  return DEFAULT_POLICIES[role];
}

export function roleForTask(task: Task): AgentRole | null {
  switch (task.status) {
    case "todo":
    case "planning":
      return "planner";
    case "in_progress":
      return "executor";
    case "review":
      return "reviewer";
    case "merging":
      return "merger";
    default:
      return null;
  }
}

export function summarizeTaskBudget(
  budget: TaskBudget | null,
  attempts: ReadonlyArray<TaskAttempt>,
): BudgetSummary {
  const totalCostUsd = attempts.reduce((sum, attempt) => sum + (attempt.estimated_cost_usd ?? 0), 0);
  const totalAttempts = attempts.length;
  const softCostRemainingUsd = budget?.soft_cost_usd === undefined ? null : budget.soft_cost_usd - totalCostUsd;
  const hardCostRemainingUsd = budget?.hard_cost_usd === undefined ? null : budget.hard_cost_usd - totalCostUsd;
  const softAttemptsRemaining = budget?.soft_attempts === undefined ? null : budget.soft_attempts - totalAttempts;
  const hardAttemptsRemaining = budget?.hard_attempts === undefined ? null : budget.hard_attempts - totalAttempts;

  return {
    totalCostUsd,
    totalAttempts,
    softCostRemainingUsd,
    hardCostRemainingUsd,
    softAttemptsRemaining,
    hardAttemptsRemaining,
    softExceeded:
      (softCostRemainingUsd !== null && softCostRemainingUsd < 0)
      || (softAttemptsRemaining !== null && softAttemptsRemaining < 0),
    hardExceeded:
      (hardCostRemainingUsd !== null && hardCostRemainingUsd < 0)
      || (hardAttemptsRemaining !== null && hardAttemptsRemaining < 0),
  };
}

export function rankAgentsForTask(input: {
  task: Task;
  role: AgentRole;
  agents: ReadonlyArray<Agent>;
  attempts: ReadonlyArray<TaskAttempt>;
  activeAssignments?: Readonly<Record<string, number>>;
}): RoutingCandidate[] {
  const policy = defaultRoutingPolicy(input.role);
  const budget = summarizeTaskBudget(input.task.budget, input.attempts);
  const latestAttempt = [...input.attempts].sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;

  return input.agents
    .filter((agent) => agent.role === input.role)
    .map((agent) => {
      let score = 0;
      const reasons: string[] = [];
      let blocked = false;
      const load = input.activeAssignments?.[agent.id] ?? 0;

      if (!agent.enabled) {
        blocked = true;
        reasons.push("disabled");
      }
      if (agent.health_state === "offline") {
        blocked = true;
        reasons.push("offline");
      }
      if (load >= agent.max_concurrency) {
        blocked = true;
        reasons.push("at concurrency limit");
      }

      if (input.role === "executor" && !agent.supports_patch) {
        blocked = true;
        reasons.push("missing patch capability");
      }
      if (input.role === "reviewer" && !agent.supports_review) {
        blocked = true;
        reasons.push("missing review capability");
      }

      const preferenceIndex = policy.preferred_kinds.indexOf(agent.kind);
      if (preferenceIndex >= 0) {
        score += 200 - preferenceIndex * 20;
        reasons.push(`preferred for ${input.role}`);
      }

      score += Math.max(0, 120 - agent.fallback_priority);

      if (agent.health_state === "healthy") {
        score += 50;
        reasons.push("healthy");
      } else if (agent.health_state === "cooldown") {
        score -= 120;
        reasons.push("cooldown");
      } else if (agent.health_state === "degraded") {
        score -= 40;
        reasons.push("degraded");
      }

      score -= load * 25;

      if (budget.hardExceeded) {
        score += (4 - COST_TIER_RANK[agent.cost_tier]) * 25;
        reasons.push("hard budget exceeded, prefer cheaper worker");
      } else if (budget.softExceeded) {
        score += (4 - COST_TIER_RANK[agent.cost_tier]) * 12;
        reasons.push("soft budget exceeded, bias to cheaper worker");
      }

      if (input.role === "planner" && agent.kind === "ollama" && input.attempts.length === 0) {
        score += 35;
        reasons.push("cheap first-pass planner");
      }

      if (latestAttempt) {
        const sameAgent = latestAttempt.agent_id === agent.id;
        const previousCostRank = latestAttempt.provider === "ollama" ? COST_TIER_RANK.local : null;

        if (latestAttempt.handoff_reason === "rate_limit") {
          if (sameAgent) {
            score -= 400;
            reasons.push("same worker hit a rate limit");
          } else {
            score += 40;
            reasons.push("healthy peer after rate limit");
          }
        }

        if (latestAttempt.handoff_reason === "context_limit") {
          const context = agent.context_window ?? 0;
          score += Math.min(160, Math.floor(context / 2048));
          reasons.push("larger context preferred");
          if (sameAgent) {
            score -= 250;
            reasons.push("avoid repeating same context limit");
          }
        }

        if (latestAttempt.handoff_reason === "crash") {
          if (sameAgent) {
            blocked = true;
            reasons.push("previous attempt crashed on this worker");
          } else if (agent.kind !== "ollama") {
            score += 20;
            reasons.push("avoid crashed worker");
          }
        }

        if (latestAttempt.handoff_reason === "budget_exceeded") {
          score += (4 - COST_TIER_RANK[agent.cost_tier]) * 25;
          reasons.push("downgrade after budget exceed");
        }

        if (previousCostRank !== null && COST_TIER_RANK[agent.cost_tier] <= previousCostRank) {
          score += 5;
        }
      }

      return {
        agent_id: agent.id,
        score: blocked ? Number.NEGATIVE_INFINITY : score,
        blocked,
        reasons,
      };
    })
    .sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      return b.score - a.score;
    });
}
