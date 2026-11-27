// @ts-check
// A fact's commit, and where to see it on GitHub. No DOM.

const COMMIT_LINE = /^Commit: ([0-9a-f]{7,40})\b(?: on (\S+))?/m;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * The first `Commit: <sha>` line a worker wrote into its fact, with the branch when the line names one.
 * `Commit: none` is no commit.
 * @param {string} content
 * @returns {{ sha: string; branch: string | null } | null}
 */
export function commitOf(content) {
  const m = COMMIT_LINE.exec(content);
  return m ? { sha: m[1], branch: m[2] ?? null } : null;
}

/**
 * The commit's page on GitHub, for the goal's `Repo:` (owner/name); null when either is not the expected shape.
 * @param {string | null} repo
 * @param {string} sha
 */
export function githubCommitUrl(repo, sha) {
  if (!repo || repo.length > 100 || !REPO.test(repo) || !SHA.test(sha)) return null;
  return `https://github.com/${repo}/commit/${sha}`;
}
