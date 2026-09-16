import { z } from 'zod';
import type { McpConnection, McpTool } from './mcp-client.js';
import type { PullRequestReference } from './pr-url.js';
import { GitHubError } from './errors.js';

const requestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('get') }),
  z.strictObject({ method: z.literal('get_files'), page: z.number().int().min(1).max(100), perPage: z.number().int().min(1).max(100) }),
  z.strictObject({ method: z.literal('get_status') }),
]);
export type ReadRequest = z.infer<typeof requestSchema>;
export type TraceEvent = { operation: string; outcome: 'ok' | 'failed' };

export async function withDeadline<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GitHubError('timeout')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export class GitHubReadAdapter {
  private constructor(
    private readonly connection: McpConnection,
    private readonly pr: PullRequestReference,
    private readonly methods: ReadonlySet<string>,
    private readonly timeoutMs: number,
    private readonly trace: (event: TraceEvent) => void,
  ) {}

  static async discover(connection: McpConnection, pr: PullRequestReference, timeoutMs: number, trace: (event: TraceEvent) => void = () => {}): Promise<GitHubReadAdapter> {
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 10; page++) {
        const result = await withDeadline(() => connection.listTools(cursor), timeoutMs);
        tools.push(...result.tools);
        if (tools.length > 1000) throw new GitHubError('limit');
        cursor = result.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || page === 9) throw new GitHubError('limit');
        cursors.add(cursor);
      }
    } catch (error) { throw error instanceof GitHubError ? error : new GitHubError('schema'); }
    // Explicit name AND explicit methods; server hints/descriptions never grant permission.
    const matches = tools.filter((tool) => tool.name === 'pull_request_read');
    const tool = matches[0];
    if (matches.length !== 1 || !tool || tool.annotations?.readOnlyHint === false) throw new GitHubError('permission');
    const method = z.object({ enum: z.array(z.string()) }).safeParse(tool.inputSchema.properties?.method);
    if (!method.success || !['get', 'get_files'].every((name) => method.data.enum.includes(name))) throw new GitHubError('permission');
    return new GitHubReadAdapter(connection, { ...pr }, new Set(method.data.enum), timeoutMs, trace);
  }

  supports(method: ReadRequest['method']): boolean { return this.methods.has(method); }

  async read(input: unknown): Promise<unknown> {
    const request = requestSchema.safeParse(input);
    if (!request.success || !this.methods.has(request.data.method)) throw new GitHubError('permission');
    const operation = `pull_request_read:${request.data.method}`;
    try {
      const result = await withDeadline(() => this.connection.callTool('pull_request_read', {
        ...request.data, owner: this.pr.owner, repo: this.pr.repository, pullNumber: this.pr.pullNumber,
      }), this.timeoutMs);
      const envelope = z.object({ isError: z.boolean().optional(), content: z.array(z.unknown()).optional(), structuredContent: z.unknown().optional() }).parse(result);
      if (envelope.isError) throw new GitHubError('tool');
      // Do not concatenate mixed blocks or follow resource links. Parse JSON before
      // truncating fields, so limits can never turn valid JSON into malformed JSON.
      let data: unknown;
      if (envelope.structuredContent !== undefined) data = envelope.structuredContent;
      else {
        const blocks = z.array(z.object({ type: z.literal('text'), text: z.string().max(2_000_000) })).length(1).parse(envelope.content);
        data = JSON.parse(blocks[0]!.text) as unknown;
      }
      if (request.data.method === 'get' && (!data || typeof data !== 'object' || !('number' in data) || data.number !== this.pr.pullNumber)) {
        throw new GitHubError('schema');
      }
      this.trace({ operation, outcome: 'ok' });
      return data;
    } catch (error) {
      this.trace({ operation, outcome: 'failed' });
      throw error instanceof GitHubError ? error : new GitHubError('tool');
    }
  }
}
