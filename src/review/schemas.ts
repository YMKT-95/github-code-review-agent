import { z } from 'zod';

const text = z.string().trim().min(1).max(4000);
export const filePath = text.refine(
  (value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => part === '..' || part === '.' || part === '') && !/[\u0000-\u001f\u007f]/.test(value),
  'Expected a repository-relative file path',
);

export const findingSchema = z.strictObject({
  id: text,
  severity: z.enum(['high', 'medium', 'low']),
  category: z.enum(['correctness', 'error-handling', 'input-validation', 'security', 'tests', 'maintainability']),
  title: text,
  file: filePath,
  line: z.number().int().positive().nullable(),
  description: text,
  impact: text,
  evidence: text,
  suggestion: text,
  confidence: z.number().min(0).max(1),
});

export const coverageSchema = z.strictObject({
  changedFiles: z.number().int().nonnegative(),
  changedFilesInspected: z.number().int().nonnegative(),
  additionalFilesInspected: z.array(filePath),
  testsInspected: z.array(filePath),
  checksInspected: z.boolean(),
  limitations: z.array(text),
  completionReason: z.enum(['sufficient-evidence', 'step-limit', 'context-limit', 'tool-failure', 'partial-diff', 'mock']),
}).refine((value) => value.changedFilesInspected <= value.changedFiles, {
  message: 'Inspected changed files cannot exceed the changed-file count',
  path: ['changedFilesInspected'],
});

export const reviewResultSchema = z.strictObject({
  summary: text,
  findings: z.array(findingSchema).max(30),
  coverage: coverageSchema,
  reviewedAt: z.iso.datetime(),
});

export type ReviewFinding = z.infer<typeof findingSchema>;
export type ReviewCoverage = z.infer<typeof coverageSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export function validateReviewResult(input: unknown, inspectedFiles: ReadonlySet<string>): ReviewResult {
  const result = reviewResultSchema.parse(input);
  if (result.findings.some((finding) => !inspectedFiles.has(finding.file))) {
    throw new Error('A finding references a file that was not inspected.');
  }
  return result;
}
