import { z } from 'zod';

const positiveInteger = (fallback: number) => z.preprocess(
  (value) => value === undefined ? fallback : value,
  z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
);

const configSchema = z.object({
  MAX_AGENT_STEPS: positiveInteger(8),
  MAX_TOOL_RESULT_CHARS: positiveInteger(30000),
  MAX_FILES_TO_INSPECT: positiveInteger(20),
  MAX_CONTEXT_CHARS: positiveInteger(100000),
  MAX_PATCH_CHARS: positiveInteger(10000),
  MCP_TIMEOUT_MS: positiveInteger(15000),
  MIN_FINDING_CONFIDENCE: z.preprocess(
    (value) => value === undefined ? 0.75 : value === '' || value?.toString().trim() === '' ? NaN : value,
    z.coerce.number().min(0).max(1),
  ),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Field names only: never print rejected environment values or credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${fields.join(', ')}. See .env.example for valid values.`);
  }
  return result.data;
}

export type GitHubConfig = { token: string; timeoutMs: number };

export function parseGitHubConfig(env: NodeJS.ProcessEnv, config: Config): GitHubConfig {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token || /\s/.test(token)) {
    throw new Error('GITHUB_TOKEN is required for live context retrieval. Set it in .env or use --mock.');
  }
  if (env.GITHUB_MCP_COMMAND || env.GITHUB_MCP_ARGS || env.GITHUB_MCP_URL) {
    throw new Error('Phase 2 uses the official hosted GitHub MCP endpoint. Remove custom MCP command, args or URL settings.');
  }
  return { token, timeoutMs: Math.min(config.MCP_TIMEOUT_MS, 120000) };
}
