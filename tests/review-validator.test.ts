import { describe, expect, it } from 'vitest';
import { validateCandidate } from '../src/review/validator.js';
import { finding } from './fixtures/finding.js';

const { id: _id, ...candidateFinding } = finding;
const evidence = new Map([[finding.file, { hasCode: true, headLines: new Set([finding.line!]) }]]);
const originalSummary = 'Two correctness issues were found, including a speculative issue.';

describe('summary consistency after finding filtering', () => {
  it('removes claims about a finding excluded by the confidence threshold', () => {
    const result = validateCandidate({ summary: originalSummary, findings: [{ ...candidateFinding, confidence: 0.74 }] }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([]);
    expect(result.rejected).toBe(1);
    expect(result.summary).toContain('No reportable findings remain after filtering.');
    expect(result.summary).toContain('1 candidate finding was excluded');
    expect(result.summary).toContain('confidence');
    expect(result.summary).not.toContain('correctness issues');
  });

  it('describes only the retained count when some findings are excluded', () => {
    const retained = { ...candidateFinding, confidence: 0.75 };
    const result = validateCandidate({ summary: originalSummary, findings: [retained, { ...candidateFinding, confidence: 0.5 }] }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([{ ...retained, id: 'F1' }]);
    expect(result.summary).toContain('1 reportable finding remains after filtering.');
    expect(result.summary).not.toContain('speculative issue');
  });

  it('distinguishes duplicate removal from low confidence', () => {
    const result = validateCandidate({ summary: originalSummary, findings: [candidateFinding, candidateFinding] }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.rejected).toBe(1);
    expect(result.summary).toContain('1 duplicate finding was removed.');
    expect(result.summary).not.toContain('confidence');
    expect(result.summary).not.toContain(originalSummary);
  });

  it('accounts for mixed exclusions and keeps the coverage reminder', () => {
    const second = { ...candidateFinding, title: 'Another observed issue' };
    const low = { ...candidateFinding, confidence: 0.1 };
    const result = validateCandidate({ summary: originalSummary, findings: [candidateFinding, second, second, low, low] }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(2);
    expect(result.rejected).toBe(3);
    expect(result.summary).toContain('2 reportable findings remain after filtering.');
    expect(result.summary).toContain('2 candidate findings were excluded');
    expect(result.summary).toContain('1 duplicate finding was removed.');
    expect(result.summary).toContain('Review Coverage');
  });

  it('preserves the model summary when nonempty findings are unchanged', () => {
    const result = validateCandidate({ summary: 'An unchanged model summary.', findings: [candidateFinding] }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(0);
    expect(result.summary).toBe('An unchanged model summary.');
  });
  it('uses a scope-qualified summary when the model returns no findings but claims a defect', () => {
    const result = validateCandidate({ summary: 'A serious defect was found.', findings: [] }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('No reportable findings were returned');
    expect(result.summary).not.toContain('serious defect');
    expect(result.selection).toEqual({ candidates: 0, retained: 0, lowConfidence: 0, duplicates: 0, threshold: 0.75 });
  });
  it('deduplicates matching prose/evidence despite different confidence or severity, keeping an original record', () => {
    const lower = { ...candidateFinding, confidence: 0.8, severity: 'high' as const };
    const higher = { ...candidateFinding, confidence: 0.95, title: 'Guard   the missing user' };
    for (const findings of [[lower, higher], [higher, lower]]) {
      const result = validateCandidate({ summary: originalSummary, findings }, evidence, 0.75);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.findings).toEqual([{ ...higher, id: 'F1' }]);
      expect(result.selection).toEqual({ candidates: 2, retained: 1, lowConfidence: 0, duplicates: 1, threshold: 0.75 });
    }
  });
  it.each([
    { description: 'The same line violates a different contract.' },
    { evidence: 'Whitespace-sensitive string: "a  b"' },
    { category: 'security' as const },
    { line: null },
    { title: 'A distinct finding on the same line' },
  ])('preserves distinct findings at the same location: %j', (override) => {
    const result = validateCandidate({ summary: originalSummary, findings: [candidateFinding, { ...candidateFinding, ...override }] }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(2); expect(result.selection.duplicates).toBe(0);
  });
  it('preserves evidence whitespace and file identity when detecting duplicates', () => {
    const observations = new Map([...evidence, ['src/other.ts', { hasCode: true, headLines: new Set([finding.line!]) }]]);
    const result = validateCandidate({ summary: originalSummary, findings: [
      { ...candidateFinding, evidence: 'const key = "a b";' },
      { ...candidateFinding, evidence: 'const key = "a  b";' },
      { ...candidateFinding, file: 'src/other.ts', evidence: 'const key = "a b";' },
    ] }, observations, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(3);
  });
  it('assigns IDs after severity/confidence ordering with deterministic ties', () => {
    const findings = [
      { ...candidateFinding, title: 'Medium', confidence: 1 },
      { ...candidateFinding, title: 'High B', severity: 'high' as const, confidence: 0.8 },
      { ...candidateFinding, title: 'High A', severity: 'high' as const, confidence: 0.8 },
      { ...candidateFinding, title: 'High certain', severity: 'high' as const, confidence: 0.95 },
    ];
    const result = validateCandidate({ summary: originalSummary, findings }, evidence, 0.75);
    const reversed = validateCandidate({ summary: originalSummary, findings: [...findings].reverse() }, evidence, 0.75);
    expect(result.ok && reversed.ok).toBe(true);
    if (!result.ok || !reversed.ok) return;
    expect(result.findings.map(({ id, title }) => [id, title])).toEqual([
      ['F1', 'High certain'], ['F2', 'High A'], ['F3', 'High B'], ['F4', 'Medium'],
    ]);
    expect(result.findings).toEqual(reversed.findings);
  });
  it.each([0, 0.75, 1])('retains the exact configured confidence threshold %s', (threshold) => {
    const result = validateCandidate({ summary: 'Threshold test', findings: [{ ...candidateFinding, confidence: threshold }] }, evidence, threshold);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1); expect(result.selection.threshold).toBe(threshold);
  });
});
