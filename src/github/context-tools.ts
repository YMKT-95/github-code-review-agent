import { z } from 'zod';
import { filePath } from '../review/schemas.js';

const revision = z.enum(['head', 'base']);
export const repositoryFileRequestSchema = z.strictObject({
  path: filePath, revision,
  startLine: z.number().int().min(1).max(1_000_000),
});
export const directoryRequestSchema = z.strictObject({
  path: z.union([z.literal(''), filePath]), revision,
});
// Terms, not arbitrary GitHub search expressions. The adapter owns repo scoping.
export const searchRequestSchema = z.strictObject({
  term: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/),
  kind: z.enum(['code', 'tests']),
});
export const isTestPath = (path: string) => /(^|\/)(__tests__|tests?|specs?)(\/|$)|[.](test|spec)[.]|(^|\/)test_[^/]+|_test[.]/i.test(path);
export type DirectoryResult = { entries: { path: string; type: 'file' | 'dir' }[]; truncated: boolean };
export type SearchResult = { paths: string[]; incomplete: boolean };
