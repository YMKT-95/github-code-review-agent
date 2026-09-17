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

  it.each([{ findings: [] }, { findings: [candidateFinding] }])('preserves the model summary when filtering does not change findings', ({ findings }) => {
    const result = validateCandidate({ summary: 'An unchanged model summary.', findings }, evidence, 0.75);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(0);
    expect(result.summary).toBe('An unchanged model summary.');
  });
});
