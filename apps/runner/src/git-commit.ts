import { simpleGit } from "simple-git";

export interface CommitWorktreeInput {
  worktreePath: string;
  message: string;
  author?: { name: string; email: string };
}

export async function commitWorktree(input: CommitWorktreeInput): Promise<string | null> {
  const git = simpleGit({ baseDir: input.worktreePath });
  const status = await git.status();
  if (status.isClean()) return null;
  await git.add(["-A"]);
  // simple-git's .env(obj) REPLACES the entire env (not merges) — line 4394 of the cjs
  // bundle: `this._executor.env = name`. Passing an empty object would strip PATH/HOME
  // and break git. When no author override is needed we skip .env() entirely so the
  // child process inherits process.env via Node's default (env: undefined → inherit).
  // When an author IS supplied we spread process.env first to preserve the inherited
  // environment, then overlay only the author/committer vars.
  const runner = input.author
    ? git.env({
        ...process.env,
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_COMMITTER_NAME: input.author.name,
        GIT_COMMITTER_EMAIL: input.author.email,
      })
    : git;
  await runner.commit(input.message);
  const sha = (await git.revparse(["HEAD"])).trim();
  return sha;
}
