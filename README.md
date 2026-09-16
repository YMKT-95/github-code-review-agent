# GitHub Pull Request Code Review Agent

A local TypeScript CLI for a read-only, evidence-backed PR review agent.

**Status: Phase 2 — GitHub MCP context collection.** The CLI retrieves real PR
metadata, changed-file patches and optional combined commit status through GitHub's
official hosted MCP server. It writes a **context-only report**, not review findings.
LLM integration and a bounded agent loop start in Phase 3.

## Install and verify

Requires Node.js 22.12 or later and npm. Development was verified on Node 24.6.0.

```bash
npm ci
npm test
npm run typecheck
npm run build
```

`npm install` also works; `npm ci` reproduces the committed lockfile. The optional
macOS ARM Rolldown binding is explicit because npm omitted the transitive native
package during setup; npm skips this optional dependency on other platforms.

## Run without credentials

The Phase 1 demonstration is still available, now behind an explicit flag:

```bash
npm run review -- --mock https://github.com/owner/repository/pull/42
```

It creates `reviews/owner-repository-pr-42.md`, labelled **MOCK REPORT**, with no
network calls, no inspected files and no findings. It does not verify PR existence.

## Collect real PR context

1. Copy `.env.example` to `.env` if you have not already created it.
2. Set `GITHUB_TOKEN` locally to a GitHub personal access token. Prefer a fine-grained
   token limited to the repositories you intend to review, with **Pull requests: read**
   and **Contents: read**. **Commit statuses: read** supports the optional status
   query. Organisation approval/SSO rules may also apply. Never commit the token.
3. Run the command with an accessible PR URL:

```bash
npm run review -- https://github.com/OWNER/REPOSITORY/pull/42
```

The result is `reviews/OWNER-REPOSITORY-pr-42-context.md`. The report contains PR
metadata, collected-file inventory, status and limitations. It does not include raw
patches. Patches remain in memory for the duration of the command.

You can also run the compiled CLI:

```bash
node dist/index.js --help
node dist/index.js https://github.com/OWNER/REPOSITORY/pull/42
```

Reports are relative to the current working directory. Existing reports are never
overwritten: move the old report before rerunning the same PR. Reports are ignored
by Git and created with owner-only read/write permissions on POSIX systems.

## Phase 2 design

1. Parse exactly one GitHub PR URL and validate configuration before network access.
2. Connect using the official MCP TypeScript client and Streamable HTTP transport.
3. Discover tools with bounded pagination. Require the supported
   `pull_request_read` schema and its `get` / `get_files` methods.
4. Dispatch through an application allow-list that permits only `get`, `get_files`
   and optional `get_status`, scoped to the input owner/repository/PR.
5. Collect metadata and paginated changed files, retaining bounded per-file patches.
6. Optionally fetch combined commit status, then re-read PR metadata to detect a
   head/base change during collection.
7. Write a context-only Markdown report and close the MCP connection.

The `get_files` response includes patches, so Phase 2 does not make a redundant
whole-PR `get_diff` request. It does not yet fetch arbitrary repository files,
search code, inspect tests or check runs, or run a model. Combined commit status is
not a complete CI/check-run assessment.

### Read-only boundary

The hosted endpoint is fixed to `https://api.githubcopilot.com/mcp/`. Requests set
`X-MCP-Readonly: true`, select the `pull_requests` toolset, and request
`pull_request_read`. A separate application allow-list rejects write tools, unknown
methods, extra arguments, and attempts to override the target repository.
Server annotations and descriptions cannot grant additional permissions.

Custom endpoints, local process commands and command arguments are deliberately
unsupported in this phase. HTTP redirects and requests to other origins are blocked.
No Docker, local MCP binary or GitHub CLI login is required. The project does not
read credentials from `gh`; use its own `GITHUB_TOKEN` configuration.

Repository text remains untrusted data. Control characters and known token formats
are sanitised, configured GitHub/LLM secret values are redacted, and report text is
escaped. This is not a general secret scanner. No source, token, server description
or raw provider error is included in operational logs. The model prompt-injection
policy will be added when the model is introduced in Phase 3.

### Bounds and failure handling

- Every external request has a timeout; HTTP response streams are capped at 2 MB
  before SDK parsing. No application retries or SSE reconnection retries are used.
- Discovery is limited to 10 pages and 1,000 tools, with repeating-cursor detection.
- File pagination uses a fixed page size of up to 20, at most 100 pages / 2,000 files,
  and the lower configured file limit. Duplicate file results stop pagination.
