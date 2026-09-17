import type { Config } from '../config.js';
import type { InitialContext } from '../github/context.js';
import { changedFileRequestSchema } from '../github/tool-adapter.js';
import type { GitHubReadAdapter } from '../github/tool-adapter.js';
import { directoryRequestSchema, repositoryFileRequestSchema, searchRequestSchema } from '../github/context-tools.js';
import type { ModelToolName, ToolCall } from '../llm/types.js';
import type { AgentState } from './state.js';

export type ReadSource = Pick<GitHubReadAdapter, 'canReadFiles' | 'readChangedFile'> &
  Partial<Pick<GitHubReadAdapter, 'canSearchCode' | 'readRepositoryFile' | 'listDirectory' | 'searchRepository'>>;
type Observation = { content: string; error: boolean; evidence?: { path: string; lines: number[]; hasCode: boolean } };
const message = (content: string, error = true): Observation => ({ content, error });
const MAX_CACHE_CHARS = 2_000_000;

export class ContextRetrieval {
  readonly tools: ModelToolName[] = [];
  private files = new Map<string, string | null>();
  private cacheChars = 0;
  constructor(private readonly context: InitialContext, private readonly source: ReadSource,
    private readonly state: AgentState, private readonly config: Config, private readonly clean: (text: string) => string) {
    if (source.canReadFiles) {
      this.tools.push('read_changed_file');
      if (source.readRepositoryFile) this.tools.push('read_repository_file');
      if (source.listDirectory) this.tools.push('list_directory');
    }
    if (source.canSearchCode && source.searchRepository) this.tools.push('search_repository');
  }

