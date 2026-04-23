import { spawn } from "node:child_process";
import type { ReviewDecision } from "@deltapilot/shared";
import type { AdapterContext, AdapterResult, AgentAdapter } from "../adapters.js";
import { REVIEW_SCHEMA, buildPrompt, classifyFailure } from "./codex.js";

type PromptMode = "stdin" | "claude" | "ollama" | "flag-prompt";

export interface ShellPromptAdapterOptions {
  kind: string;
  defaultCommand: string;
  promptMode: PromptMode;
}

export class ShellPromptAdapter implements AgentAdapter {
  readonly kind: string;

  constructor(private readonly options: ShellPromptAdapterOptions) {
    this.kind = options.kind;
  }

  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    const prompt = await buildPrompt(ctx);
    const command = buildCommand(
      (ctx.agent?.command?.trim() || this.options.defaultCommand).trim(),
      this.options.promptMode,
      ctx.agentRole === "reviewer",
    );
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
        resolve(result);
      };

      const logChunk = (chunk: Buffer, sink: "stdout" | "stderr") => {
        const text = chunk.toString("utf8");
        if (sink === "stdout") stdout += text;
        else stderr += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          ctx.log(`[${this.kind}/${sink}] ${line}`);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => logChunk(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => logChunk(chunk, "stderr"));

      child.on("error", async (error) => {
        await finish({
          kind: classifyFailure(`${stderr}\n${stdout}\n${error.message}`),
          message: error.message,
        });
      });

      child.on("close", async (code) => {
        const combined = `${stdout}\n${stderr}`.trim();
        if (code !== 0) {
          await finish({
            kind: classifyFailure(combined),
            message: combined || `${this.kind} exited with status ${code ?? "unknown"}`,
          });
          return;
        }

        if (ctx.agentRole === "reviewer") {
          try {
            const parsed = parseReviewerOutput(combined);
            await finish({
              kind: "ok",
              decision: parsed.decision,
              output: parsed.note?.trim() || "No review note provided.",
            });
            return;
          } catch (error) {
            await finish({
              kind: "error",
              message: `failed to parse reviewer output: ${error instanceof Error ? error.message : String(error)}`,
            });
            return;
          }
        }

        await finish({
          kind: "ok",
          output: combined || undefined,
          message: combined || undefined,
        });
      });

      ctx.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      }, { once: true });

      child.stdin.end(prompt);
    });
  }
}

function buildCommand(base: string, mode: PromptMode, wantsJson: boolean): string {
  const reviewerInstruction = wantsJson
    ? `\n\nReply with JSON matching this schema exactly:\n${JSON.stringify(REVIEW_SCHEMA)}`
    : "";

  switch (mode) {
    case "stdin":
      return base;
    case "claude":
      return `prompt=$(cat); ${base} -p "$prompt${reviewerInstruction.replaceAll('"', '\\"')}"`;
    case "ollama":
      return `prompt=$(cat); ${base} "$prompt${reviewerInstruction.replaceAll('"', '\\"')}"`;
    case "flag-prompt":
      return `prompt=$(cat); ${base} --prompt "$prompt${reviewerInstruction.replaceAll('"', '\\"')}"`;
  }
}

function parseReviewerOutput(output: string): { decision: ReviewDecision; note?: string } {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = [output.trim(), ...lines.slice().reverse()];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { decision?: ReviewDecision; note?: string };
      if (parsed.decision === "approve" || parsed.decision === "bounce") {
        return {
          decision: parsed.decision,
          ...(parsed.note ? { note: parsed.note } : {}),
        };
      }
    } catch {
      // try next candidate
    }
  }

  throw new Error("missing review decision");
}
