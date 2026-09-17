import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { GitHubConfig } from '../config.js';
import { GitHubError } from './errors.js';

export const MCP_ENDPOINT = 'https://api.githubcopilot.com/mcp/';
export const MAX_RESPONSE_BYTES = 2_000_000;

export type McpTool = { name: string; inputSchema: { type?: string | undefined; properties?: Record<string, unknown> | undefined }; annotations?: { readOnlyHint?: boolean | undefined } | undefined };
export interface McpConnection {
  listTools(cursor?: string): Promise<{ tools: McpTool[]; nextCursor?: string | undefined }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

// Bound HTTP bodies before SDK JSON/SSE parsing. Refuse redirects and other origins
// so credentials cannot be forwarded to a URL supplied by remote content.
export function boundedFetch(timeoutMs: number, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(MCP_ENDPOINT).origin || url.username || url.password) throw new GitHubError('permission');
    const signals = [AbortSignal.timeout(timeoutMs)];
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal) signals.push(signal);
    const response = await fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new GitHubError('limit');
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function connectGitHub(config: GitHubConfig): Promise<McpConnection> {
  const client = new Client({ name: 'github-code-review-agent', version: '0.4.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), {
    requestInit: { headers: {
      Authorization: `Bearer ${config.token}`,
      'X-MCP-Readonly': 'true',
      'X-MCP-Toolsets': 'pull_requests',
      'X-MCP-Tools': 'pull_request_read,get_file_contents,search_code',
    } },
    fetch: boundedFetch(config.timeoutMs),
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    onInsufficientScope: 'throw',
  });
  const options = () => ({ timeout: config.timeoutMs, signal: AbortSignal.timeout(config.timeoutMs) });
  try {
    await client.connect(transport, options());
  } catch {
    await client.close().catch(() => undefined);
    throw new GitHubError('connection');
  }
  return {
    async listTools(cursor) {
      return client.listTools(cursor ? { cursor } : {}, options());
    },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args }, options());
    },
    async close() { await client.close(); },
  };
}
