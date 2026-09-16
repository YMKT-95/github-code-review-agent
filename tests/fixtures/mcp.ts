import { vi } from 'vitest';
import type { McpConnection, McpTool } from '../../src/github/mcp-client.js';

export const prMetadata = {
  number: 42, title: 'Handle missing users', body: 'Review this change.', user: { login: 'octocat' },
  head: { ref: 'fix/users', sha: 'a'.repeat(40), repo: { full_name: 'owner/repository' } }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'owner/repository' } },
  changed_files: 2, additions: 2, deletions: 1,
};
export const changedFiles = [
  { filename: 'src/user.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-return user.name;\n+return user?.name;' },
  { filename: 'tests/user.test.ts', status: 'added', additions: 1, patch: '@@ -0,0 +1 @@\n+expect(getUser(null)).toBeUndefined();' },
];
export const readTool: McpTool = {
  name: 'pull_request_read', annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { method: { type: 'string', enum: ['get', 'get_files', 'get_status', 'get_diff'] } } },
};
export const textResult = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export function mockConnection() {
  return {
    listTools: vi.fn<McpConnection['listTools']>(async () => ({ tools: [readTool] })),
    callTool: vi.fn<McpConnection['callTool']>(async (_name, args) => textResult(
      args.method === 'get' ? prMetadata : args.method === 'get_files' ? changedFiles : { state: 'success' },
    )),
    close: vi.fn<McpConnection['close']>(async () => {}),
  };
}
