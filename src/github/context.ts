import { z } from 'zod';
import type { Config } from '../config.js';
import { GitHubError } from './errors.js';
import type { GitHubReadAdapter } from './tool-adapter.js';

const count = z.number().int().nonnegative();
const branch = z.object({ ref: z.string().max(1024), sha: z.string().regex(/^[a-f0-9]{40,64}$/i), repo: z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).nullish() });
export const metadataSchema = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullish(),
  user: z.object({ login: z.string().max(256) }).nullish(), head: branch, base: branch,
  // GitHub's minimal representation omits zero-valued fields.
  changed_files: count.default(0), additions: count.default(0), deletions: count.default(0),
});
const fileSchema = z.object({
  filename: z.string().min(1).max(4096).refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '.' || !s) && !/[\u0000-\u001f\u007f]/.test(p)),
  status: z.string().max(64).optional(), additions: count.default(0), deletions: count.default(0),
  patch: z.string().optional(), previous_filename: z.string().max(4096).optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
export type CollectedFile = z.infer<typeof fileSchema> & { patchTruncated: boolean };
export type InitialContext = {
  metadata: Metadata;
  files: CollectedFile[];
  status: string | null;
  limitations: string[];
  retainedChars: number;
  collectedAt: string;
  revisionStable: boolean;
};

export function sanitiseText(text: string, secrets: readonly string[] = []): string {
  let value = text;
  for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
  return value.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const marker = '[TRUNCATED]';
  return { text: limit < marker.length ? marker.slice(0, limit) : text.slice(0, limit - marker.length) + marker, truncated: true };
}

export async function collectInitialContext(adapter: GitHubReadAdapter, config: Config, secrets: readonly string[] = []): Promise<InitialContext> {
  const limitations: string[] = [];
  const note = (message: string) => { if (!limitations.includes(message)) limitations.push(message); };
  const clean = (value: string) => sanitiseText(value, secrets);
  const raw = metadataSchema.safeParse(await adapter.read({ method: 'get' }));
  if (!raw.success) throw new GitHubError('schema');
  let metadata = raw.data;
  const body = truncateText(clean(metadata.body ?? ''), Math.floor(Math.min(config.MAX_TOOL_RESULT_CHARS, config.MAX_CONTEXT_CHARS) / 2));
  const title = truncateText(clean(metadata.title), 512);
  metadata = { ...metadata, title: title.text, body: body.text,
    user: metadata.user ? { login: clean(metadata.user.login) } : null,
    head: { ...metadata.head, ref: clean(metadata.head.ref) }, base: { ...metadata.base, ref: clean(metadata.base.ref) },
  };
  let retainedChars = JSON.stringify(metadata).length;
  if (retainedChars > Math.min(config.MAX_CONTEXT_CHARS, config.MAX_TOOL_RESULT_CHARS)) throw new GitHubError('limit');
  if (body.truncated || title.truncated) note('PR title or description was truncated.');
  const files: CollectedFile[] = [];
  const visited = new Set<string>();
  // A fixed page size prevents offset drift on the last page. At most 100 calls.
  const perPage = Math.min(20, config.MAX_FILES_TO_INSPECT);
  const target = Math.min(metadata.changed_files, config.MAX_FILES_TO_INSPECT, 2000);
  for (let page = 1; files.length < target && page <= 100; page++) {
    let items: z.infer<typeof fileSchema>[];
    try {
      items = z.array(fileSchema).max(100).parse(await adapter.read({ method: 'get_files', page, perPage }));
    } catch {
      note('Changed-file retrieval failed or returned invalid data; remaining files were not collected.');
      break;
    }
    let pageChars = 0;
    let stop = false;
    const pending: { index: number; patch: string }[] = [];
    // Retain the inventory first. Patch allocation cannot crowd out later names.
    for (const item of items) {
      if (files.length >= target) break;
      if (visited.has(item.filename)) { note('Duplicate changed-file results prevented reliable pagination.'); stop = true; break; }
      visited.add(item.filename);
      const { patch, ...info } = item;
      // Keep identifiers unchanged for exact allow-list matching; redact display data later.
      const file: CollectedFile = { ...info, patchTruncated: Boolean(patch) };
      const size = JSON.stringify(file).length;
      if (retainedChars + size > config.MAX_CONTEXT_CHARS || pageChars + size > config.MAX_TOOL_RESULT_CHARS) {
        note('Context or tool-result character budget exhausted.'); stop = true; break;
      }
      files.push(file); retainedChars += size; pageChars += size;
      if (patch) pending.push({ index: files.length - 1, patch: clean(patch) });
      else note('Some changed files have no textual patch (for example binary files or server omissions).');
    }
    for (const entry of pending) {
      const file = files[entry.index]!;
      const before = JSON.stringify(file).length;
      // Reserve half the remaining total capacity for future page inventories.
      const available = Math.min(Math.floor((config.MAX_CONTEXT_CHARS - retainedChars) / 2), config.MAX_TOOL_RESULT_CHARS - pageChars);
      let bounded = truncateText(entry.patch, config.MAX_PATCH_CHARS);
      let candidate = { ...file, patch: bounded.text, patchTruncated: bounded.truncated };
      while (JSON.stringify(candidate).length - before > available && candidate.patch.length) {
        bounded = truncateText(entry.patch, Math.floor(candidate.patch.length / 2));
        candidate = { ...file, patch: bounded.text, patchTruncated: true };
      }
      const added = JSON.stringify(candidate).length - before;
      if (added <= available) {
        files[entry.index] = candidate; retainedChars += added; pageChars += added;
      }
      if (files[entry.index]!.patchTruncated) note('Some patches were truncated by the configured character budgets.');
    }
    if (stop || items.length < perPage) break;
  }
  if (files.length < metadata.changed_files) note('Only part of the changed-file list was collected due to limits or unavailable data.');
  let status: string | null = null;
  if (adapter.supports('get_status')) {
    try {
      const result = z.object({ state: z.enum(['pending', 'success', 'failure', 'error']) }).parse(await adapter.read({ method: 'get_status' }));
      if (retainedChars + result.state.length <= config.MAX_CONTEXT_CHARS) {
        status = result.state; retainedChars += status.length;
      } else note('Commit status was omitted because the context budget was exhausted.');
    } catch { note('Combined commit status unavailable; continuing with reduced context.'); }
  } else note('The connected MCP server does not advertise combined commit status.');
  let revisionStable = false;
  // Detect a changing PR rather than presenting mixed revisions as a coherent snapshot.
  try {
    const end = metadataSchema.parse(await adapter.read({ method: 'get' }));
    revisionStable = end.head.sha === metadata.head.sha && end.base.sha === metadata.base.sha && end.changed_files === metadata.changed_files;
    if (!revisionStable) {
      note('PR revisions changed during retrieval. Collected context may be inconsistent; rerun before reviewing.');
    }
  } catch { note('PR revision stability could not be verified after retrieval.'); }
  return { metadata, files, status, limitations, retainedChars, revisionStable, collectedAt: new Date().toISOString() };
}
