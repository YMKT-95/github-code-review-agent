import { z } from 'zod';
import type { McpConnection, McpTool } from './mcp-client.js';
import type { PullRequestReference } from './pr-url.js';
import { GitHubError } from './errors.js';
import type { InitialContext } from './context.js';
import { filePath } from '../review/schemas.js';

export const changedFileRequestSchema = z.strictObject({ path: filePath, revision: z.enum(['head', 'base']) });

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
    readonly canReadFiles: boolean,
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
    const fileTools = tools.filter((item) => item.name === 'get_file_contents');
    const fileTool = fileTools[0];
    const canReadFiles = fileTools.length === 1 && fileTool?.annotations?.readOnlyHint !== false &&
      ['owner', 'repo', 'path', 'ref'].every((key) => key in (fileTool?.inputSchema.properties ?? {}));
    return new GitHubReadAdapter(connection, { ...pr }, new Set(method.data.enum), timeoutMs, trace, canReadFiles);
  }

  supports(method: ReadRequest['method']): boolean { return this.methods.has(method); }

  async readChangedFile(input: unknown, context: InitialContext): Promise<string> {
    const request = changedFileRequestSchema.safeParse(input);
    if (!this.canReadFiles || !request.success) throw new GitHubError('permission');
    const { path, revision } = request.data;
    const file = context.files.find((item) => item.filename === path);
    if (!file || (revision === 'head' && file.status === 'removed') || (revision === 'base' && file.status === 'added')) throw new GitHubError('permission');
    const fullName = revision === 'head' ? context.metadata.head.repo?.full_name : `${this.pr.owner}/${this.pr.repository}`;
    if (!fullName) throw new GitHubError('permission');
    const [owner, repo] = fullName.split('/');
    const actualPath = revision === 'base' ? file.previous_filename ?? path : path;
    if (!filePath.safeParse(actualPath).success) throw new GitHubError('permission');
    try {
      const result = await withDeadline(() => this.connection.callTool('get_file_contents', {
        owner, repo, path: actualPath, ref: context.metadata[revision].sha,
      }), this.timeoutMs);
      const envelope = z.object({ isError: z.boolean().optional(), content: z.array(z.unknown()).optional(), structuredContent: z.unknown().optional() }).parse(result);
      if (envelope.isError) throw new GitHubError('tool');
      const blocks = envelope.content ?? [];
      const resources = blocks.filter((item) => typeof item === 'object' && item !== null && 'type' in item && item.type === 'resource');
      let text: string;
      if (resources.length === 1) {
        text = z.object({ resource: z.object({ text: z.string().max(1_000_000) }) }).parse(resources[0]).resource.text;
      } else {
        const value = envelope.structuredContent ?? JSON.parse(z.array(z.object({ type: z.literal('text'), text: z.string().max(2_000_000) })).length(1).parse(blocks)[0]!.text);
        const fileData = z.object({ type: z.literal('file'), encoding: z.enum(['base64', 'utf-8', 'utf8']), content: z.string().max(1_500_000) }).parse(value);
        if (fileData.encoding === 'base64') {
          const encoded = fileData.content.replace(/\s/g, '');
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new GitHubError('schema');
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
        } else text = fileData.content;
      }
      if (text.includes('\0') || text.length > 1_000_000) throw new GitHubError('schema');
      this.trace({ operation: 'get_file_contents', outcome: 'ok' });
      return text;
    } catch (error) {
      this.trace({ operation: 'get_file_contents', outcome: 'failed' });
      throw error instanceof GitHubError ? error : new GitHubError('tool');
    }
  }

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
