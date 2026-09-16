import type { InitialContext } from '../github/context.js';
import type { PullRequestReference } from '../github/pr-url.js';
import { escapeMarkdown as escape } from './formatter.js';

export function formatContextReport(pr: PullRequestReference, context: InitialContext): string {
  const { metadata, files } = context;
  return `# PR Context: ${escape(pr.owner)}/${escape(pr.repository)} PR #${pr.pullNumber}

> CONTEXT ONLY — Phase 2. No LLM analysis or code review has been performed.

## Pull Request

- Title: ${escape(metadata.title)}
- URL: ${pr.url}
- Author: ${metadata.user ? escape(metadata.user.login) : 'Unavailable'}
- Base → Head: ${escape(metadata.base.ref)} → ${escape(metadata.head.ref)}
- Base SHA: ${metadata.base.sha}
- Head SHA: ${metadata.head.sha}
- Additions / deletions: ${metadata.additions} / ${metadata.deletions}
- Collected at: ${context.collectedAt}

## Description

${metadata.body ? escape(metadata.body) : 'No description provided.'}

## Findings

Not assessed. Context collection does not establish whether this PR has defects.

## Collected Context

- Changed files reported by GitHub: ${metadata.changed_files}
- Changed-file entries collected: ${files.length}
- Non-empty patches retained: ${files.filter((f) => f.patch).length}
- Patches truncated locally: ${files.filter((f) => f.patchTruncated).length}
- Combined commit status: ${context.status ?? 'Unavailable'}
- Retained context characters (serialized metadata/files plus status): ${context.retainedChars}
- Files reviewed by a model: 0

${files.length ? files.map((f) => `- ${escape(f.filename)}: ${escape(f.status ?? 'status unavailable')}; +${f.additions} / -${f.deletions}; ${f.patch ? f.patchTruncated ? 'partial patch retained' : 'patch retained (server completeness not verified)' : 'no patch retained'}`).join('\n') : 'No changed-file context retained.'}

## Limitations

- Context collection only: no model review or test execution was performed.
${context.limitations.map((item) => `- ${escape(item)}`).join('\n')}
- Patches are retained in memory only and are not included in this report. GitHub may omit or shorten patches; server-side patch completeness is not guaranteed.
`;
}
