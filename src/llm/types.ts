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
  constructor(public readonly kind: 'provider' | 'authentication' | 'access' | 'billing' | 'model' | 'rate-limit' | 'request' | 'unavailable' | 'network' | 'timeout' | 'protocol' | 'refusal' | 'invalid-output' | 'budget' | 'revision') {
    super({
      provider: 'Anthropic request failed. Check API access, model availability, quota and network connectivity.',
      authentication: 'Anthropic authentication failed. Check LLM_API_KEY in your local environment or .env.',
      access: 'Anthropic denied access. Check the key workspace and model permissions in the Console.',
      billing: 'Anthropic requires payment. Check your API credit balance in the Console.',
      model: 'Anthropic could not find the requested resource. Check LLM_MODEL and its availability to your account.',
      'rate-limit': 'Anthropic rate limit reached. Wait before starting another review or check your Console limits. No automatic retry was made.',
      request: 'Anthropic rejected the request. Check model support for tools, structured outputs and disabled thinking, request limits, and Console billing status.',
      unavailable: 'Anthropic is temporarily unavailable. Try again later. No automatic retry was made.',
      network: 'Could not reach Anthropic. Check network access. No automatic retry was made.',
      timeout: 'Model request timed out. No review was saved.',
      protocol: 'The model returned an unsupported tool-call or response format. No review was saved.',
      refusal: 'The model declined this review. No review was saved.',
      'invalid-output': 'The final review was invalid after one repair attempt. No review was saved.',
      budget: 'The configured context budget cannot fit the required model input. No review was saved.',
      revision: 'PR revision stability could not be established. Rerun before starting a model review.',
    }[kind]);
  }
}
