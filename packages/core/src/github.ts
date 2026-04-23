import { execa } from "execa";
import type { AcceptanceCriteria, GithubPullRequestReviewDecision, TaskPullRequest } from "@deltapilot/shared";

export interface GitHubEnsurePullRequestInput {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  baseBranch?: string;
  title: string;
  body: string;
}

export interface GitHubPullRequestLookupInput {
  repoRoot: string;
  branchName: string;
  baseBranch?: string;
}

export interface GitHubRebaseInput {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  baseBranch?: string;
}

export interface GitHubMergeInput {
  repoRoot: string;
  pullRequestNumber: number;
  baseBranch?: string;
}

export interface GitHubHumanReviewPacketInput {
  worktreePath: string;
  branchName: string;
  acceptance: AcceptanceCriteria | null;
  reviewNote: string | null;
  diffStat: string;
  pullRequest: TaskPullRequest;
}

export interface GitHubHelper {
  ensurePullRequest(input: GitHubEnsurePullRequestInput): Promise<TaskPullRequest>;
  readPullRequest(input: GitHubPullRequestLookupInput): Promise<TaskPullRequest | null>;
  diffStat(worktreePath: string, baseBranch?: string): Promise<string>;
  rebaseBranch(input: GitHubRebaseInput): Promise<{ headSha: string }>;
  mergePullRequest(input: GitHubMergeInput): Promise<{ mergedSha: string }>;
  buildHumanReviewPacket(input: GitHubHumanReviewPacketInput): string;
}

interface GhPullRequestJson {
  number?: number;
  url?: string;
  reviewDecision?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
}

export class GitHubCliHelper implements GitHubHelper {
  async ensurePullRequest(input: GitHubEnsurePullRequestInput): Promise<TaskPullRequest> {
    const baseBranch = input.baseBranch ?? "main";
    await execa("git", ["push", "--set-upstream", "origin", `HEAD:${input.branchName}`], {
      cwd: input.worktreePath,
    });

    const existing = await this.readPullRequest({
      repoRoot: input.repoRoot,
      branchName: input.branchName,
      baseBranch,
    });

    if (existing?.number) {
      await execa("gh", ["pr", "edit", String(existing.number), "--title", input.title, "--body", input.body], {
        cwd: input.repoRoot,
      });
    } else {
      await execa(
        "gh",
        ["pr", "create", "--base", baseBranch, "--head", input.branchName, "--title", input.title, "--body", input.body],
        { cwd: input.repoRoot },
      );
    }

    const refreshed = await this.readPullRequest({
      repoRoot: input.repoRoot,
      branchName: input.branchName,
      baseBranch,
    });
    if (!refreshed) {
      throw new Error(`Failed to create or locate pull request for branch ${input.branchName}`);
    }
    return refreshed;
  }

  async readPullRequest(input: GitHubPullRequestLookupInput): Promise<TaskPullRequest | null> {
    const baseBranch = input.baseBranch ?? "main";
    const { stdout } = await execa(
      "gh",
      ["pr", "list", "--state", "open", "--head", input.branchName, "--base", baseBranch, "--json", "number,url,reviewDecision,headRefName,headRefOid,baseRefName"],
      { cwd: input.repoRoot },
    );
    const items = JSON.parse(stdout) as GhPullRequestJson[];
    const pr = items[0];
    if (!pr?.number) return null;
    return {
      provider: "github",
      base_branch: pr.baseRefName || baseBranch,
      head_branch: pr.headRefName || input.branchName,
      head_sha: pr.headRefOid ?? null,
      number: pr.number,
      url: pr.url ?? null,
      review_decision: normalizeReviewDecision(pr.reviewDecision),
      merged_sha: null,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    };
  }

  async diffStat(worktreePath: string, baseBranch = "main"): Promise<string> {
    const { stdout } = await execa("git", ["diff", "--stat", `${baseBranch}...HEAD`], {
      cwd: worktreePath,
      reject: false,
    });
    return stdout.trim() || "No diff stat available.";
  }

  async rebaseBranch(input: GitHubRebaseInput): Promise<{ headSha: string }> {
    const baseBranch = input.baseBranch ?? "main";
    await execa("git", ["fetch", "origin", baseBranch], { cwd: input.worktreePath });
    try {
      await execa("git", ["rebase", `origin/${baseBranch}`], { cwd: input.worktreePath });
    } catch (error) {
      await execa("git", ["rebase", "--abort"], { cwd: input.worktreePath, reject: false });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Rebase onto origin/${baseBranch} failed: ${message}`);
    }
    await execa("git", ["push", "--force-with-lease", "origin", `HEAD:${input.branchName}`], {
      cwd: input.worktreePath,
    });
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: input.worktreePath,
    });
    return { headSha: stdout.trim() };
  }

  async mergePullRequest(input: GitHubMergeInput): Promise<{ mergedSha: string }> {
    const baseBranch = input.baseBranch ?? "main";
    await execa("gh", ["pr", "merge", String(input.pullRequestNumber), "--merge"], {
      cwd: input.repoRoot,
    });
    await execa("git", ["fetch", "origin", baseBranch], { cwd: input.repoRoot });
    const { stdout } = await execa("git", ["rev-parse", `origin/${baseBranch}`], {
      cwd: input.repoRoot,
    });
    return { mergedSha: stdout.trim() };
  }

  buildHumanReviewPacket(input: GitHubHumanReviewPacketInput): string {
    const lines = [
      "# Human Review Packet",
      "",
      `PR: ${input.pullRequest.url ?? "Unavailable"}${input.pullRequest.number ? ` (#${input.pullRequest.number})` : ""}`,
      `Branch: ${input.branchName}`,
      `Head SHA: ${input.pullRequest.head_sha ?? "Unavailable"}`,
      `Review decision: ${input.pullRequest.review_decision ?? "REVIEW_REQUIRED"}`,
      `Worktree path: ${input.worktreePath}`,
      "",
      "## Diff Summary",
      "",
      input.diffStat,
      "",
      "## Reviewer Note",
      "",
      input.reviewNote?.trim() || "No reviewer note provided.",
      "",
      "## Local Verification",
      "",
      `cd ${input.worktreePath}`,
      input.acceptance?.success_test ? `Run: ${input.acceptance.success_test}` : null,
      `Fallback checkout: git fetch origin ${input.branchName} && git switch --track origin/${input.branchName}`,
    ].filter((line): line is string => line !== null);

    return lines.join("\n");
  }
}

function normalizeReviewDecision(value: string | null | undefined): GithubPullRequestReviewDecision {
  switch (value) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "REVIEW_REQUIRED":
    case "COMMENTED":
      return value;
    default:
      return "UNKNOWN";
  }
}
