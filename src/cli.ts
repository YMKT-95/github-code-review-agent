import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parseConfig } from './config.js';
import { createLogger } from './logger.js';
import { INVALID_PR_URL, parsePullRequestUrl } from './github/pr-url.js';
import { formatReview } from './review/formatter.js';
import { createMockReview } from './review/mock.js';
import { validateReviewResult } from './review/schemas.js';

export async function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: (value: string) => void; stderr?: (value: string) => void } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    stdout('Usage: npm run review -- https://github.com/owner/repository/pull/42\nPhase 1: mock output only; no GitHub or LLM connection.');
    return 0;
  }
  let pr;
  let config;
  try {
    if (args.length !== 1 || !args[0]) throw new Error(INVALID_PR_URL);
    pr = parsePullRequestUrl(args[0]);
    const env = { ...(options.env ?? process.env) };
    const loaded = loadDotenv({ path: resolve(cwd, '.env'), processEnv: env, quiet: true });
    if (loaded.error && (loaded.error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Could not read .env. Check file permissions.');
    }
    config = parseConfig(env);
  } catch (error) {
    stderr(`[ERROR] ${error instanceof Error ? error.message : 'Invalid input or configuration.'}`);
    return 1;
  }

  const log = createLogger(config.LOG_LEVEL, stderr);
  log('info', `MOCK MODE: preparing local report for ${pr.owner}/${pr.repository} PR #${pr.pullNumber}`);
  const output = resolve(cwd, 'reviews', `${pr.owner}-${pr.repository}-pr-${pr.pullNumber}.md`);
  try {
    const review = validateReviewResult(createMockReview(), new Set());
    await mkdir(resolve(cwd, 'reviews'), { recursive: true });
    // Exclusive creation protects prior reports and refuses to follow existing symlinks.
    await writeFile(output, formatReview(pr, review), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    stdout(`Mock review completed: ${review.findings.length} reportable findings\nNo GitHub or LLM calls were made.\nOutput: ${output}`);
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    stderr(code === 'EEXIST'
      ? '[ERROR] A report already exists for this PR. Move or remove it before running again.'
      : '[ERROR] Could not generate or save the mock report. Check the reviews directory permissions.');
    return 1;
  }
}
