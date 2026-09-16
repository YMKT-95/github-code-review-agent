import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedFetch, connectGitHub, MAX_RESPONSE_BYTES, MCP_ENDPOINT } from '../src/github/mcp-client.js';
import { readTool, prMetadata, textResult } from './fixtures/mcp.js';

afterEach(() => vi.unstubAllGlobals());

describe('official MCP SDK transport with mocked HTTP', () => {
  it('negotiates MCP, discovers tools, calls a tool, and sends read-only headers', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
      expect(new Headers(init?.headers).get('x-mcp-readonly')).toBe('true');
      expect(new Headers(init?.headers).get('x-mcp-toolsets')).toBe('pull_requests');
      expect(init?.redirect).toBe('error');
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock-github', version: '1.0' } }
        : request.method === 'tools/list' ? { tools: [readTool] } : textResult(prMetadata);
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    });
    vi.stubGlobal('fetch', fetcher);
    const connection = await connectGitHub({ token: 'synthetic-token', timeoutMs: 1000 });
    try {
      expect((await connection.listTools()).tools[0]?.name).toBe('pull_request_read');
      expect(await connection.callTool('pull_request_read', { method: 'get', owner: 'owner', repo: 'repository', pullNumber: 42 })).toEqual(textResult(prMetadata));
      expect(requests.map((request) => request.method)).toContain('tools/call');
    } finally { await connection.close(); }
  });
  it('does not leak provider errors on connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic-token private source'); }));
    await expect(connectGitHub({ token: 'synthetic-token', timeoutMs: 1000 })).rejects.toThrow('Could not connect');
  });
});

describe('HTTP resource boundaries', () => {
  it('rejects foreign origins before making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(boundedFetch(1000, fetcher)('https://evil.test/')).rejects.toThrow('allow-list');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects oversized response bodies while streaming', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('a'.repeat(MAX_RESPONSE_BYTES + 1)));
    const response = await boundedFetch(1000, fetcher)(MCP_ENDPOINT);
    await expect(response.text()).rejects.toThrow('size limit');
  });
  it('aborts stalled HTTP requests at the deadline', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await expect(boundedFetch(10, fetcher)(MCP_ENDPOINT)).rejects.toThrow('aborted');
  });
});
