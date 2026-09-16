import type { InitialContext } from '../github/context.js';
import type { ReviewCoverage } from '../review/schemas.js';
import type { Usage } from '../llm/types.js';

export type Evidence = { headLines: Set<number>; hasCode: boolean };
export class AgentState {
  steps = 0;
  requests = 0;
  toolCalls = 0;
  usage: Usage = { inputTokens: 0, outputTokens: 0 };
  evidence = new Map<string, Evidence>();
  visited = new Set<string>();
  limitations: string[];
  reason: ReviewCoverage['completionReason'] = 'sufficient-evidence';
  constructor(readonly context: InitialContext) { this.limitations = [...context.limitations]; }
  note(text: string) { if (!this.limitations.includes(text)) this.limitations.push(text); }
  observe(path: string, lines: number[], hasCode: boolean) {
    if (!hasCode) return;
    const entry = this.evidence.get(path) ?? { headLines: new Set<number>(), hasCode: true };
    for (const line of lines) entry.headLines.add(line);
    this.evidence.set(path, entry);
  }
  coverage(): ReviewCoverage {
    const paths = [...this.evidence.keys()];
    return {
      changedFiles: this.context.metadata.changed_files,
      changedFilesInspected: paths.length,
      additionalFilesInspected: [],
      testsInspected: paths.filter((p) => /(^|\/)(__tests__|tests?|specs?)(\/|$)|[.](test|spec)[.]/i.test(p)),
      checksInspected: false,
      completionReason: this.reason === 'sufficient-evidence' && this.limitations.length ? 'partial-diff' : this.reason,
      limitations: [...this.limitations,
        'Inspection means code was supplied to the model, not proof that every line was understood. No repository code or tests were executed.',
        'Check runs were not inspected. Findings remain a second-pass review and may miss defects.'],
    };
  }
}

// Count only concrete patch lines, never entire hunk ranges. A truncated line is
// excluded; removed lines give base evidence but no head-side location.
export function patchEvidence(patch: string): { lines: number[]; hasCode: boolean } {
  let head = 0;
  let inHunk = false;
  let hasCode = false;
  const lines: number[] = [];
  for (const text of patch.split('\n')) {
    if (text.includes('[TRUNCATED')) break;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { head = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (text.startsWith('+') || text.startsWith(' ')) { if (head > 0) lines.push(head); head++; hasCode = true; }
    else if (text.startsWith('-')) hasCode = true;
  }
  return { lines, hasCode };
}
