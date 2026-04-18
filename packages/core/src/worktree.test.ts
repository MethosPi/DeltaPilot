import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "./worktree.js";

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-wt-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# seed\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("WorktreeManager", () => {
  let repoRoot: string;
  let mgr: WorktreeManager;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    mgr = new WorktreeManager({
      repoRoot,
      workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
    });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("creates a worktree on a fresh branch forked from main", async () => {
    const { worktreePath, branchName } = await mgr.createWorktree("task-1");

    expect(existsSync(worktreePath)).toBe(true);
    expect(branchName).toBe("deltapilot/task/task-1");

    const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
    });
    expect(stdout.trim()).toBe(branchName);
  });

  it("preserves commits on the task branch across remove+attach (handoff simulation)", async () => {
    const { worktreePath, branchName } = await mgr.createWorktree("task-2");

    await writeFile(path.join(worktreePath, "work.txt"), "partial\n");
    await execa("git", ["add", "."], { cwd: worktreePath });
    await execa("git", ["commit", "-m", "wip"], { cwd: worktreePath });
    const originalHead = await mgr.currentHead("task-2");

    await mgr.removeWorktree("task-2", { keepBranch: true });
    expect(existsSync(worktreePath)).toBe(false);

    const reattached = await mgr.attachWorktree("task-2");
    expect(reattached.branchName).toBe(branchName);
    expect(existsSync(reattached.worktreePath)).toBe(true);

    const resumedHead = await mgr.currentHead("task-2");
    expect(resumedHead).toBe(originalHead);
  });

  it("rejects creating a worktree that already exists", async () => {
    await mgr.createWorktree("task-3");
    await expect(mgr.createWorktree("task-3")).rejects.toThrow(/already exists/);
  });

  it("removes worktree and deletes the task branch by default", async () => {
    await mgr.createWorktree("task-4");
    await mgr.removeWorktree("task-4");

    const { stdout } = await execa("git", ["branch", "--list", "deltapilot/task/task-4"], {
      cwd: repoRoot,
    });
    expect(stdout.trim()).toBe("");
  });
});
