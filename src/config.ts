import { z } from 'zod';

const positiveInteger = (fallback: number) => z.preprocess(
  (value) => value === undefined ? fallback : value,
  z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
);

const configSchema = z.object({
  MAX_AGENT_STEPS: positiveInteger(8),
  MAX_TOOL_RESULT_CHARS: positiveInteger(30000),
  MAX_FILES_TO_INSPECT: positiveInteger(20),
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
