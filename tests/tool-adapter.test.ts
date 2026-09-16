import { describe, expect, it, vi } from 'vitest';
import { GitHubReadAdapter } from '../src/github/tool-adapter.js';
import { parsePullRequestUrl } from '../src/github/pr-url.js';
import { mockConnection, prMetadata, readTool, textResult } from './fixtures/mcp.js';

const pr = parsePullRequestUrl('https://github.com/owner/repository/pull/42');
describe('read-only tool adapter', () => {
  it('discovers paginated tools and scopes every call to the requested PR', async () => {
    const connection = mockConnection();
    connection.listTools.mockResolvedValueOnce({ tools: [{ ...readTool, name: 'create_issue' }], nextCursor: 'next' });
    const adapter = await GitHubReadAdapter.discover(connection, pr, 1000);
    await adapter.read({ method: 'get' });
    expect(connection.listTools).toHaveBeenNthCalledWith(2, 'next');
    expect(connection.callTool).toHaveBeenCalledExactlyOnceWith('pull_request_read', { method: 'get', owner: 'owner', repo: 'repository', pullNumber: 42 });
  });
  it.each([
    { method: 'create_issue' }, { method: 'merge' }, { method: 'get_diff' },
    { method: 'get', owner: 'attacker' }, { method: 'get', repo: 'other' },
    { method: 'get_files', page: 0, perPage: 20 }, { method: 'get_files', page: 1, perPage: 101 },
  ])('blocks forbidden/invalid input %j before dispatch', async (input) => {
    const connection = mockConnection();
    const adapter = await GitHubReadAdapter.discover(connection, pr, 1000);
    await expect(adapter.read(input)).rejects.toThrow('allow-list');
    expect(connection.callTool).not.toHaveBeenCalled();
  });
  it('does not grant access based on a readOnlyHint or tool description', async () => {
    const connection = mockConnection();
    connection.listTools.mockResolvedValue({ tools: [{ ...readTool, name: 'create_issue' }] });
    await expect(GitHubReadAdapter.discover(connection, pr, 1000)).rejects.toThrow('allow-list');
  });
  it('fails closed on missing methods and duplicate tool names', async () => {
    for (const tools of [[{ ...readTool, inputSchema: {} }], [readTool, readTool]]) {
      const connection = mockConnection();
      connection.listTools.mockResolvedValue({ tools });
      await expect(GitHubReadAdapter.discover(connection, pr, 1000)).rejects.toThrow('allow-list');
    }
  });
  it('terminates repeating discovery cursors', async () => {
    const connection = mockConnection();
    connection.listTools.mockResolvedValue({ tools: [], nextCursor: 'same' });
    await expect(GitHubReadAdapter.discover(connection, pr, 1000)).rejects.toThrow('size limit');
    expect(connection.listTools).toHaveBeenCalledTimes(2);
  });
  it('allows required reads when optional status is not advertised', async () => {
    const connection = mockConnection();
    connection.listTools.mockResolvedValue({ tools: [{ ...readTool, inputSchema: { properties: { method: { enum: ['get', 'get_files'] } } } }] });
    const adapter = await GitHubReadAdapter.discover(connection, pr, 1000);
    expect(adapter.supports('get_status')).toBe(false);
    await expect(adapter.read({ method: 'get_status' })).rejects.toThrow('allow-list');
    expect(connection.callTool).not.toHaveBeenCalled();
  });
  it('accepts structured content', async () => {
    const connection = mockConnection();
    connection.callTool.mockResolvedValue({ structuredContent: prMetadata });
    expect(await (await GitHubReadAdapter.discover(connection, pr, 1000)).read({ method: 'get' })).toEqual(prMetadata);
  });
  it.each([
    { isError: true, content: [{ type: 'text', text: 'private-source secret-token' }] },
    { content: [{ type: 'text', text: 'invalid secret-token JSON' }] },
    { content: [{ type: 'resource_link', uri: 'https://evil.test' }] },
    textResult({ ...prMetadata, number: 99 }),
  ])('rejects errors/malformed results without leaking their content', async (result) => {
    const connection = mockConnection();
    connection.callTool.mockResolvedValue(result);
    const trace = vi.fn();
    const adapter = await GitHubReadAdapter.discover(connection, pr, 1000, trace);
    await expect(adapter.read({ method: 'get' })).rejects.not.toThrow('secret-token');
    expect(JSON.stringify(trace.mock.calls)).not.toContain('secret-token');
    expect(trace).toHaveBeenCalledWith({ operation: 'pull_request_read:get', outcome: 'failed' });
  });
  it('bounds stalled calls without retrying', async () => {
    const connection = mockConnection();
    connection.callTool.mockImplementation(() => new Promise(() => {}));
    const adapter = await GitHubReadAdapter.discover(connection, pr, 10);
    await expect(adapter.read({ method: 'get' })).rejects.toThrow('timed out');
    expect(connection.callTool).toHaveBeenCalledTimes(1);
  });
});
