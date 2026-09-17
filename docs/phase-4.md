# Phase 4 — Contextual review

Status: implemented and verified offline, 2026-09-18 (Pacific/Auckland).
Branch: `feat/contextual-review`. Live verification of the new tools is pending
the owner's next manually initiated run; no paid run was started during development.

## Outcome and boundaries

Claude can go beyond the PR inventory to read implementations, contracts, callers
and tests. It chooses among four application-defined tools: `read_changed_file`,
`read_repository_file`, `list_directory` and `search_repository`. Only available
capabilities are advertised; the same definitions persist during tools-off finalisation.

The GitHub adapter derives repository identities and SHAs from the PR. File and
directory reads use the captured head repository (including forks) or base target
repository. Unknown head repositories fail closed. Arbitrary refs, repo arguments,
commands, URLs and search qualifiers are not accepted from the model. Existing
changed-file reads still map old filenames for base-side renames. General repository
reads take literal paths at the selected revision; base rename evidence is attributed
to the changed file with null head-line locations.

Search uses GitHub's `search_code` endpoint with a literal quoted term and an
application-controlled `repo:` restriction. Code search cannot target a commit SHA.
Search responses therefore contribute paths only, not snippets or line evidence.
Other-repository hits are discarded. Candidate code must be retrieved at the recorded
revision before supporting a finding. One page of at most 20 paths is retained;
`kind: tests` filters common test naming conventions within those candidates. Empty
or incomplete results never establish the absence of tests or callers. Directory
browsing is a SHA-pinned alternative for finding tests with unusual names or in forks.

No source code or tests are executed. GitHub writes, check-run inspection and commit
history inspection were not added; these last two are optional in the Phase 4 spec.
The policy restricts findings to behaviour introduced or affected by the PR, but
semantic relevance still depends on the model and needs later evaluation.

## Budget, evidence and coverage rules

- Existing turn, timeout, input-character and output-token limits remain in force.
  One model-selected operation makes at most one MCP request; cached reads make none.
- All supplied code shares `MAX_FILES_TO_INSPECT`, including initial patches.
  Search and directory entries do not count as inspected files.
- File observations contain at most 200 complete numbered lines, additionally capped
  by `MAX_PATCH_CHARS`, `MAX_TOOL_RESULT_CHARS` and remaining model-input capacity.
  `startLine` selects a range; `nextStartLine` identifies more retrievable content.
- Only lines actually supplied at head can be non-null finding locations. Base
  evidence requires null locations. A range does not imply the entire file was read.
- Full immutable text is cached per revision/repository/SHA/literal path, up to 1M
  characters per file and 2M total. New ranges reuse this content. Identical tool
  requests return an earlier-observation reference; failed reads are not retried.
- Additional files never inflate the count of changed files inspected. If the
  changed-file inventory was truncated, a path outside it is reported as additional
  context without claiming it is unchanged.
- Test paths are a heuristic. Only delivered test code appears in Tests inspected.
  This is not proof the model understood it or that the test passes.
- Discovery and read failures become safe error observations and coverage limitations.
  No raw provider errors, URLs, source or search text are emitted in operational logs.

## Offline validation

Tests cover unchanged file reads, fork and base SHA scoping, renamed paths, directory
root/list caps, injection attempts, unsupported capabilities, cross-repo search hits,
search-only findings rejected, test discovery followed by reads, base-only evidence,
line ranges and cached pagination, repeat/failure caching, shared file and observation
budgets, and the real Anthropic SDK + MCP adapter + CLI using mocked transports.
Existing Phase 3 tests remain in place, including one repair and the ten-request cap.

Required checks: `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`.
All passed after implementation: 219 tests across 18 files, plus the compiled CLI
help smoke check. No additional dependencies were required.
Offline validation demonstrates control flow and boundaries, not review accuracy.

## User-run live smoke test

1. Commit/push the implementation and create the appropriate PR. For a focused demo,
   use a small PR with a changed function plus related existing implementation/tests.
2. In the PR description state the intended behaviour and relevant test directory.
3. Run `npm run review -- ACTUAL_PR_URL`, substituting that PR's actual URL. Existing
   local `.env` settings remain usable; no new configuration variable is required.
4. Observe context tool names in logs. The model is not forced to use every tool.
   A run without new tool calls does not verify their live paths. Inspect the report's
   Additional files inspected, Tests inspected, revision SHAs and limitations.
5. Before rerunning the same PR, rename its old report. Never overwrite evidence of
   an earlier run or interpret a local source change as an update to the remote PR.

The cart demo guide provides a small reproducible behaviour example. Keep historical
Phase 3 live evidence separate from new Phase 4 live results.

## Sources

- [Official GitHub MCP tools](https://github.com/github/github-mcp-server)
- [GitHub code search limitations](https://docs.github.com/en/search-github/github-code-search/about-github-code-search)
