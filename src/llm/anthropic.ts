import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import type { LlmConfig } from '../config.js';
import { CONTEXT_TOOLS, REVIEW_POLICY } from '../agent/prompts.js';
import { candidateSchema } from '../review/validator.js';
import { ReviewError } from './types.js';
import type { LlmClient, ModelRequest, ModelTurn } from './types.js';

export function createAnthropic(config: LlmConfig, fetcher: typeof fetch = fetch): LlmClient {
  const sdk = new Anthropic({ apiKey: config.apiKey, baseURL: 'https://api.anthropic.com',
    maxRetries: 0, timeout: config.timeoutMs, logLevel: 'off',
    fetch: async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).origin !== 'https://api.anthropic.com') throw new ReviewError('provider');
      const response = await fetcher(input, { ...init, redirect: 'error' });
      if (!response.body) return response;
      let size = 0;
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > 1_000_000) throw new ReviewError('protocol');
          controller.enqueue(chunk);
        },
      })), { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  const format = zodOutputFormat(candidateSchema);
  const params = (request: ModelRequest): MessageCreateParamsNonStreaming => {
    const tools = CONTEXT_TOOLS.filter((tool) => (request.availableTools ?? ['read_changed_file']).some((name) => name === tool.name));
    return ({
    model: config.model, max_tokens: config.maxOutputTokens, system: REVIEW_POLICY,
    thinking: { type: 'disabled' },
    messages: request.messages.map((message) => {
      if ('content' in message) return { role: 'user', content: message.content };
      if ('call' in message) return { role: 'assistant', content: [{ type: 'tool_use', ...message.call }] };
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.result.id, content: message.result.content, is_error: message.result.error }] };
    }),
    // Keep definitions on finalisation calls so prior tool results remain valid;
    // tool_choice:none disables new calls without altering conversation history.
    ...(tools.length ? { tools, tool_choice: request.toolsEnabled ? { type: 'auto' as const, disable_parallel_tool_use: true } : { type: 'none' as const } } : {}),
    output_config: { format },
    stream: false,
  }); };
  return {
    inputChars: (request) => JSON.stringify(params(request)).length,
    async turn(request, signal): Promise<ModelTurn> {
      if (JSON.stringify(params(request)).length > config.maxContextChars) throw new ReviewError('budget');
      try {
        const response = await sdk.messages.create(params(request), { signal });
        const usage = { inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0), outputTokens: response.usage.output_tokens };
        if (response.stop_reason === 'refusal') throw new ReviewError('refusal');
        if (response.stop_reason === 'max_tokens') return { kind: 'final', candidate: null, usage };
        if (response.content.some((block) => block.type !== 'text' && block.type !== 'tool_use')) throw new ReviewError('protocol');
        const calls = response.content.filter((block) => block.type === 'tool_use');
        if (response.stop_reason === 'tool_use') {
          const call = calls[0];
          if (!request.toolsEnabled || calls.length !== 1 || !call || JSON.stringify(call).length > 2048) throw new ReviewError('protocol');
          return { kind: 'tool', call: { id: call.id, name: call.name, input: call.input }, usage };
        }
        if (response.stop_reason !== 'end_turn' || calls.length) throw new ReviewError('protocol');
        const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
        let candidate: unknown = null;
        try { candidate = JSON.parse(text); } catch { /* The loop owns the single repair. */ }
        return { kind: 'final', candidate, usage };
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        if (signal.aborted) throw new ReviewError('timeout');
        throw new ReviewError('provider');
      }
    },
  };
}
