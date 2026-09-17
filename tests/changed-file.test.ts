import { describe, expect, it } from 'vitest';
import { GitHubReadAdapter } from '../src/github/tool-adapter.js';
import { parsePullRequestUrl } from '../src/github/pr-url.js';
import { mockConnection, readTool, textResult } from './fixtures/mcp.js';
import { initialContext } from './fixtures/agent.js';

const pr = parsePullRequestUrl('https://github.com/owner/repository/pull/42');
const fileTool = { name: 'get_file_contents', inputSchema: { properties: { owner: {}, repo: {}, path: {}, ref: {} } }, annotations: { readOnlyHint: true } };
async function setup() {
  const connection = mockConnection();
  connection.listTools.mockResolvedValue({ tools: [readTool, fileTool, { ...fileTool, name: 'push_files' }] });
  return { connection, adapter: await GitHubReadAdapter.discover(connection, pr, 1000) };
}
describe('changed-file MCP reads', () => {
  it('reads embedded text at the captured fork SHA rather than a branch name', async () => {
    const { connection, adapter } = await setup();
    const context = initialContext();
    context.metadata.head.repo = { full_name: 'contributor/fork' };
    connection.callTool.mockResolvedValue({ content: [
      { type: 'text', text: 'Successfully downloaded' },
      { type: 'resource', resource: { uri: 'repo://file', text: 'hello\n', mimeType: 'text/plain' } },
    ] });
    expect(await adapter.readChangedFile({ path: 'src/user.ts', revision: 'head' }, context)).toBe('hello\n');
    expect(connection.callTool).toHaveBeenCalledExactlyOnceWith('get_file_contents', {
      owner: 'contributor', repo: 'fork', path: 'src/user.ts', ref: 'a'.repeat(40),
    });
  });
  it('resolves renamed base paths in the target repository and decodes base64', async () => {
    const { connection, adapter } = await setup();
    const context = initialContext(); context.files[0]!.previous_filename = 'src/old-user.ts';
    connection.callTool.mockResolvedValue(textResult({ type: 'file', encoding: 'base64', content: Buffer.from('old code').toString('base64') }));
    expect(await adapter.readChangedFile({ path: 'src/user.ts', revision: 'base' }, context)).toBe('old code');
    expect(connection.callTool.mock.calls[0]?.[1]).toMatchObject({ path: 'src/old-user.ts', owner: 'owner', ref: 'b'.repeat(40) });
  });
  it.each([
    { path: '../secret', revision: 'head' }, { path: 'other.ts', revision: 'head' },
    { path: 'src/user.ts', revision: 'head', repo: 'evil' }, { path: 'src/user.ts', revision: 'arbitrary-sha' },
  ])('rejects forbidden arguments %j before MCP calls', async (input) => {
    const { connection, adapter } = await setup();
    await expect(adapter.readChangedFile(input, initialContext())).rejects.toThrow('allow-list');
    expect(connection.callTool).not.toHaveBeenCalled();
  });
  it('refuses a removed head or unknown head repository without falling back', async () => {
    const { connection, adapter } = await setup();
    const context = initialContext(); context.files[0]!.status = 'removed';
    await expect(adapter.readChangedFile({ path: 'src/user.ts', revision: 'head' }, context)).rejects.toThrow('allow-list');
    context.files[0]!.status = 'modified'; context.metadata.head.repo = null;
    await expect(adapter.readChangedFile({ path: 'src/user.ts', revision: 'head' }, context)).rejects.toThrow('allow-list');
    expect(connection.callTool).not.toHaveBeenCalled();
  });
  it.each([
    { content: [{ type: 'resource_link', uri: 'https://evil.test' }] },
    textResult([{ type: 'dir', name: 'src' }]),
    textResult({ type: 'file', encoding: 'base64', content: '%%%invalid%%%' }),
    textResult({ type: 'file', encoding: 'base64', content: 'AA==' }),
  ])('rejects links, listings and binary/invalid data', async (result) => {
    const { connection, adapter } = await setup(); connection.callTool.mockResolvedValue(result);
    await expect(adapter.readChangedFile({ path: 'src/user.ts', revision: 'head' }, initialContext())).rejects.toThrow();
    expect(connection.callTool).toHaveBeenCalledOnce();
  });
});
