import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

import { GitHubCliHelper } from "./github.js";

describe("GitHubCliHelper", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("finds merged pull requests and preserves their merge commit", async () => {
    execaMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 1,
          url: "https://github.com/example/repo/pull/1",
          reviewDecision: "",
          headRefName: "deltapilot/task/one",
          headRefOid: "head-sha",
          baseRefName: "main",
          state: "MERGED",
          mergedAt: "2026-04-23T11:57:18Z",
          mergeCommit: { oid: "merge-sha" },
        },
      ]),
    });

    const helper = new GitHubCliHelper();
    const pullRequest = await helper.readPullRequest({
      repoRoot: "/repo",
      branchName: "deltapilot/task/one",
      baseBranch: "main",
    });

    expect(execaMock).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "deltapilot/task/one",
        "--base",
        "main",
        "--json",
        "number,url,reviewDecision,headRefName,headRefOid,baseRefName,state,mergedAt,mergeCommit",
      ],
      { cwd: "/repo" },
    );
    expect(pullRequest?.merged_sha).toBe("merge-sha");
    expect(pullRequest?.review_decision).toBe("UNKNOWN");
  });
});
