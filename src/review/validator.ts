import { z } from 'zod';
import { findingSchema } from './schemas.js';
import type { ReviewFinding } from './schemas.js';
import type { Evidence } from '../agent/state.js';

export const candidateSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(findingSchema.omit({ id: true })).max(30),
});

export function validateCandidate(input: unknown, evidence: ReadonlyMap<string, Evidence>, threshold: number):
  { ok: false; issues: string } | { ok: true; summary: string; findings: ReviewFinding[]; rejected: number } {
  const result = candidateSchema.safeParse(input);
  if (!result.success) return { ok: false, issues: 'Return only summary and findings; use the declared field types and limits.' };
  for (const finding of result.data.findings) {
    const observed = evidence.get(finding.file);
    if (!observed?.hasCode) return { ok: false, issues: 'A finding references a file whose code was not observed. Remove unsupported findings.' };
    if (finding.line !== null && !observed.headLines.has(finding.line)) return { ok: false, issues: 'A finding references an unobserved head line. Correct the location using observed evidence; use null for base-side evidence.' };
  }
  const seen = new Set<string>();
  const findings: ReviewFinding[] = [];
  for (const finding of result.data.findings) {
    if (finding.confidence < threshold) continue;
    const key = JSON.stringify(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...finding, id: `F${findings.length + 1}` });
  }
  return { ok: true, summary: result.data.summary, findings, rejected: result.data.findings.length - findings.length };
}
