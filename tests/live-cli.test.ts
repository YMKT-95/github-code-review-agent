import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { parseConfig, parseGitHubConfig } from '../src/config.js';
import { mockConnection } from './fixtures/mcp.js';

describe('Phase 2 CLI with injected MCP connection', () => {
  let cwd: string;
  let output: string[];
  let errors: string[];
  const url = 'https://github.com/owner/repository/pull/42';
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'pr-context-test-'));
    output = []; errors = [];
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  const options = () => ({ cwd, env: { GITHUB_TOKEN: 'synthetic-token' }, stdout: (v: string) => output.push(v), stderr: (v: string) => errors.push(v) });
  it('writes a context-only report and always closes the connection', async () => {
    const connection = mockConnection();
    expect(await runCli(['--context-only', url], { ...options(), connect: async () => connection })).toBe(0);
    expect(await readFile(join(cwd, 'reviews/owner-repository-pr-42-context.md'), 'utf8')).toContain('CONTEXT ONLY');
    expect(connection.close).toHaveBeenCalledOnce();
    expect(output.join(' ')).toContain('2/2');
    expect(errors.join(' ')).not.toContain('synthetic-token');
    expect(errors.join(' ')).not.toContain('return user');
  });
  it('validates URL and missing credentials before connecting', async () => {
    const connect = vi.fn();
    expect(await runCli(['bad'], { ...options(), connect })).toBe(1);
    expect(await runCli(['--context-only', url], { ...options(), env: {}, connect })).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
  });
  it('closes on inaccessible PR and writes no misleading report', async () => {
    const connection = mockConnection();
    connection.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'private-source synthetic-token' }] });
    expect(await runCli(['--context-only', url], { ...options(), connect: async () => connection })).toBe(1);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(errors.join(' ')).toContain('MCP read failed');
    expect(errors.join(' ')).not.toContain('private-source');
    expect(await readdir(cwd)).toEqual([]);
  });
  it('fails before network calls when a report already exists', async () => {
    await mkdir(join(cwd, 'reviews'));
    await writeFile(join(cwd, 'reviews/owner-repository-pr-42-context.md'), 'preserve');
    const connect = vi.fn();
    expect(await runCli(['--context-only', url], { ...options(), connect })).toBe(1);
    expect(connect).not.toHaveBeenCalled();
  });
  it('keeps the offline mock path independent of GitHub credentials and connections', async () => {
    const connect = vi.fn();
    expect(await runCli(['--mock', url], { ...options(), env: {}, connect })).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });
});

it('rejects custom endpoints/commands and malformed credentials without echoing values', () => {
  for (const env of [{ GITHUB_TOKEN: '' }, { GITHUB_TOKEN: 'a\nb' }, { GITHUB_TOKEN: 'synthetic-token', GITHUB_MCP_URL: 'https://evil.test' }]) {
    expect(() => parseGitHubConfig(env, parseConfig({}))).toThrow();
  }
  expect(parseGitHubConfig({ GITHUB_TOKEN: 'synthetic-token' }, parseConfig({ MCP_TIMEOUT_MS: '200000' })).timeoutMs).toBe(120000);
});
