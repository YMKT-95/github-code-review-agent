import { describe, expect, it } from 'vitest';
import { formatReview } from '../src/review/formatter.js';
import { createMockReview } from '../src/review/mock.js';
import { parsePullRequestUrl } from '../src/github/pr-url.js';
import { finding } from './fixtures/finding.js';

const pr = parsePullRequestUrl('https://github.com/owner/repository/pull/42');

describe('Markdown reports', () => {
  it('includes required sections and prominently discloses mock behaviour', () => {
    const report = formatReview(pr, createMockReview());
    for (const heading of ['Pull Request', 'Summary', 'Findings', 'Review Coverage', 'Limitations']) {
      expect(report).toContain(`## ${heading}`);
    }
    expect(report).toContain('MOCK REPORT');
    expect(report).toContain('No sufficiently supported issues were identified within the reviewed scope.');
    expect(report).toContain('Changed files: Unknown (not retrieved)');
    expect(report).toContain('Title: Not retrieved');
  });
  it('renders findings in severity then confidence order without mutating input', () => {
    const findings = [
      { ...finding, title: 'Medium finding' },
      { ...finding, title: 'High lower confidence', severity: 'high' as const, confidence: 0.8 },
      { ...finding, title: 'High higher confidence', severity: 'high' as const, confidence: 0.95 },
    ];
    const report = formatReview(pr, { ...createMockReview(), findings });
    expect(report.indexOf('High higher confidence')).toBeLessThan(report.indexOf('High lower confidence'));
    expect(report.indexOf('High lower confidence')).toBeLessThan(report.indexOf('Medium finding'));
    expect(findings[0]?.title).toBe('Medium finding');
    for (const section of ['Problem', 'Impact', 'Evidence', 'Suggested direction']) expect(report).toContain(`**${section}**`);
    expect(report).toContain('Line: 12');
    expect(report).toContain('Confidence: 95%');
  });
  it('escapes untrusted HTML and Markdown in text fields', () => {
    const report = formatReview(pr, { ...createMockReview(), summary: '<script>alert(1)</script>\n# forged\n![track](https://evil.test)' });
    expect(report).not.toContain('<script>');
    expect(report).not.toContain('\n# forged');
    expect(report).not.toContain('![track]');
    expect(report).toContain('&lt;script&gt;');
  });
  it('shows selection counts and limited coverage without claiming an excluded candidate is a defect', () => {
    const mock = createMockReview();
    const report = formatReview(pr, { ...mock, summary: 'No reportable findings remain after filtering.',
      coverage: { ...mock.coverage, changedFiles: 10, changedFilesInspected: 2, completionReason: 'partial-diff' },
      selection: { candidates: 1, retained: 0, lowConfidence: 1, duplicates: 0, threshold: 0.75 },
    });
    expect(report).toContain('LIMITED COVERAGE');
    expect(report).toContain('## Finding Selection');
    expect(report).toContain('Validated candidates: 1');
    expect(report).toContain('Excluded below threshold: 1');
    expect(report).toContain('Reported findings: 0');
    expect(report).toContain('excluded candidates are not confirmed defects');
    expect(report).toContain('No sufficiently supported issues were identified within the reviewed scope.');
  });
  it('distinguishes no candidates from filtering all candidates and omits synthetic counts in mocks', () => {
    const mock = createMockReview();
    expect(formatReview(pr, mock)).not.toContain('## Finding Selection');
    const report = formatReview(pr, { ...mock,
      coverage: { ...mock.coverage, completionReason: 'sufficient-evidence' },
      selection: { candidates: 0, retained: 0, lowConfidence: 0, duplicates: 0, threshold: 0.75 },
    });
    expect(report).toContain('Validated candidates: 0');
    expect(report).toContain('Excluded below threshold: 0');
    expect(report).not.toContain('LIMITED COVERAGE');
  });
  it('renders stable finding IDs and qualifies model confidence', () => {
    const report = formatReview(pr, { ...createMockReview(), findings: [{ ...finding, id: 'F1' }] });
    expect(report).toContain('- ID: F1');
    expect(report).toContain('model estimate, not a calibrated probability');
  });
});
