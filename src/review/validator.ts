import { z } from 'zod';
import { findingSchema } from './schemas.js';
import type { ReviewFinding, FindingSelection } from './schemas.js';
import type { Evidence } from '../agent/state.js';
import { compareFindings, duplicateKey } from './ordering.js';

export const candidateSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(findingSchema.omit({ id: true })).max(30),
});

export function validateCandidate(input: unknown, evidence: ReadonlyMap<string, Evidence>, threshold: number):
  { ok: false; issues: string } | { ok: true; summary: string; findings: ReviewFinding[]; rejected: number; selection: FindingSelection } {
  const result = candidateSchema.safeParse(input);
  if (!result.success) return { ok: false, issues: 'Return only summary and findings; use the declared field types and limits.' };
  for (const finding of result.data.findings) {
    const observed = evidence.get(finding.file);
    if (!observed?.hasCode) return { ok: false, issues: 'A finding references a file whose code was not observed. Remove unsupported findings.' };
    if (finding.line !== null && !observed.headLines.has(finding.line)) return { ok: false, issues: 'A finding references an unobserved head line. Correct the location using observed evidence; use null for base-side evidence.' };
  }
  const unique = new Map<string, Omit<ReviewFinding, 'id'>>();
  let lowConfidence = 0;
  let duplicates = 0;
  for (const finding of result.data.findings) {
    if (finding.confidence < threshold) { lowConfidence++; continue; }
    const key = duplicateKey(finding);
    const previous = unique.get(key);
    if (previous) {
      duplicates++;
      // Keep one complete original record: highest confidence, then normal order.
      // Do not invent a merged impact/severity from separate model statements.
      if (finding.confidence > previous.confidence ||
          (finding.confidence === previous.confidence && compareFindings(finding, previous) < 0)) unique.set(key, finding);
    } else unique.set(key, finding);
  }
  const findings = [...unique.values()].sort(compareFindings).map((finding, index) => ({ ...finding, id: `F${index + 1}` }));
  const rejected = lowConfidence + duplicates;
  // Filtering can invalidate any claim in the original free-text summary. Build
  // its replacement from retained counts instead of trying to edit model prose
  // or spending another model request that could introduce new contradictions.
  const summary = rejected === 0 ? (findings.length ? result.data.summary
    : 'No reportable findings were returned for the supplied code. See Review Coverage for scope and limitations; this does not establish that the code is bug-free.') : [
    findings.length === 0 ? 'No reportable findings remain after filtering.'
      : `${findings.length} reportable ${findings.length === 1 ? 'finding remains' : 'findings remain'} after filtering.`,
    lowConfidence ? `${lowConfidence} candidate ${lowConfidence === 1 ? 'finding was' : 'findings were'} excluded because confidence was below the configured threshold.` : '',
    duplicates ? `${duplicates} duplicate ${duplicates === 1 ? 'finding was' : 'findings were'} removed.` : '',
    'See Findings for retained issues and Review Coverage for scope and limitations.',
  ].filter(Boolean).join(' ');
  const selection = { candidates: result.data.findings.length, retained: findings.length, lowConfidence, duplicates, threshold };
  return { ok: true, summary, findings, rejected, selection };
}
