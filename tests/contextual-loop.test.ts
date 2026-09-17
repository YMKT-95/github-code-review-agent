import { describe, expect, it, vi } from 'vitest';
import { runReview } from '../src/agent/loop.js';
import { parseConfig } from '../src/config.js';
import type { GitHubReadAdapter } from '../src/github/tool-adapter.js';
import { candidate, fakeSource, finalTurn, initialContext, scriptedModel, toolTurn } from './fixtures/agent.js';
import { finding } from './fixtures/finding.js';

const { id: _id, ...good } = finding;
function source() {
  return { ...fakeSource(), canSearchCode: true,
    readRepositoryFile: vi.fn<GitHubReadAdapter['readRepositoryFile']>(async () => 'export const user = {};\nreturn user.name;\n'),
    listDirectory: vi.fn<GitHubReadAdapter['listDirectory']>(async () => ({ entries: [{ path: 'tests/contract.test.ts', type: 'file' }], truncated: false })),
    searchRepository: vi.fn<GitHubReadAdapter['searchRepository']>(async () => ({ paths: ['tests/contract.test.ts'], incomplete: false })),
  };
}
const read = (id: string, path = 'src/contracts.ts', startLine = 1, revision = 'head') => toolTurn(id, { path, revision, startLine }, 'read_repository_file');
const search = (id: string) => toolTurn(id, { term: 'lookupUser', kind: 'tests' }, 'search_repository');
const directory = (id: string) => toolTurn(id, { path: 'tests', revision: 'head' }, 'list_directory');

