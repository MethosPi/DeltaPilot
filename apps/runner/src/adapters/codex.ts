import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewDecision } from "@deltapilot/shared";
import type { AdapterContext, AdapterResult, AgentAdapter } from "../adapters.js";

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "note"],
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "bounce"],
    },
    note: {
      type: "string",
      minLength: 1,
    },
  },
} as const;

export class CodexCliAdapter implements AgentAdapter {
  readonly kind = "codex";

  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    const runtimeDir = path.join(ctx.repoRoot, ".deltapilot", "runner-tmp");
    await mkdir(runtimeDir, { recursive: true });

    const runId = `${ctx.sessionId ?? crypto.randomUUID()}-${ctx.agentRole ?? "agent"}`;
    const outputPath = path.join(runtimeDir, `${runId}.last.txt`);
    const schemaPath = path.join(runtimeDir, `${runId}.schema.json`);
    const prompt = await buildPrompt(ctx);
    if (ctx.agentRole === "reviewer") {
      await writeFile(schemaPath, JSON.stringify(REVIEW_SCHEMA, null, 2), "utf8");
    }
    const command = buildCommand(ctx, outputPath, schemaPath);
    const shell = process.env.SHELL || "/bin/zsh";

    let stdout = "";
    let stderr = "";
    let settled = false;

    return new Promise<AdapterResult>((resolve) => {
      const child = spawn(shell, ["-lc", command], {
        cwd: ctx.worktreePath,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (ctx.sessionId && ctx.orchestrator) {
        ctx.orchestrator.updateAgentSession(ctx.sessionId, { pid: child.pid ?? null });
      }

      const finish = async (result: AdapterResult) => {
        if (settled) return;
        settled = true;
        if (ctx.sessionId && ctx.orchestrator) {
          ctx.orchestrator.updateAgentSession(ctx.sessionId, { pid: null });
        }
        await rm(schemaPath, { force: true }).catch(() => undefined);
        resolve(result);
      };

      const logChunk = (chunk: Buffer, sink: "stdout" | "stderr") => {
        const text = chunk.toString("utf8");
        if (sink === "stdout") stdout += text;
        else stderr += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          ctx.log(`[codex/${sink}] ${line}`);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => logChunk(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => logChunk(chunk, "stderr"));

      child.on("error", async (error) => {
        await finish({ kind: classifyFailure(`${stderr}\n${stdout}\n${error.message}`), message: error.message });
      });

      child.on("close", async (code) => {
        const lastMessage = await readFile(outputPath, "utf8").catch(() => "");
        await rm(outputPath, { force: true }).catch(() => undefined);

        if (code !== 0) {
          const combined = `${stderr}\n${stdout}\n${lastMessage}`.trim();
          await finish({
            kind: classifyFailure(combined),
            message: combined || `codex exited with status ${code ?? "unknown"}`,
          });
          return;
        }

        if (ctx.agentRole === "reviewer") {
          try {
            const parsed = JSON.parse(lastMessage || "{}") as { decision?: ReviewDecision; note?: string };
            if (parsed.decision !== "approve" && parsed.decision !== "bounce") {
              throw new Error("missing review decision");
            }
            await finish({
              kind: "ok",
              decision: parsed.decision,
              output: parsed.note?.trim() || "No review note provided.",
            });
            return;
          } catch (error) {
            await finish({
              kind: "error",
              message: `failed to parse codex reviewer output: ${error instanceof Error ? error.message : String(error)}`,
            });
            return;
          }
        }

        await finish({
          kind: "ok",
          output: lastMessage.trim() || stdout.trim() || undefined,
          message: lastMessage.trim() || stdout.trim() || undefined,
        });
      });

      ctx.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      }, { once: true });

      child.stdin.end(prompt);
    });
  }
}

function buildCommand(ctx: AdapterContext, outputPath: string, schemaPath: string): string {
  const base = (ctx.agent?.command?.trim() || "codex").trim();
  const args = [
    "exec",
    "--cd", sh(ctx.worktreePath),
    "--color", "never",
    "--ephemeral",
    "--output-last-message", sh(outputPath),
  ];

  if (ctx.agentRole === "executor") {
    args.push("--full-auto");
  } else {
    args.push("--sandbox", ctx.agentRole === "reviewer" ? "read-only" : "read-only");
  }

  if (ctx.agentRole === "reviewer") {
    args.push("--output-schema", sh(schemaPath));
  }

  args.push("-");
  return `${base} ${args.join(" ")}`;
}

async function buildPrompt(ctx: AdapterContext): Promise<string> {
  const acceptance = formatAcceptance(ctx.task.acceptance);
  const plan = ctx.orchestrator
    ? await ctx.orchestrator.readArtifact(ctx.task.id, "execution_plan")
    : null;

  const common = [
    `Task ID: ${ctx.task.id}`,
    `Title: ${ctx.task.title}`,
    `Brief: ${ctx.task.brief || "(empty)"}`,
    `Current status: ${ctx.task.status}`,
    `Worktree path: ${ctx.worktreePath}`,
    acceptance,
    plan?.trim() ? `Execution plan:\n${plan.trim()}` : "",
  ].filter(Boolean).join("\n\n");

  switch (ctx.agentRole) {
    case "planner":
      return [
        "You are the DeltaPipeline planner agent.",
        "Read the task and return only a concise execution plan in Markdown.",
        "Do not modify files. Do not create commits. Do not ask questions unless absolutely blocked.",
        common,
      ].join("\n\n");
    case "executor":
      return [
        "You are the DeltaPipeline executor agent.",
        "Implement the task in the current git worktree.",
        "Use the existing plan if provided.",
        "Do not create commits or branches; DeltaPipeline will commit after you finish.",
        "At the end, return a short summary of what you changed and any tests you ran.",
        common,
      ].join("\n\n");
    case "reviewer":
      return [
        "You are the DeltaPipeline reviewer agent.",
        "Inspect the worktree, compare it against the task acceptance criteria, and decide whether the task is complete.",
        "Return JSON matching the provided schema with:",
        '- `decision`: "approve" if complete, otherwise "bounce"',
        "- `note`: a concise justification. If bouncing, include concrete missing work.",
        "Be strict: bounce if acceptance is not clearly met.",
        common,
      ].join("\n\n");
    default:
      return [
        "You are a DeltaPipeline agent.",
        common,
      ].join("\n\n");
  }
}

function formatAcceptance(acceptance: AdapterContext["task"]["acceptance"]): string {
  if (!acceptance) return "Acceptance criteria: none provided.";
  const parts = [
    acceptance.goal ? `Acceptance goal: ${acceptance.goal}` : null,
    acceptance.deliverables.length > 0
      ? `Deliverables:\n${acceptance.deliverables.map((item) => `- ${item}`).join("\n")}`
      : null,
    acceptance.files_in_scope.length > 0
      ? `Files in scope:\n${acceptance.files_in_scope.map((item) => `- ${item}`).join("\n")}`
      : null,
    acceptance.success_test ? `Success test: ${acceptance.success_test}` : null,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join("\n") : "Acceptance criteria: none provided.";
}

function classifyFailure(message: string): AdapterResult["kind"] {
  if (/rate.?limit/i.test(message)) return "rate_limit";
  if (/context length|context window|too much context/i.test(message)) return "context_limit";
  return "error";
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createCodexAdapter(): AgentAdapter {
  return new CodexCliAdapter();
}

export { REVIEW_SCHEMA };
