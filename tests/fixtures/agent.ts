import { vi } from 'vitest';
import type { InitialContext } from '../../src/github/context.js';
import type { LlmClient, ModelRequest, ModelTurn } from '../../src/llm/types.js';
import { changedFiles, prMetadata } from './mcp.js';

export const usage = { inputTokens: 100, outputTokens: 20 };
export const candidate = {
  summary: 'The observed change guards the nullable user.',
  findings: [],
};
export const finalTurn = (value: unknown = candidate): ModelTurn => ({ kind: 'final', candidate: value, usage });
export const toolTurn = (id = 'tool_1', input: unknown = { path: 'src/user.ts', revision: 'head' }, name = 'read_changed_file'): ModelTurn => ({ kind: 'tool', call: { id, name, input }, usage });
export function initialContext(): InitialContext {
  return {
    metadata: structuredClone(prMetadata), files: changedFiles.map((file) => ({ ...file, deletions: file.deletions ?? 0, patchTruncated: false })),
    status: 'success', limitations: [], revisionStable: true, retainedChars: 1000, collectedAt: '2026-09-17T00:00:00Z',
  };
}
export function scriptedModel(turns: ModelTurn[]) {
  const received: ModelRequest[] = [];
  return {
    inputChars: (request: ModelRequest) => JSON.stringify(request).length + 2000,
    turn: vi.fn<LlmClient['turn']>(async (request) => {
      received.push(structuredClone(request));
      const next = turns.shift();
      if (!next) throw new Error('No scripted response');
      return next;
    }),
    received,
  };
}
export const fakeSource = () => ({ canReadFiles: true, readChangedFile: vi.fn(async () => 'const user = lookup();\nreturn user?.name;\n') });
