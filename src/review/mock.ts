import type { ReviewResult } from './schemas.js';

export function createMockReview(now = new Date()): ReviewResult {
  return {
    summary: 'MOCK DEMONSTRATION — This report verifies the local CLI and Markdown output. No actual pull request was reviewed.',
    findings: [],
    coverage: {
      changedFiles: 0,
      changedFilesInspected: 0,
      additionalFilesInspected: [],
      testsInspected: [],
      checksInspected: false,
      limitations: [
        'Phase 1 mock mode: GitHub and an LLM were not contacted.',
        'PR existence, title, branches, changed-file count and source code are unknown. Zero counts indicate no data retrieved.',
      ],
      completionReason: 'mock',
    },
    reviewedAt: now.toISOString(),
  };
}
