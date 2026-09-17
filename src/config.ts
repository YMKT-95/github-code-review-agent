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
  LLM_TIMEOUT_MS: positiveInteger(60000),
  MAX_LLM_OUTPUT_TOKENS: positiveInteger(8192),
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

export type LlmConfig = { apiKey: string; model: string; timeoutMs: number; maxOutputTokens: number; maxContextChars: number };

export function parseLlmConfig(env: NodeJS.ProcessEnv, config: Config): LlmConfig {
  if (!env.LLM_API_KEY?.trim() || /\s/.test(env.LLM_API_KEY.trim())) {
    throw new Error('LLM_API_KEY is required for Anthropic review. Set it locally or use --context-only / --mock.');
  }
  if (!env.LLM_MODEL || !/^claude-[a-z0-9.-]+$/.test(env.LLM_MODEL)) {
    throw new Error('LLM_MODEL must be an explicit Claude model ID supporting tools and structured output.');
  }
  return { apiKey: env.LLM_API_KEY.trim(), model: env.LLM_MODEL, timeoutMs: Math.min(config.LLM_TIMEOUT_MS, 120000), maxOutputTokens: Math.min(config.MAX_LLM_OUTPUT_TOKENS, 16384), maxContextChars: config.MAX_CONTEXT_CHARS };
}

export type GitHubConfig = { token: string; timeoutMs: number };

export function parseGitHubConfig(env: NodeJS.ProcessEnv, config: Config): GitHubConfig {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token || /\s/.test(token)) {
    throw new Error('GITHUB_TOKEN is required for live context retrieval. Set it in .env or use --mock.');
  }
  if (env.GITHUB_MCP_COMMAND || env.GITHUB_MCP_ARGS || env.GITHUB_MCP_URL) {
    throw new Error('This project uses the official hosted GitHub MCP endpoint. Remove custom MCP command, args or URL settings.');
  }
  return { token, timeoutMs: Math.min(config.MCP_TIMEOUT_MS, 120000) };
}
