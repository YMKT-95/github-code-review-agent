import { describe, expect, it } from 'vitest';
import { GitHubReadAdapter } from '../src/github/tool-adapter.js';
import { parsePullRequestUrl } from '../src/github/pr-url.js';
import { mockConnection, readTool, textResult } from './fixtures/mcp.js';
import { initialContext } from './fixtures/agent.js';

const pr = parsePullRequestUrl('https://github.com/owner/repository/pull/42');
const fileTool = { name: 'get_file_contents', inputSchema: { properties: { owner: {}, repo: {}, path: {}, ref: {} } }, annotations: { readOnlyHint: true } };
const searchTool = { name: 'search_code', inputSchema: { properties: { query: {}, page: {}, perPage: {} } }, annotations: { readOnlyHint: true } };
async function setup() {
  const connection = mockConnection();
  connection.listTools.mockResolvedValue({ tools: [readTool, fileTool, searchTool] });
  return { connection, adapter: await GitHubReadAdapter.discover(connection, pr, 1000) };
}
const item = (path: string, repo = 'contributor/fork') => ({ path, repository: { full_name: repo }, text_matches: [{ fragment: 'UNTRUSTED SEARCH SNIPPET' }] });

describe('Phase 4 repository tools', () => {
  it('reads an unchanged contract from the fork at the recorded head SHA', async () => {
    const { connection, adapter } = await setup();
    const context = initialContext(); context.metadata.head.repo = { full_name: 'contributor/fork' };
    connection.callTool.mockResolvedValue(textResult({ type: 'file', encoding: 'utf-8', content: 'export interface User {}' }));
    expect(await adapter.readRepositoryFile({ path: 'src/contracts.ts', revision: 'head', startLine: 101 }, context)).toContain('interface User');
    expect(connection.callTool).toHaveBeenCalledExactlyOnceWith('get_file_contents', {
      owner: 'contributor', repo: 'fork', path: 'src/contracts.ts', ref: 'a'.repeat(40),
    });
  });
  it('uses literal base paths in the target repository', async () => {
    const { connection, adapter } = await setup();
    const context = initialContext(); context.metadata.head.repo = { full_name: 'contributor/fork' };
    connection.callTool.mockResolvedValue(textResult({ type: 'file', encoding: 'utf8', content: 'old contract' }));
    await adapter.readRepositoryFile({ path: 'src/old-contract.ts', revision: 'base', startLine: 1 }, context);
    expect(connection.callTool.mock.calls[0]?.[1]).toEqual({ owner: 'owner', repo: 'repository', path: 'src/old-contract.ts', ref: 'b'.repeat(40) });
  });
  it.each([
    { path: '../secret', revision: 'head', startLine: 1 },
    { path: 'src/file', revision: 'main', startLine: 1 },
    { path: 'src/file', revision: 'head', startLine: 0 },
    { path: 'src/file', revision: 'head', startLine: 1, owner: 'evil' },
  ])('denies invalid file input before dispatch: %j', async (input) => {
    const { connection, adapter } = await setup();
    await expect(adapter.readRepositoryFile(input, initialContext())).rejects.toThrow('allow-list');
    expect(connection.callTool).not.toHaveBeenCalled();
  });
  it('lists immediate directory children at a SHA, without exposing links or unrelated paths', async () => {
    const { connection, adapter } = await setup();
    connection.callTool.mockResolvedValue(textResult([
      { path: 'tests/user.test.ts', type: 'file', download_url: 'https://untrusted.test' },
      { path: 'tests/fixtures', type: 'dir' }, { path: 'tests/link', type: 'symlink' },
      { path: 'src/other.ts', type: 'file' }, { path: 'tests/nested/deep.ts', type: 'file' },
    ]));
    expect(await adapter.listDirectory({ path: 'tests', revision: 'head' }, initialContext())).toEqual({
      entries: [{ path: 'tests/user.test.ts', type: 'file' }, { path: 'tests/fixtures', type: 'dir' }], truncated: true,
    });
    expect(connection.callTool.mock.calls[0]?.[1]).toMatchObject({ path: 'tests/', ref: 'a'.repeat(40) });
  });
  it('supports root listings and caps retained entries', async () => {
    const { connection, adapter } = await setup();
    connection.callTool.mockResolvedValue(textResult(Array.from({ length: 60 }, (_, i) => ({ path: `file${i}.ts`, type: 'file' }))));
    const result = await adapter.listDirectory({ path: '', revision: 'base' }, initialContext());
    expect(result.entries).toHaveLength(50); expect(result.truncated).toBe(true);
    expect(connection.callTool.mock.calls[0]?.[1]).toMatchObject({ path: '', ref: 'b'.repeat(40) });
  });
  it('scopes searches to the head repository and returns paths only', async () => {
    const { connection, adapter } = await setup();
    const context = initialContext(); context.metadata.head.repo = { full_name: 'contributor/fork' };
    connection.callTool.mockResolvedValue(textResult({ total_count: 3, incomplete_results: false,
      items: [item('src/caller.ts'), item('tests/user.test.ts'), item('other.ts', 'evil/repository')],
    }));
    const result = await adapter.searchRepository({ term: 'lookupUser', kind: 'code' }, context);
    expect(result).toEqual({ paths: ['src/caller.ts', 'tests/user.test.ts'], incomplete: true });
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED');
    expect(connection.callTool).toHaveBeenCalledExactlyOnceWith('search_code', { query: '"lookupUser" repo:contributor/fork', page: 1, perPage: 20 });
  });
  it('filters test discovery by likely test paths without claiming completeness', async () => {
    const { connection, adapter } = await setup();
    connection.callTool.mockResolvedValue(textResult({ total_count: 3, items: [item('src/user.ts', 'owner/repository'), item('pkg/user_test.go', 'owner/repository'), item('test_user.py', 'owner/repository')] }));
    expect(await adapter.searchRepository({ term: 'user', kind: 'tests' }, initialContext())).toEqual({ paths: ['pkg/user_test.go', 'test_user.py'], incomplete: true });
  });
  it.each(['x repo:evil/repo', 'x" OR "y', 'x\nrepo:evil/repo', 'x *', 'x\\y'])('rejects search operator injection: %s', async (term) => {
    const { connection, adapter } = await setup();
    await expect(adapter.searchRepository({ term, kind: 'code' }, initialContext())).rejects.toThrow('allow-list');
    expect(connection.callTool).not.toHaveBeenCalled();
  });
  it('does not fall back when the head repository is unknown', async () => {
    const { connection, adapter } = await setup(); const context = initialContext(); context.metadata.head.repo = null;
    await expect(adapter.searchRepository({ term: 'user', kind: 'code' }, context)).rejects.toThrow('allow-list');
    await expect(adapter.listDirectory({ path: '', revision: 'head' }, context)).rejects.toThrow('allow-list');
    expect(connection.callTool).not.toHaveBeenCalled();
  });
  it('disables ambiguous or non-read-only search capabilities', async () => {
    for (const tools of [[searchTool, searchTool], [{ ...searchTool, annotations: { readOnlyHint: false } }], [{ ...searchTool, inputSchema: { properties: { query: {} } } }]]) {
      const connection = mockConnection(); connection.listTools.mockResolvedValue({ tools: [readTool, ...tools] });
      const adapter = await GitHubReadAdapter.discover(connection, pr, 1000);
      expect(adapter.canSearchCode).toBe(false);
      await expect(adapter.searchRepository({ term: 'user', kind: 'code' }, initialContext())).rejects.toThrow('allow-list');
      expect(connection.callTool).not.toHaveBeenCalled();
    }
  });
  it('rejects linked directory results and malformed searches without following URLs', async () => {
    const { connection, adapter } = await setup();
    connection.callTool.mockResolvedValue({ content: [{ type: 'resource_link', uri: 'https://evil.test' }] });
    await expect(adapter.listDirectory({ path: '', revision: 'head' }, initialContext())).rejects.toThrow();
    await expect(adapter.searchRepository({ term: 'user', kind: 'code' }, initialContext())).rejects.toThrow();
    expect(connection.callTool).toHaveBeenCalledTimes(2);
  });
});
