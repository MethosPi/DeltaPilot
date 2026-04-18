import { execa } from "execa";
import { existsSync } from "node:fs";
import path from "node:path";

export interface WorktreeManagerOptions {
  /** Path to the target git repository (the one holding user code). */
  repoRoot: string;
  /** Directory under which per-task worktrees are placed. Usually `<repoRoot>/.deltapilot/workspaces`. */
  workspacesDir: string;
  /** Branch to fork new task branches from. Defaults to "main". */
  baseBranch?: string;
}

export interface CreateWorktreeResult {
  taskId: string;
  branchName: string;
  worktreePath: string;
}

export class WorktreeManager {
  readonly repoRoot: string;
  readonly workspacesDir: string;
  readonly baseBranch: string;

  constructor(opts: WorktreeManagerOptions) {
    this.repoRoot = opts.repoRoot;
    this.workspacesDir = opts.workspacesDir;
    this.baseBranch = opts.baseBranch ?? "main";
  }

  pathFor(taskId: string): string {
    return path.join(this.workspacesDir, taskId);
  }

  branchFor(taskId: string): string {
    return `deltapilot/task/${taskId}`;
  }

  async createWorktree(taskId: string): Promise<CreateWorktreeResult> {
    const worktreePath = this.pathFor(taskId);
    const branchName = this.branchFor(taskId);

    if (existsSync(worktreePath)) {
      throw new Error(`worktree already exists at ${worktreePath}`);
    }

    await execa(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath, this.baseBranch],
      { cwd: this.repoRoot },
    );

    return { taskId, branchName, worktreePath };
  }

  /**
   * Reattach an existing branch to a fresh worktree (used when a handed-off task is claimed
   * by a new agent and the previous worktree has been cleaned up).
   */
  async attachWorktree(taskId: string): Promise<CreateWorktreeResult> {
    const worktreePath = this.pathFor(taskId);
    const branchName = this.branchFor(taskId);

    if (existsSync(worktreePath)) {
      return { taskId, branchName, worktreePath };
    }

    await execa("git", ["worktree", "add", worktreePath, branchName], { cwd: this.repoRoot });
    return { taskId, branchName, worktreePath };
  }

  async removeWorktree(taskId: string, opts: { keepBranch?: boolean } = {}): Promise<void> {
    const worktreePath = this.pathFor(taskId);

    if (existsSync(worktreePath)) {
      await execa("git", ["worktree", "remove", "--force", worktreePath], { cwd: this.repoRoot });
    }

    if (!opts.keepBranch) {
      const branchName = this.branchFor(taskId);
      await execa("git", ["branch", "-D", branchName], {
        cwd: this.repoRoot,
        reject: false,
      });
    }
  }

  async currentHead(taskId: string): Promise<string> {
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: this.pathFor(taskId),
    });
    return stdout.trim();
  }
}
