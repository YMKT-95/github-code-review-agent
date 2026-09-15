import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl } from '../src/github/pr-url.js';

describe('PR URL parsing', () => {
  it.each(['', '/', '?tab=files', '#discussion_r123'])('accepts standard URL suffix %s', (suffix) => {
    expect(parsePullRequestUrl(`https://github.com/octo-org/my.repo/pull/42${suffix}`)).toEqual({
      owner: 'octo-org', repository: 'my.repo', pullNumber: 42, url: 'https://github.com/octo-org/my.repo/pull/42',
    });
  });
  it.each([
    '', 'not a URL', 'http://github.com/o/r/pull/1', 'https://example.com/o/r/pull/1',
    'https://github.com.evil.test/o/r/pull/1', 'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/', 'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/-1', 'https://github.com/o/r/pull/1.5',
    'https://github.com/o/r/pull/9007199254740992', 'https://github.com/o/r/pull/42/files',
    'https://user:password@github.com/o/r/pull/1', 'https://github.com/o/../pull/1',
    'https://github.com/o/%2e%2e/pull/1', 'https://github.com/o/r/../r/pull/1',
    'https://github.com/o\\r/pull/1', 'https://github.com/o/r/pull/1\n',
  ])('rejects %j', (url) => expect(() => parsePullRequestUrl(url)).toThrow('Expected a GitHub pull-request URL'));
});