describe('contextual review loop', () => {
  it('discovers and reads a related test, recording code delivery separately from discovery', async () => {
    const src = source(); const model = scriptedModel([directory('t1'), read('t2', 'tests/contract.test.ts'), finalTurn()]);
    const { result, state } = await runReview(initialContext(), src, model, parseConfig({}));
    expect(src.listDirectory).toHaveBeenCalledOnce(); expect(src.readRepositoryFile).toHaveBeenCalledOnce();
    expect(result.coverage.changedFilesInspected).toBe(2);
    expect(result.coverage.additionalFilesInspected).toEqual(['tests/contract.test.ts']);
    expect(result.coverage.testsInspected).toContain('tests/contract.test.ts');
    expect(state.toolCalls).toBe(2);
    expect(model.received[0]?.availableTools).toEqual(['read_changed_file', 'read_repository_file', 'list_directory', 'search_repository']);
  });
  it('uses search only as hints, then pins context through the repository reader', async () => {
    const src = source(); const model = scriptedModel([search('t1'), read('t2', 'tests/contract.test.ts'), finalTurn()]);
    const { result } = await runReview(initialContext(), src, model, parseConfig({}));
    expect(JSON.stringify(model.received[1])).toContain('untrusted-search-hints');
    const delivered = model.received[2]?.messages.at(-1);
    expect(delivered && 'result' in delivered).toBe(true);
    if (delivered && 'result' in delivered) expect(JSON.parse(delivered.result.content).sha).toBe('a'.repeat(40));
    expect(result.coverage.limitations.join(' ')).toContain('not the reviewed SHA');
  });
  it('rejects findings on search-only paths, then repairs without further retrieval', async () => {
    const model = scriptedModel([search('t1'), finalTurn({ ...candidate, findings: [{ ...good, file: 'tests/contract.test.ts', line: 1 }] }), finalTurn()]);
    const { result } = await runReview(initialContext(), source(), model, parseConfig({}));
    expect(result.coverage.additionalFilesInspected).toEqual([]);
    expect(model.received[2]?.toolsEnabled).toBe(false);
    expect(model.received[2]?.availableTools).toContain('search_repository');
  });
  it('does not count a directory listing as a test inspection', async () => {
    const model = scriptedModel([directory('t1'), finalTurn()]);
    const { result } = await runReview(initialContext(), source(), model, parseConfig({}));
    expect(result.coverage.additionalFilesInspected).toEqual([]);
    expect(result.coverage.testsInspected).not.toContain('tests/contract.test.ts');
  });
  it('reuses cached files for subsequent ranges and validates actual line numbers', async () => {
    const src = source(); src.readRepositoryFile.mockResolvedValue(Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n'));
    const model = scriptedModel([read('t1'), read('t2', 'src/contracts.ts', 201), finalTurn({ ...candidate, findings: [{ ...good, file: 'src/contracts.ts', line: 225 }] })]);
    const { result } = await runReview(initialContext(), src, model, parseConfig({ MAX_PATCH_CHARS: '30000' }));
    expect(src.readRepositoryFile).toHaveBeenCalledOnce();
    expect(result.findings[0]?.line).toBe(225);
    expect(result.coverage.additionalFilesInspected).toEqual(['src/contracts.ts']);
    expect(JSON.stringify(model.received[1])).not.toContain('line 201');
    expect(JSON.stringify(model.received[2])).toContain('line 201');
  });
  it('does not approve omitted lines when only a range was supplied', async () => {
    const src = source(); src.readRepositoryFile.mockResolvedValue('unseen\nobserved\n');
    const model = scriptedModel([read('t1', 'src/contracts.ts', 2), finalTurn({ ...candidate, findings: [{ ...good, file: 'src/contracts.ts', line: 1 }] }), finalTurn()]);
    await runReview(initialContext(), src, model, parseConfig({}));
    expect(model.received[2]?.toolsEnabled).toBe(false);
    expect(JSON.stringify(model.received[1])).not.toContain('unseen');
  });
  it('does not fetch again for repeated searches or directory requests', async () => {
    const src = source(); const model = scriptedModel([search('t1'), search('t2'), directory('t3'), directory('t4'), finalTurn()]);
    await runReview(initialContext(), src, model, parseConfig({}));
    expect(src.searchRepository).toHaveBeenCalledOnce(); expect(src.listDirectory).toHaveBeenCalledOnce();
  });
  it('enforces one shared file-inspection cap across changed and related files', async () => {
    const src = source(); const model = scriptedModel([read('t1'), finalTurn()]);
    const { result } = await runReview(initialContext(), src, model, parseConfig({ MAX_FILES_TO_INSPECT: '2' }));
    expect(src.readRepositoryFile).not.toHaveBeenCalled();
    expect(result.coverage.completionReason).toBe('context-limit');
  });
  it('keeps incomplete changed-file coverage when additional files were inspected', async () => {
    const context = initialContext(); delete context.files[1]!.patch;
    const model = scriptedModel([read('t1'), finalTurn()]);
    const { result } = await runReview(context, source(), model, parseConfig({}));
    expect(result.coverage.changedFilesInspected).toBe(1);
    expect(result.coverage.additionalFilesInspected).toHaveLength(1);
    expect(result.coverage.limitations).toContain('Not all changed files had code supplied to the model.');
  });
  it('recovers from search failure, avoids retries and still reads known paths', async () => {
    const src = source(); src.searchRepository.mockRejectedValue(new Error('SECRET provider body'));
    const model = scriptedModel([search('t1'), search('t2'), read('t3'), finalTurn()]);
    const { result } = await runReview(initialContext(), src, model, parseConfig({}));
    expect(src.searchRepository).toHaveBeenCalledOnce(); expect(src.readRepositoryFile).toHaveBeenCalledOnce();
    expect(JSON.stringify(model.received)).not.toContain('SECRET');
    expect(result.coverage.completionReason).toBe('tool-failure');
  });
  it('does not advertise unavailable capabilities', async () => {
    const model = scriptedModel([finalTurn()]);
    await runReview(initialContext(), fakeSource(), model, parseConfig({}));
    expect(model.received[0]?.availableTools).toEqual(['read_changed_file']);
  });
  it.each([
    toolTurn('t1', { path: '../secrets', revision: 'head', startLine: 1 }, 'read_repository_file'),
    toolTurn('t1', { term: 'x repo:evil/repo', kind: 'code' }, 'search_repository'),
    toolTurn('t1', { path: '', revision: 'head', owner: 'evil' }, 'list_directory'),
  ])('rejects invalid arguments before dispatch', async (turn) => {
    const src = source(); const model = scriptedModel([turn, finalTurn()]);
    await runReview(initialContext(), src, model, parseConfig({}));
    expect(src.readRepositoryFile).not.toHaveBeenCalled(); expect(src.listDirectory).not.toHaveBeenCalled(); expect(src.searchRepository).not.toHaveBeenCalled();
  });
  it('caps directory observations as complete JSON without promoting paths to evidence', async () => {
    const src = source(); src.listDirectory.mockResolvedValue({ entries: Array.from({ length: 50 }, (_, i) => ({ path: `tests/${'x'.repeat(150)}${i}.ts`, type: 'file' })), truncated: false });
    const model = scriptedModel([directory('t1'), finalTurn()]);
    const { result } = await runReview(initialContext(), src, model, parseConfig({ MAX_TOOL_RESULT_CHARS: '600' }));
    const observation = model.received[1]?.messages.at(-1);
    expect(observation && 'result' in observation).toBe(true);
    if (observation && 'result' in observation) {
      expect(JSON.stringify(observation.result.content).length).toBeLessThanOrEqual(600);
      expect(JSON.parse(observation.result.content).truncated).toBe(true);
    }
    expect(result.coverage.additionalFilesInspected).toEqual([]);
  });
  it('preserves base-only evidence without accepting head-side line references', async () => {
    const model = scriptedModel([read('t1', 'src/contracts.ts', 1, 'base'), finalTurn({ ...candidate, findings: [{ ...good, file: 'src/contracts.ts', line: 1 }] }), finalTurn({ ...candidate, findings: [{ ...good, file: 'src/contracts.ts', line: null }] })]);
    const { result } = await runReview(initialContext(), source(), model, parseConfig({}));
    expect(result.findings[0]?.line).toBeNull();
    expect(model.received[2]?.toolsEnabled).toBe(false);
  });
  it('shares cached base content between renamed-file and literal-path reads', async () => {
    const context = initialContext(); context.files[0]!.previous_filename = 'src/old-user.ts';
    const src = source(); src.readChangedFile.mockResolvedValue('old first line\nold second line\n');
    const model = scriptedModel([
      toolTurn('t1', { path: 'src/user.ts', revision: 'base' }),
      read('t2', 'src/old-user.ts', 2, 'base'), finalTurn(),
    ]);
    const { result } = await runReview(context, src, model, parseConfig({}));
    expect(src.readChangedFile).toHaveBeenCalledOnce(); expect(src.readRepositoryFile).not.toHaveBeenCalled();
    expect(result.coverage.additionalFilesInspected).toEqual([]);
    expect(result.coverage.changedFilesInspected).toBe(2);
  });
  it('caches a failed file across different range requests', async () => {
    const src = source(); src.readRepositoryFile.mockRejectedValue(new Error('unavailable'));
    const model = scriptedModel([read('t1'), read('t2', 'src/contracts.ts', 201), finalTurn()]);
    const { result } = await runReview(initialContext(), src, model, parseConfig({}));
    expect(src.readRepositoryFile).toHaveBeenCalledOnce();
    expect(result.coverage.additionalFilesInspected).toEqual([]);
    expect(JSON.stringify(model.received[2])).toContain('No retry was made');
  });
  it('never treats a cut long line as observed evidence', async () => {
    const src = source(); src.readRepositoryFile.mockResolvedValue('x'.repeat(1000));
    const model = scriptedModel([read('t1'), finalTurn({ ...candidate, findings: [{ ...good, file: 'src/contracts.ts', line: 1 }] }), finalTurn()]);
    const { result } = await runReview(initialContext(), src, model, parseConfig({ MAX_PATCH_CHARS: '500' }));
    expect(result.coverage.additionalFilesInspected).toEqual([]);
    expect(model.received[2]?.toolsEnabled).toBe(false);
    expect(JSON.stringify(model.received[1])).not.toContain('x'.repeat(20));
  });
  it('bounds complete context inputs during repeated discovery and tools-off finalisation', async () => {
    const src = source();
    const model = scriptedModel([...Array.from({ length: 8 }, (_, i) => search(`s${i}`)), finalTurn({}), finalTurn()]);
    const { state } = await runReview(initialContext(), src, model, parseConfig({ MAX_CONTEXT_CHARS: '12000' }));
    expect(model.received.every((request) => model.inputChars(request) <= 12000)).toBe(true);
    expect(state.requests).toBeLessThanOrEqual(10);
    expect(src.searchRepository).toHaveBeenCalledOnce();
    expect(model.received.at(-1)?.toolsEnabled).toBe(false);
  });
});
