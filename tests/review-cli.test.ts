import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { createAnthropic } from '../src/llm/anthropic.js';
import { mockConnection, prMetadata, changedFiles, textResult, readTool } from './fixtures/mcp.js';
import { candidate, finalTurn, scriptedModel } from './fixtures/agent.js';

describe('review CLI', () => {
  let cwd: string;
  let output: string[];
  let errors: string[];
  const url = 'https://github.com/owner/repository/pull/42';
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'pr-agent-test-')); output = []; errors = []; });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  const options = () => ({ cwd, env: { GITHUB_TOKEN: 'synthetic-github-token', LLM_API_KEY: 'synthetic-llm-key', LLM_MODEL: 'claude-test-model' }, stdout: (s: string) => output.push(s), stderr: (s: string) => errors.push(s) });

  it('runs the real Anthropic adapter with mocked HTTP and writes a revision-labelled review', async () => {
    const connection = mockConnection();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(String(init?.body)).not.toContain('synthetic-github-token');
      expect(String(init?.body)).not.toContain('synthetic-llm-key');
      return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test-model',
        stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(candidate) }], usage: { input_tokens: 100, output_tokens: 20 } });
    });
    expect(await runCli([url], { ...options(), connect: async () => connection, createLlm: (config) => createAnthropic(config, fetcher) })).toBe(0);
    const report = await readFile(join(cwd, 'reviews/owner-repository-pr-42.md'), 'utf8');
    expect(report).toContain('Head SHA: ' + 'a'.repeat(40));
    expect(report).toContain('No sufficiently supported issues');
    expect(report).not.toContain('MOCK REPORT');
    expect(report).not.toContain('CONTEXT ONLY');
    expect(connection.close).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(output.join(' ')).toContain('Review completed: 0');
    expect(errors.join(' ')).not.toContain('synthetic');
  });
  it('requires model credentials only for default review and before MCP connection', async () => {
    const connect = vi.fn();
    expect(await runCli([url], { ...options(), env: { GITHUB_TOKEN: 'synthetic-token' }, connect })).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(errors.join(' ')).toContain('LLM_API_KEY');
  });
  it('runs Phase 4 search and related-test reads through the real SDK and MCP adapter', async () => {
    const connection = mockConnection();
    connection.listTools.mockResolvedValue({ tools: [readTool,
      { name: 'get_file_contents', inputSchema: { properties: { owner: {}, repo: {}, path: {}, ref: {} } } },
      { name: 'search_code', inputSchema: { properties: { query: {}, page: {}, perPage: {} } } },
    ] });
    connection.callTool.mockImplementation(async (name, args) => {
      if (name === 'search_code') return textResult({ total_count: 1, incomplete_results: false,
        items: [{ path: 'tests/contract.test.ts', repository: { full_name: 'owner/repository' } }],
      });
      if (name === 'get_file_contents') {
        expect(args).toEqual({ owner: 'owner', repo: 'repository', path: 'tests/contract.test.ts', ref: 'a'.repeat(40) });
        return { content: [{ type: 'resource', resource: { uri: 'repo://test', text: 'expect(lookupUser(null)).toBeUndefined();\n' } }] };
      }
      return textResult(args.method === 'get' ? prMetadata : args.method === 'get_files' ? changedFiles : { state: 'success' });
    });
    let turn = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_changed_file', 'read_repository_file', 'list_directory', 'search_repository']);
      const content = ++turn === 1
        ? [{ type: 'tool_use', id: 'search1', name: 'search_repository', input: { term: 'lookupUser', kind: 'tests' } }]
        : turn === 2 ? [{ type: 'tool_use', id: 'read1', name: 'read_repository_file', input: { path: 'tests/contract.test.ts', revision: 'head', startLine: 1 } }]
        : [{ type: 'text', text: JSON.stringify(candidate) }];
      if (turn === 2) expect(body.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'search1', is_error: false });
      if (turn === 3) expect(body.messages.at(-1).content[0].content).toContain('expect(lookupUser(null))');
      return Response.json({ id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'claude-test-model',
        stop_reason: turn < 3 ? 'tool_use' : 'end_turn', stop_sequence: null, content, usage: { input_tokens: 100, output_tokens: 20 } });
    });
    expect(await runCli([url], { ...options(), connect: async () => connection, createLlm: (config) => createAnthropic(config, fetcher) })).toBe(0);
    const report = await readFile(join(cwd, 'reviews/owner-repository-pr-42.md'), 'utf8');
    expect(report).toContain('Changed files inspected: 2');
    expect(report).toContain('Additional files inspected: tests/contract\\.test\\.ts');
    expect(report).toContain('Tests inspected: tests/user\\.test\\.ts, tests/contract\\.test\\.ts');
    expect(fetcher).toHaveBeenCalledTimes(3); expect(connection.close).toHaveBeenCalledOnce();
  });
  it('closes MCP and leaves no report after failed model output repair', async () => {
    const connection = mockConnection();
    const model = scriptedModel([finalTurn({}), finalTurn({})]);
    expect(await runCli([url], { ...options(), connect: async () => connection, createLlm: () => model })).toBe(1);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(errors.join(' ')).toContain('after one repair');
    expect(await readdir(cwd)).toEqual([]);
  });
  it('does not write a no-findings report when the provider fails', async () => {
    const connection = mockConnection();
    const model = scriptedModel([]); model.turn.mockRejectedValue(new Error('synthetic-llm-key provider body'));
    expect(await runCli([url], { ...options(), connect: async () => connection, createLlm: () => model })).toBe(1);
    expect(await readdir(cwd)).toEqual([]);
    expect(errors.join(' ')).toContain('Anthropic request failed');
    expect(errors.join(' ')).not.toContain('provider body');
    expect(connection.close).toHaveBeenCalledOnce();
  });
  it('discloses a PR revision change after model review', async () => {
    const connection = mockConnection();
    let gets = 0;
    connection.callTool.mockImplementation(async (_name, args) => textResult(args.method === 'get'
      ? { ...prMetadata, head: { ...prMetadata.head, sha: (++gets > 2 ? 'c' : 'a').repeat(40) } }
      : args.method === 'get_files' ? changedFiles : { state: 'success' }));
    expect(await runCli([url], { ...options(), connect: async () => connection, createLlm: () => scriptedModel([finalTurn()]) })).toBe(0);
    expect(await readFile(join(cwd, 'reviews/owner-repository-pr-42.md'), 'utf8')).toContain('PR revisions changed during model review');
  });
});
