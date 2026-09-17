export type ToolCall = { id: string; name: string; input: unknown };
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; call: ToolCall }
  | { role: 'user'; result: { id: string; content: string; error: boolean } };
export type ModelToolName = 'read_changed_file' | 'read_repository_file' | 'list_directory' | 'search_repository';
export type ModelRequest = { messages: Message[]; toolsEnabled: boolean; availableTools?: ModelToolName[] };
export type Usage = { inputTokens: number; outputTokens: number };
export type ModelTurn = ({ kind: 'tool'; call: ToolCall } | { kind: 'final'; candidate: unknown }) & { usage: Usage };
export interface LlmClient {
  inputChars(request: ModelRequest): number;
  turn(request: ModelRequest, signal: AbortSignal): Promise<ModelTurn>;
}

export class ReviewError extends Error {
  constructor(public readonly kind: 'provider' | 'timeout' | 'protocol' | 'refusal' | 'invalid-output' | 'budget' | 'revision') {
    super({
      provider: 'Anthropic request failed. Check API access, model availability, quota and network connectivity.',
      timeout: 'Model request timed out. No review was saved.',
      protocol: 'The model returned an unsupported tool-call or response format. No review was saved.',
      refusal: 'The model declined this review. No review was saved.',
      'invalid-output': 'The final review was invalid after one repair attempt. No review was saved.',
      budget: 'The configured context budget cannot fit the required model input. No review was saved.',
      revision: 'PR revision stability could not be established. Rerun before starting a model review.',
    }[kind]);
  }
}
