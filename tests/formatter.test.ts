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
});
