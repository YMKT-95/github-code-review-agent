export type PullRequestReference = {
  owner: string;
  repository: string;
  pullNumber: number;
  url: string;
};

export const INVALID_PR_URL = 'Expected a GitHub pull-request URL such as: https://github.com/owner/repository/pull/42';

export function parsePullRequestUrl(input: string): PullRequestReference {
  if (input.trim() !== input) throw new Error(INVALID_PR_URL);
  // Match raw input first: URL normalisation must not accept traversal or backslashes.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?(?:[?#][^\s]*)?$/.exec(input);
  if (!match) throw new Error(INVALID_PR_URL);
  const [, owner, repository, number] = match;
  const pullNumber = Number(number);
  if (!owner || !repository || repository === '.' || repository === '..' || !Number.isSafeInteger(pullNumber)) {
    throw new Error(INVALID_PR_URL);
  }
  return { owner, repository, pullNumber, url: `https://github.com/${owner}/${repository}/pull/${pullNumber}` };
}
