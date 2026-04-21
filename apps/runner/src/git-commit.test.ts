import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitWorktree } from "./git-commit.js";

const run = promisify(execFile);

describe("commitWorktree", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "runner-git-"));
    await run("git", ["init", "-b", "main"], { cwd: dir });
    await run("git", ["config", "user.email", "runner@test"], { cwd: dir });
    await run("git", ["config", "user.name", "Runner Test"], { cwd: dir });
    await writeFile(path.join(dir, "a.txt"), "hello");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "seed"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when worktree has no changes", async () => {
    const sha = await commitWorktree({ worktreePath: dir, message: "noop" });
    expect(sha).toBeNull();
  });

  it("commits modified + new files and returns sha", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    await writeFile(path.join(dir, "b.txt"), "new");
    const sha = await commitWorktree({ worktreePath: dir, message: "runner: task X" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const { stdout } = await run("git", ["log", "-1", "--pretty=%s"], { cwd: dir });
    expect(stdout.trim()).toBe("runner: task X");
  });
});