- JSON is decoded before field truncation. Retained metadata and each file page
  respect the tool-result budget; the sum of serialized metadata/file objects plus
  the status respects the total context budget. Limits are in JavaScript string
  characters, not LLM tokens. Container/report overhead is not part of this budget.
- Missing, truncated, duplicate or unavailable files are disclosed. Tiny budgets
  that cannot retain metadata fail cleanly. Oversized HTTP results fail the request;
  they are not parsed as partial JSON.
- Invalid input/configuration, connection failure and inaccessible/invalid PR
  metadata are fatal. Failed file pages or optional status retrieval produce a
  partial context report. A PR revision change is disclosed rather than silently
  presenting a consistent snapshot.
- GitHub may omit/shorten patches, so even an untruncated local patch is not claimed
  to be complete. Zero files are reported as model-reviewed throughout Phase 2.

## Configuration

`.env` is optional for mock mode. Existing environment variables override `.env`.
Invalid settings name only the offending fields, never their values.

- `GITHUB_TOKEN`: required for live mode; never required for `--mock`.
- `MAX_FILES_TO_INSPECT`: positive integer, default `20`; caps retained file entries.
- `MAX_TOOL_RESULT_CHARS`: positive integer, default `30000`; retained metadata/page budget.
- `MAX_CONTEXT_CHARS`: positive integer, default `100000`; aggregate retained data budget.
- `MAX_PATCH_CHARS`: positive integer, default `10000`; per-file patch cap.
- `MCP_TIMEOUT_MS`: positive integer, default `15000`; effective maximum `120000`.
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error`, `silent`; default `info`.
- `MAX_AGENT_STEPS`: positive integer, default `8`; reserved for Phase 3.
- `MIN_FINDING_CONFIDENCE`: `0`–`1`, default `0.75`; reserved for the findings pipeline.
- `LLM_API_KEY`, `LLM_MODEL`: reserved for Phase 3; no LLM requests in Phase 2.

Blank numeric settings are invalid. `silent` suppresses operational logs, while
completion summaries and fatal CLI errors remain visible. Exit status is `0` for a
saved report (including disclosed partial context) and `1` for a fatal failure.

## Project structure

- `src/cli.ts`: input, configuration, connection lifecycle and report output.
- `src/config.ts`, `src/logger.ts`: validated settings and concise logs.
- `src/github/pr-url.ts`: strict URL parser; GitHub Enterprise URLs are unsupported.
- `src/github/mcp-client.ts`: SDK transport, fixed endpoint and HTTP safeguards.
- `src/github/tool-adapter.ts`: tool discovery, allow-list, argument checks and result decoding.
- `src/github/context.ts`: deterministic initial retrieval, sanitisation and budgets.
- `src/review/context-formatter.ts`: context-only report, without review claims.
- `src/review/schemas.ts`, `formatter.ts`, `mock.ts`: Phase 1 review foundation/demo.
- `tests/`: unit tests, mocked SDK HTTP tests and CLI integration tests.
- `docs/specification.md`: original project specification.

## Test scope

All automated tests are offline. They cover URL/configuration validation, report
formatting, read-only enforcement, MCP discovery and protocol calls, error redaction,
pagination, missing context, revision changes, budgets, timeouts, injected instructions,
and connection cleanup. The SDK tests exercise its real HTTP transport with a mocked
`fetch`; the CLI tests inject a deterministic MCP connection.

Live GitHub credentials are not required by tests. A live smoke test remains necessary
in your account to verify token permissions, organisational access and the deployed
server schema. No model-quality or evaluation metrics are claimed.

## Roadmap

1. **Phase 1 — complete:** offline CLI foundation, schemas and mock report.
2. **Phase 2 — implemented, offline-verified:** read-only MCP context retrieval.
3. **Phase 3:** LLM adapter, policy, bounded agent loop and structured output repair.
4. **Phase 4:** targeted implementation/test retrieval and coverage tracking.
5. **Phase 5:** confidence filtering, deduplication and report refinement.
6. **Phase 6:** curated evaluations with precision/recall and false-positive measurement.

## References

- [GitHub MCP remote server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [GitHub MCP read-only/tool configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
- [GitHub MCP PR tool implementation](https://github.com/github/github-mcp-server/blob/main/pkg/github/pullrequests.go)
- [MCP TypeScript client connections](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
