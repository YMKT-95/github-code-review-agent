import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { createAnthropic } from '../src/llm/anthropic.js';
import { mockConnection, prMetadata, changedFiles, textResult } from './fixtures/mcp.js';
import { candidate, finalTurn, scriptedModel } from './fixtures/agent.js';

describe('Phase 3 review CLI', () => {
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
