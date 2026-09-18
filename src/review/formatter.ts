import type { PullRequestReference } from '../github/pr-url.js';
import type { ReviewFinding, ReviewResult } from './schemas.js';
import { compareFindings } from './ordering.js';

export type PullRequestMetadata = { title: string; base: string; head: string; baseSha?: string; headSha?: string };

// Render untrusted values as plain text, not raw HTML, links, or Markdown headings.
export function escapeMarkdown(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, '\\$1');
}

function formatFinding(finding: ReviewFinding): string {
  return `### ${finding.severity.toUpperCase()} — ${escapeMarkdown(finding.title)}

- ID: ${escapeMarkdown(finding.id)}
- File: ${escapeMarkdown(finding.file)}
- Line: ${finding.line ?? 'Not available'}
- Category: ${finding.category}
- Confidence: ${Math.round(finding.confidence * 100)}% (model estimate, not a calibrated probability)

**Problem**

${escapeMarkdown(finding.description)}

**Impact**

${escapeMarkdown(finding.impact)}

**Evidence**

${escapeMarkdown(finding.evidence)}

**Suggested direction**

${escapeMarkdown(finding.suggestion)}`;
}

export function formatReview(pr: PullRequestReference, review: ReviewResult, metadata?: PullRequestMetadata): string {
  const coverage = review.coverage;
  const findings = [...review.findings].sort(compareFindings);
  const selection = review.selection;
  const limited = coverage.completionReason !== 'mock' && (coverage.completionReason !== 'sufficient-evidence' || coverage.changedFilesInspected < coverage.changedFiles);
  const files = (paths: string[]) => paths.length ? paths.map(escapeMarkdown).join(', ') : 'None';
  return `# Code Review: ${escapeMarkdown(pr.owner)}/${escapeMarkdown(pr.repository)} PR #${pr.pullNumber}
${coverage.completionReason === 'mock' ? '\n> MOCK REPORT — No GitHub or LLM calls were made. This is not a code review.\n' : ''}
${limited ? '> LIMITED COVERAGE — This report covers only the supplied code. See Review Coverage and Limitations before relying on the findings.\n' : ''}
## Pull Request

- Title: ${metadata ? escapeMarkdown(metadata.title) : 'Not retrieved'}
- URL: ${pr.url}
- Base → Head: ${metadata ? `${escapeMarkdown(metadata.base)} → ${escapeMarkdown(metadata.head)}` : 'Not retrieved'}
${metadata?.headSha ? `- Base SHA: ${metadata.baseSha}\n- Head SHA: ${metadata.headSha}\n` : ''}- Reviewed at: ${review.reviewedAt}${coverage.completionReason === 'mock' ? ' (mock report generation time)' : ''}

## Summary

${escapeMarkdown(review.summary)}
${selection ? `
## Finding Selection

- Validated candidates: ${selection.candidates}
- Confidence threshold: ${selection.threshold}
- Excluded below threshold: ${selection.lowConfidence}
- Duplicates removed: ${selection.duplicates}
- Reported findings: ${selection.retained}

Confidence is a model estimate, not a measured probability. Counts describe the final validated candidate set after any repair; excluded candidates are not confirmed defects.
` : ''}

## Findings

${findings.length ? findings.map(formatFinding).join('\n\n') : 'No sufficiently supported issues were identified within the reviewed scope.'}

## Review Coverage

- Changed files: ${coverage.completionReason === 'mock' ? 'Unknown (not retrieved)' : coverage.changedFiles}
- Changed files inspected: ${coverage.changedFilesInspected}
- Additional files inspected: ${files(coverage.additionalFilesInspected)}
- Tests inspected: ${files(coverage.testsInspected)}
- Checks inspected: ${coverage.checksInspected ? 'Yes' : 'No'}
- Completion reason: ${coverage.completionReason}

## Limitations

${coverage.limitations.length ? coverage.limitations.map((item) => `- ${escapeMarkdown(item)}`).join('\n') : 'No retrieval limitations recorded. This review does not establish that the code is bug-free.'}
`;
}
