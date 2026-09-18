import type { ReviewFinding } from './schemas.js';

type Finding = Omit<ReviewFinding, 'id'>;
const rank = { high: 0, medium: 1, low: 2 };
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// Locale-independent tie breaks make IDs and ordering repeatable for the same set.
export function compareFindings(a: Finding, b: Finding): number {
  return rank[a.severity] - rank[b.severity] || b.confidence - a.confidence ||
    compareText(a.file, b.file) || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    compareText(a.category, b.category) || compareText(a.title, b.title) ||
    compareText(a.description, b.description) || compareText(a.evidence, b.evidence) ||
    compareText(a.impact, b.impact) || compareText(a.suggestion, b.suggestion);
}

export function duplicateKey(finding: Finding): string {
  // Preserve evidence byte-for-byte after schema trimming. Whitespace and case in
  // code can change behaviour; never collapse findings just because they share a line.
  const prose = (text: string) => text.replace(/\s+/g, ' ').trim();
  return JSON.stringify([finding.file, finding.line, finding.category,
    prose(finding.title), prose(finding.description), finding.evidence,
    prose(finding.impact), prose(finding.suggestion)]);
}
