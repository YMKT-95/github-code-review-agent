import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('configuration', () => {
  it('uses documented defaults without credentials in mock mode', () => {
    expect(parseConfig({})).toEqual({ MAX_AGENT_STEPS: 8, MAX_TOOL_RESULT_CHARS: 30000, MAX_FILES_TO_INSPECT: 20, MAX_CONTEXT_CHARS: 100000, MAX_PATCH_CHARS: 10000, MCP_TIMEOUT_MS: 15000, MIN_FINDING_CONFIDENCE: 0.75, LOG_LEVEL: 'info' });
  });
  it.each(['0', '0.75', '1'])('accepts confidence %s', (value) => {
    expect(parseConfig({ MIN_FINDING_CONFIDENCE: value }).MIN_FINDING_CONFIDENCE).toBe(Number(value));
  });
  it.each([
    { MAX_AGENT_STEPS: '0' }, { MAX_AGENT_STEPS: '1.5' }, { MAX_FILES_TO_INSPECT: '-2' },
    { MAX_TOOL_RESULT_CHARS: '' }, { MIN_FINDING_CONFIDENCE: '' }, { MIN_FINDING_CONFIDENCE: ' ' },
    { MIN_FINDING_CONFIDENCE: '-0.1' }, { MIN_FINDING_CONFIDENCE: '1.01' }, { LOG_LEVEL: 'verbose' },
  ])('rejects invalid settings %j', (env) => expect(() => parseConfig(env)).toThrow('Invalid configuration'));
  it('does not expose invalid values or secrets in errors', () => {
    try { parseConfig({ MAX_AGENT_STEPS: 'secret-value', LLM_API_KEY: 'secret-key' }); }
    catch (error) {
      expect(String(error)).toContain('MAX_AGENT_STEPS');
      expect(String(error)).not.toContain('secret');
      return;
    }
    throw new Error('Expected invalid configuration to throw');
  });
});
