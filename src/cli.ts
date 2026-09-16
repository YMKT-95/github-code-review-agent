import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parseConfig, parseGitHubConfig } from './config.js';
import { createLogger } from './logger.js';
import { INVALID_PR_URL, parsePullRequestUrl } from './github/pr-url.js';
import { formatReview } from './review/formatter.js';
import { createMockReview } from './review/mock.js';
import { validateReviewResult } from './review/schemas.js';
import { connectGitHub } from './github/mcp-client.js';
import type { McpConnection } from './github/mcp-client.js';
import { GitHubReadAdapter, withDeadline } from './github/tool-adapter.js';
import { collectInitialContext } from './github/context.js';
import { formatContextReport } from './review/context-formatter.js';
import { GitHubError } from './github/errors.js';

export async function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: (value: string) => void; stderr?: (value: string) => void; connect?: typeof connectGitHub } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    stdout('Usage: npm run review -- [--mock] https://github.com/owner/repository/pull/42\nPhase 2: read-only GitHub MCP context collection; no LLM analysis. Use --mock for the offline demo.');
    return 0;
  }
  let pr;
  let config;
  let githubConfig;
  let secrets: string[] = [];
  const mock = args[0] === '--mock';
  const positional = mock ? args.slice(1) : args;
  try {
    if (positional.length !== 1 || !positional[0]) throw new Error(INVALID_PR_URL);
    pr = parsePullRequestUrl(positional[0]);
    const env = { ...(options.env ?? process.env) };
    const loaded = loadDotenv({ path: resolve(cwd, '.env'), processEnv: env, quiet: true });
    if (loaded.error && (loaded.error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Could not read .env. Check file permissions.');
    }
    config = parseConfig(env);
    if (!mock) githubConfig = parseGitHubConfig(env, config);
    secrets = [env.GITHUB_TOKEN ?? '', env.LLM_API_KEY ?? ''].filter(Boolean);
  } catch (error) {
    stderr(`[ERROR] ${error instanceof Error ? error.message : 'Invalid input or configuration.'}`);
    return 1;
  }

  const log = createLogger(config.LOG_LEVEL, stderr);
  const output = resolve(cwd, 'reviews', `${pr.owner}-${pr.repository}-pr-${pr.pullNumber}${mock ? '' : '-context'}.md`);
  let connection: McpConnection | undefined;
  try {
    try {
      await lstat(output);
      stderr('[ERROR] A report already exists for this PR. Move or remove it before running again.');
      return 1;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let report: string;
    let summary: string;
    if (mock) {
      log('info', 'MOCK MODE: preparing local demonstration report.');
      const review = validateReviewResult(createMockReview(), new Set());
      report = formatReview(pr, review);
      summary = 'Mock review completed: 0 reportable findings\nNo GitHub or LLM calls were made.';
    } else {
      log('info', 'Connecting to the official GitHub MCP endpoint with read-only permissions requested.');
      try { connection = await (options.connect ?? connectGitHub)(githubConfig!); }
      catch { throw new GitHubError('connection'); }
      const adapter = await GitHubReadAdapter.discover(connection, pr, githubConfig!.timeoutMs,
        (event) => log(event.outcome === 'ok' ? 'info' : 'warn', `${event.operation}: ${event.outcome}`));
      log('info', `Collecting context for ${pr.owner}/${pr.repository} PR #${pr.pullNumber}. Read-only allow-list active.`);
      const context = await collectInitialContext(adapter, config, secrets);
      for (const limitation of context.limitations) {
        if (!limitation.startsWith('Phase 2')) log('warn', limitation);
      }
      report = formatContextReport(pr, context);
      summary = `Context collection completed: ${context.files.length}/${context.metadata.changed_files} changed-file entries\nNo LLM analysis or code review was performed.`;
    }
    await mkdir(resolve(cwd, 'reviews'), { recursive: true });
    // Exclusive creation protects prior reports and refuses to follow existing symlinks.
    await writeFile(output, report, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    stdout(`${summary}\nOutput: ${output}`);
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    stderr(error instanceof GitHubError ? `[ERROR] ${error.message}` : code === 'EEXIST'
      ? '[ERROR] A report already exists for this PR. Move or remove it before running again.'
      : '[ERROR] Could not generate or save the report. Check the reviews directory permissions.');
    return 1;
  } finally {
    if (connection) {
      try { await withDeadline(() => connection!.close(), Math.min(config.MCP_TIMEOUT_MS, 5000)); }
      catch { log('warn', 'MCP connection cleanup did not complete normally.'); }
    }
  }
}
