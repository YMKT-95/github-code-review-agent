import { describe, expect, it } from 'vitest';
import { findingSchema, reviewResultSchema, validateReviewResult } from '../src/review/schemas.js';
import { createMockReview } from '../src/review/mock.js';
import { finding } from './fixtures/finding.js';

describe('review schemas', () => {
  it('accepts a complete finding with a nullable line', () => {
    expect(findingSchema.parse({ ...finding, line: null }).line).toBeNull();
  });
  it.each([
    { confidence: -0.1 }, { confidence: 1.01 }, { confidence: '0.9' }, { line: 0 },
    { line: 1.5 }, { evidence: ' ' }, { severity: 'critical' }, { category: 'style' },
    { file: '../secret' }, { file: '/tmp/secret' }, { file: 'src/../secret' }, { extra: true },
  ])('rejects invalid finding fields %j', (override) => {
    expect(findingSchema.safeParse({ ...finding, ...override }).success).toBe(false);
  });
  it('rejects findings referring to uninspected files', () => {
    expect(() => validateReviewResult({ ...createMockReview(), findings: [finding] }, new Set())).toThrow('not inspected');
    expect(validateReviewResult({ ...createMockReview(), findings: [finding] }, new Set([finding.file])).findings).toHaveLength(1);
  });
  it('rejects impossible coverage and invalid timestamps', () => {
    const review = createMockReview();
    expect(reviewResultSchema.safeParse({ ...review, coverage: { ...review.coverage, changedFilesInspected: 1 } }).success).toBe(false);
    expect(reviewResultSchema.safeParse({ ...review, reviewedAt: 'yesterday' }).success).toBe(false);
  });
  it('makes no actual inspection claims in mock mode', () => {
    const review = validateReviewResult(createMockReview(new Date('2026-01-01T00:00:00Z')), new Set());
    expect(review.coverage.completionReason).toBe('mock');
    expect(review.findings).toEqual([]);
    expect(review.coverage.changedFilesInspected).toBe(0);
  });
});
