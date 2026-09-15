# GitHub Pull Request Code Review Agent

A local CLI project for a read-only, evidence-backed PR review agent in TypeScript.

**Status: Phase 1 foundation.** The CLI generates an explicitly labelled mock Markdown
report. It does not contact GitHub or an LLM, verify PR existence, inspect code, or
produce real findings. The agent loop and MCP integration are future work.

## Quick start

Requires **Node.js 22.12 or later** and npm. This baseline is above the specification's
Node 20 minimum to accommodate current development tooling. Development was verified
on Node 24.6.0. Dependency versions are captured in `package-lock.json`.
Use `npm ci` for a reproducible install from that lockfile. The optional macOS ARM
Rolldown binding is declared explicitly because npm omitted the transitive native
package during setup; npm skips this optional dependency on other platforms.

```bash
npm install
npm test
npm run typecheck
npm run build
npm run review -- https://github.com/owner/repository/pull/42
```

The last command creates `reviews/owner-repository-pr-42.md`. No keys or `.env` file
are required. You can also run the compiled CLI after building:

```bash
node dist/index.js --help
```

Reports use exclusive creation: an existing report is preserved and the command
returns an error. Move or remove the previous report before rerunning the same PR.
Reports are relative to the current working directory and ignored by Git because
later phases may include private repository content. On POSIX systems new reports
are created with owner-only read/write permissions.

## Configuration

Optionally copy `.env.example` to `.env`. Existing environment variables take
precedence over `.env`. Invalid settings fail before a report is written; error
messages name fields without echoing their values.

- `MAX_AGENT_STEPS`: positive integer, default `8`; reserved for the future loop.
- `MAX_TOOL_RESULT_CHARS`: positive integer, default `30000`; reserved for retrieval.
- `MAX_FILES_TO_INSPECT`: positive integer, default `20`; reserved for retrieval.
- `MIN_FINDING_CONFIDENCE`: number from `0` to `1`, default `0.75`; reserved for filtering.
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error`, or `silent`; default `info`.
- `LLM_API_KEY`, `LLM_MODEL`, `GITHUB_TOKEN`, `GITHUB_MCP_COMMAND`, `GITHUB_MCP_ARGS`:
  documented placeholders, neither required nor consumed in Phase 1.

Blank numeric settings are invalid. `LOG_LEVEL=silent` disables operational logs;
the completion summary and fatal CLI errors remain visible. Do not commit secrets.

## Execution flow

1. Validate exactly one `https://github.com/{owner}/{repository}/pull/{number}` URL.
2. Load `.env` and validate local settings with Zod.
3. Create mock data with no findings and no inspected files.
4. Runtime-validate the result, including file references for any candidate findings.
5. Format the report and save it to `reviews/`.
6. Print a short mock completion summary and file path; exit `0` on success, `1` on failure.

Trailing slashes, query strings, and fragments are accepted and canonicalised.
Other hosts, credentials, traversal, nonpositive/unsafe PR numbers, and extra path
segments are rejected. GitHub Enterprise URLs are outside the current scope.

## Source map

- `src/index.ts`, `src/cli.ts`: entry point, configuration and report orchestration.
- `src/config.ts`, `src/logger.ts`: validated settings and concise operational logs.
- `src/github/pr-url.ts`: strict URL parsing without network access.
- `src/review/schemas.ts`: findings, coverage and result schemas; inspected-file validation.
- `src/review/mock.ts`: mock result that does not fabricate PR metadata or coverage.
- `src/review/formatter.ts`: required Markdown sections, severity/confidence ordering,
  plain-text escaping and the no-findings wording.
- `tests/`: deterministic unit tests and CLI integration tests using temporary directories.
- `docs/specification.md`: original project specification, retained as planning context.

The mock-only completion reason `mock` extends the proposed coverage schema so a
demonstration cannot be confused with a completed review. Changed-file count `0`
means no data was retrieved; the report displays it as unknown.

## Verification

`npm test` exercises URL rejection, configuration defaults and boundaries, schema
constraints, inspected-file validation, report sections and ordering, untrusted text
escaping, logging, `.env` precedence, CLI output and overwrite protection. All tests
are offline. Test fixtures are synthetic and are never attributed to the input PR.

`npm run typecheck` checks source and tests; `npm run build` compiles only the source.
The formatter does not itself validate, filter or deduplicate findings: validation
belongs to the orchestration boundary, and the deterministic filtering pipeline is
scheduled for Phase 5. There are no live-service or model-quality results yet.

## Next milestones

1. **Phase 1 — complete:** local foundation and mock input-to-report flow.
2. **Phase 2:** GitHub MCP connection, tool mapping, enforced read-only allow-list,
   initial PR context, output budgets, timeouts and mocked integration tests.
3. **Phase 3:** provider adapter, review policy, bounded agent loop, structured output
   and one repair attempt.
4. **Phase 4:** targeted implementation/test retrieval and accurate coverage tracking.
5. **Phase 5:** confidence filtering, deduplication and report refinement.
6. **Phase 6:** curated buggy/clean evaluation cases and measured precision/recall.

Before Phase 2, choose a GitHub MCP transport (local process or remote service) and
establish minimal read-only credentials. Model provider selection is needed in
Phase 3. Neither choice is needed for this offline foundation.

No frontend, database, deployment, repository write tools, or multi-agent orchestration
are part of this MVP. Repository text will be treated as untrusted data, with actual
tool permissions enforced in application code when tools are introduced.

## Tooling references

- [Zod: runtime validation and inferred types](https://zod.dev/basics)
- [Vitest: installation and Node requirements](https://vitest.dev/guide/)