  async execute(call: ToolCall, available: number): Promise<Observation> {
    if (!this.tools.some((tool) => tool === call.name)) return this.denied();
    try {
      if (call.name === 'search_repository') {
        const parsed = searchRequestSchema.safeParse(call.input);
        if (!parsed.success) return this.denied();
        const key = JSON.stringify(['search', parsed.data.term.toLowerCase(), parsed.data.kind]);
        if (this.repeated(key)) return message('This search was already requested. Reuse the earlier observation.', false);
        this.state.toolCalls++;
        const result = await this.source.searchRepository!(parsed.data, this.context);
        this.state.note('Code search uses an index, not the reviewed SHA; results are discovery hints and may omit files or tests.');
        if (result.incomplete) this.state.note('Code search results were partial or filtered. No matches do not establish absence of code or tests.');
        const paths = result.paths.map(this.clean);
        const observation = () => JSON.stringify({ kind: 'untrusted-search-hints', paths, incomplete: result.incomplete,
          instruction: 'Read these files at the recorded head/base SHA before citing code. Search is not exhaustive or revision-pinned.' });
        while (paths.length && !this.fits(observation(), available)) { paths.pop(); result.incomplete = true; }
        if (paths.length < result.paths.length) this.state.note('Search paths were truncated by the observation budget.');
        return this.bounded(observation(), available);
      }
      if (call.name === 'list_directory') {
        const parsed = directoryRequestSchema.safeParse(call.input);
        if (!parsed.success) return this.denied();
        const { path, revision } = parsed.data;
        if (this.repeated(JSON.stringify(['directory', revision, path]))) return message('This directory was already requested. Reuse the earlier observation.', false);
        this.state.toolCalls++;
        const result = await this.source.listDirectory!(parsed.data, this.context);
        const entries = result.entries.map((item) => ({ ...item, path: this.clean(item.path) }));
        const observation = () => JSON.stringify({ kind: 'untrusted-directory', path: this.clean(path), revision,
          sha: this.context.metadata[revision].sha, entries, truncated: result.truncated });
        while (entries.length && !this.fits(observation(), available)) { entries.pop(); result.truncated = true; }
        if (result.truncated) this.state.note('A directory listing was partial; omitted entries do not establish absence of code or tests.');
        return this.bounded(observation(), available);
      }
      const changedOnly = call.name === 'read_changed_file';
      const parsed = changedOnly
        ? changedFileRequestSchema.transform((value) => ({ ...value, startLine: 1 })).safeParse(call.input)
        : repositoryFileRequestSchema.safeParse(call.input);
      if (!parsed.success) return this.denied();
      const { path, revision, startLine } = parsed.data;
      const file = this.context.files.find((item) => item.filename === path);
      if (changedOnly && (!file || (revision === 'head' && file.status === 'removed') || (revision === 'base' && file.status === 'added'))) return this.denied();
      const actualPath = changedOnly && revision === 'base' ? file?.previous_filename ?? path : path;
      // Findings on old filenames are attributed to the changed file, with null
      // line numbers for base-only evidence. Cache keys always use literal paths.
      const evidencePath = revision === 'base'
        ? this.context.files.find((item) => item.previous_filename === actualPath)?.filename ?? path : path;
      const resourceKey = JSON.stringify([revision, this.context.metadata[revision].repo?.full_name, this.context.metadata[revision].sha, actualPath]);
      if (this.repeated(JSON.stringify(['file-range', resourceKey, startLine]))) return message('This resource was already requested. Reuse its earlier observation; no additional read occurred.', false);
      if (!this.state.evidence.has(evidencePath) && this.state.evidence.size >= this.config.MAX_FILES_TO_INSPECT) {
        this.state.reason = 'context-limit'; this.state.note('File inspection budget reached.');
        return message('File inspection budget reached.');
      }
      if (!this.files.has(resourceKey)) {
        this.files.set(resourceKey, null); // Also cache failures; no implicit retries.
        if (this.cacheChars >= MAX_CACHE_CHARS) {
          this.state.note('Repository file cache budget reached.');
          return message('File cache budget reached. No file was read.');
        }
        this.state.toolCalls++;
        const raw = changedOnly ? await this.source.readChangedFile({ path, revision }, this.context)
          : await this.source.readRepositoryFile!(parsed.data, this.context);
        const text = this.clean(raw);
        if (text.length > 1_000_000 || this.cacheChars + text.length > MAX_CACHE_CHARS) {
          this.state.note('A retrieved file exceeded the file cache budget and was not supplied to the model.');
          return message('File content unavailable within the cache budget.');
        }
        this.files.set(resourceKey, text); this.cacheChars += text.length;
      }
      const text = this.files.get(resourceKey);
      if (text === null || text === undefined) return message('This file was previously unavailable. No retry was made.');
      const allLines = text ? text.split('\n') : [];
      if (allLines.at(-1) === '') allLines.pop();
      const lines: { line: number; text: string }[] = [];
      const base = { kind: 'untrusted-file', path: this.clean(path), evidencePath: this.clean(evidencePath), revision,
        sha: this.context.metadata[revision].sha, startLine };
      for (let index = startLine - 1; index < allLines.length && lines.length < 200; index++) {
        const item = { line: index + 1, text: allLines[index]! };
        const test = JSON.stringify({ ...base, lines: [...lines, item], truncated: true, nextStartLine: index + 2 });
        if (!this.fits(test, available) || test.length > this.config.MAX_PATCH_CHARS) break;
        lines.push(item);
      }
      const next = startLine + lines.length;
      const truncated = startLine > 1 || next <= allLines.length;
      const content = JSON.stringify({ ...base, lines, truncated, nextStartLine: lines.length && next <= allLines.length ? next : null });
      if (truncated) this.state.note('Some requested file content was truncated or supplied as a range; only complete delivered lines count as evidence.');
      if (startLine > allLines.length && allLines.length) return message('Requested range starts beyond the end of the file.');
      if (!this.fits(content, available) || content.length > this.config.MAX_PATCH_CHARS) return this.bounded('', 0);
      return { content, error: false, evidence: { path: evidencePath,
        lines: revision === 'head' ? lines.map((item) => item.line) : [], hasCode: lines.length > 0 } };
    } catch {
      this.state.note('At least one requested context tool failed or returned unavailable data.');
      if (this.state.reason === 'sufficient-evidence') this.state.reason = 'tool-failure';
      return message('Context retrieval unavailable or denied. Do not infer a defect from missing context.');
    }
  }

  private repeated(key: string) {
    if (this.state.visited.has(key)) return true;
    this.state.visited.add(key); return false;
  }
  private fits(content: string, available: number) { return JSON.stringify(content).length <= available; }
  private bounded(content: string, available: number): Observation {
    if (this.fits(content, available)) return message(content, false);
    this.state.reason = 'context-limit';
    this.state.note('A context observation could not fit the configured character budget.');
    return message('Context budget reached. No observation was supplied.');
  }
  private denied() {
    this.state.note('An unsupported tool request was denied.');
    return message('Tool denied. Use only advertised tools with their declared arguments and repository-relative paths.');
  }
}
