import { describe, expect, it, vi } from 'vitest';
import { createAnthropic } from '../src/llm/anthropic.js';
import { candidate } from './fixtures/agent.js';
import type { ModelRequest } from '../src/llm/types.js';

const settings = { apiKey: 'synthetic-api-key', model: 'claude-test-model', timeoutMs: 1000, maxOutputTokens: 8192, maxContextChars: 100000 };
const request: ModelRequest = { messages: [{ role: 'user', content: 'Review synthetic code.' }], toolsEnabled: true };
const message = (content: unknown[], stop_reason = 'end_turn') => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: settings.model,
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
});
const text = (value: unknown) => [{ type: 'text', text: JSON.stringify(value) }];

describe('Anthropic SDK with mocked HTTP', () => {
  it('uses strict tools and structured JSON, scopes credentials, and measures the actual body', async () => {
    let body: Record<string, unknown> = {};
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
      expect(new Headers(init?.headers).get('x-api-key')).toBe(settings.apiKey);
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(init?.redirect).toBe('error');
      body = JSON.parse(String(init?.body));
      return Response.json(message(text(candidate)));
    });
    const model = createAnthropic(settings, fetcher);
    const result = await model.turn(request, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'final', candidate, usage: { inputTokens: 10, outputTokens: 5 } });
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.tools).toMatchObject([{ name: 'read_changed_file', strict: true }]);
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
    expect(model.inputChars(request)).toBe(JSON.stringify(body).length);
    expect(JSON.stringify(body)).not.toContain(settings.apiKey);
  });
  it('maps tool IDs and tool-result blocks while disabling calls during finalisation', async () => {
    let body: Record<string, unknown> = {};
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json(message(text(candidate)));
    });
    const model = createAnthropic(settings, fetcher);
    await model.turn({ toolsEnabled: false, messages: [
      ...request.messages,
      { role: 'assistant', call: { id: 'tool_1', name: 'read_changed_file', input: { path: 'src/a.ts', revision: 'head' } } },
      { role: 'user', result: { id: 'tool_1', content: 'File unavailable', error: true } },
    ] }, new AbortController().signal);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(body.messages).toMatchObject([
      {}, { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', is_error: true }] },
    ]);
  });
  it('normalises one tool call', async () => {
    const call = { type: 'tool_use', id: 'tool_1', name: 'read_changed_file', input: { path: 'a.ts', revision: 'head' } };
    const model = createAnthropic(settings, async () => Response.json(message([call], 'tool_use')));
    expect(await model.turn(request, new AbortController().signal)).toMatchObject({ kind: 'tool', call: { id: 'tool_1' } });
  });
  it('advertises only available context tools and retains definitions during finalisation', async () => {
    const bodies: Record<string, unknown>[] = [];
    const model = createAnthropic(settings, async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(message(text(candidate)));
    });
    const availableTools = ['read_repository_file', 'list_directory'] as const;
    for (const toolsEnabled of [true, false]) {
      const input = { ...request, toolsEnabled, availableTools: [...availableTools] };
      await model.turn(input, new AbortController().signal);
      expect(model.inputChars(input)).toBe(JSON.stringify(bodies.at(-1)).length);
    }
    expect(bodies[0]?.tools).toMatchObject([{ name: 'read_repository_file', strict: true }, { name: 'list_directory', strict: true }]);
    expect(bodies[0]?.tools).toEqual(bodies[1]?.tools);
    expect(bodies[1]?.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(bodies)).not.toContain('"name":"search_repository"');
  });
  it('rejects multiple tool calls without returning dispatchable calls', async () => {
    const call = { type: 'tool_use', id: 'tool_1', name: 'read_changed_file', input: {} };
    const model = createAnthropic(settings, async () => Response.json(message([call, { ...call, id: 'tool_2' }], 'tool_use')));
    await expect(model.turn(request, new AbortController().signal)).rejects.toThrow('unsupported tool-call');
  });
  it.each(['max_tokens', 'end_turn'])('routes truncated/invalid output to the single repair (%s)', async (reason) => {
    const model = createAnthropic(settings, async () => Response.json(message([{ type: 'text', text: '{bad' }], reason)));
    expect(await model.turn(request, new AbortController().signal)).toMatchObject({ kind: 'final', candidate: null });
  });
  it('treats refusal as a failure instead of an empty review', async () => {
    const model = createAnthropic(settings, async () => Response.json(message([], 'refusal')));
    await expect(model.turn(request, new AbortController().signal)).rejects.toThrow('declined');
  });
  it('does not retry rate limits or echo raw provider messages', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'synthetic-api-key private source' } }, { status: 429 }));
    const model = createAnthropic(settings, fetcher);
    await expect(model.turn(request, new AbortController().signal)).rejects.toThrow('Anthropic rate limit reached');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects oversized input before contacting the provider', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const model = createAnthropic({ ...settings, maxContextChars: 10 }, fetcher);
    await expect(model.turn(request, new AbortController().signal)).rejects.toThrow('context budget');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'authentication'], [403, 'access'], [402, 'billing'], [404, 'model'],
    [429, 'rate-limit'], [400, 'request'], [413, 'request'], [422, 'request'],
    [500, 'unavailable'], [529, 'unavailable'],
  ])('classifies HTTP %s safely as %s without retrying', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ type: 'error', error: { type: 'api_error', message: 'PRIVATE synthetic-api-key' } }, { status: status as number }));
    const model = createAnthropic(settings, fetcher);
    let caught: unknown;
    try { await model.turn(request, new AbortController().signal); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ kind });
    expect(String(caught)).not.toContain('PRIVATE'); expect(String(caught)).not.toContain(settings.apiKey);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('classifies network errors without leaking connection details', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('PRIVATE connection details'); });
    const model = createAnthropic(settings, fetcher);
    await expect(model.turn(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'network' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
