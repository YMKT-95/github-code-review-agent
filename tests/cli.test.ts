import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

describe('offline CLI', () => {
  let cwd: string;
  let output: string[];
  let errors: string[];
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
    output = [];
    errors = [];
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  const url = 'https://github.com/owner/repository/pull/42';
  const options = () => ({ cwd, env: {}, stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value) });

  it('writes an explicitly labelled report without credentials', async () => {
    expect(await runCli(['--mock', url], options())).toBe(0);
    const report = await readFile(join(cwd, 'reviews/owner-repository-pr-42.md'), 'utf8');
    expect(report).toContain('MOCK REPORT');
    expect(report).toContain(url);
    expect(output.join('\n')).toContain('Mock review completed: 0');
  });
  it('refuses to overwrite a previous report', async () => {
    await runCli(['--mock', url], options());
    const path = join(cwd, 'reviews/owner-repository-pr-42.md');
    await writeFile(path, 'keep this review');
    expect(await runCli(['--mock', url], options())).toBe(1);
    expect(await readFile(path, 'utf8')).toBe('keep this review');
    expect(errors.join('\n')).toContain('already exists');
  });
  it.each([[], ['invalid'], [url, 'extra']])('rejects arguments %j without writing', async (...args) => {
    expect(await runCli(args, options())).toBe(1);
    expect(await readdir(cwd)).toEqual([]);
    expect(errors.join('\n')).toContain('Expected a GitHub pull-request URL');
  });
  it('loads .env and validates it before writing', async () => {
    await writeFile(join(cwd, '.env'), 'MAX_AGENT_STEPS=invalid-secret');
    expect(await runCli([url], options())).toBe(1);
    expect(errors.join('\n')).toContain('MAX_AGENT_STEPS');
    expect(errors.join('\n')).not.toContain('invalid-secret');
    expect(await readdir(cwd)).toEqual(['.env']);
  });
  it('lets the existing environment override .env', async () => {
    await writeFile(join(cwd, '.env'), 'MAX_AGENT_STEPS=bad');
    expect(await runCli(['--mock', url], { ...options(), env: { MAX_AGENT_STEPS: '4' } })).toBe(0);
  });
  it('shows help without configuration or output files', async () => {
    expect(await runCli(['--help'], options())).toBe(0);
    expect(output.join('\n')).toContain('Usage:');
    expect(await readdir(cwd)).toEqual([]);
  });
});
