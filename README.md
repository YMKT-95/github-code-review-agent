# GitHub Pull Request Code Review Agent

A local TypeScript CLI that reviews one GitHub PR through read-only MCP tools and
an explicit, bounded Anthropic model loop.

**Status: Phase 3 complete, with offline checks and a live integration run.** The agent can inspect changed
files, return structured findings, and produce a Markdown report with observed
coverage. The live run verified GitHub retrieval, Anthropic tool calls and report
generation; it does not establish review accuracy or complete PR coverage.

## Install and verify

Requires Node.js 22.12 or later and npm. Development was verified on Node 24.6.0.

```bash
npm ci
npm test
npm run typecheck
npm run build
```

The lockfile pins dependencies. An optional macOS ARM Rolldown binding is declared
explicitly because npm omitted that transitive native dependency during setup.

## Configure

If you do not already have `.env`, copy `.env.example` to `.env`. Keep an existing
`.env` so its credentials are preserved. Set these values locally:

- `GITHUB_TOKEN`: a GitHub PAT restricted to the repositories you intend to review.
  Use read-only Contents and Pull requests permissions; read-only Commit statuses
  supports the optional status query. Organisation approval/SSO may apply.
- `LLM_API_KEY`: an **Anthropic API key**, passed explicitly to the Anthropic SDK.
- `LLM_MODEL`: an explicit Claude model ID available to your account with tool use,
  structured outputs and disabled thinking supported. The application does not
  silently choose a model or fall back to another provider.

Default review mode sends selected PR descriptions, code and patches to Anthropic.
The GitHub credential stays in the MCP transport and is not included in model input.
Existing environment variables take precedence over `.env`. Never commit `.env`.

## Commands

### Shopping-cart presentation demo

Run `npm run demo:cart` and open `http://127.0.0.1:4173` for a small storefront that
makes a shipping bug visible. It needs no API credentials. The page and regression
tests share the same pricing function; `npm run test:cart` checks the business rule.
See [the demo guide](demos/cart/README.md) for creating a small PR with a deliberate
regression, reviewing it, and showing the human-verified fix. The baseline is correct;
the agent reviews the PR's code, not the rendered page.

### Review commands

Replace the URL below with an actual pull-request URL. For this project's PR #1:

```bash
# Model review: requires GitHub and Anthropic credentials
npm run review -- https://github.com/YMKT-95/github-code-review-agent/pull/1

# Context collection only: requires GitHub credentials, makes no model request
npm run review -- --context-only https://github.com/YMKT-95/github-code-review-agent/pull/1

# Offline demonstration: requires no credentials or network access
npm run review -- --mock https://github.com/YMKT-95/github-code-review-agent/pull/1
```

After building, `node dist/index.js` supports the same arguments. Use `--help` for
usage. Modes are mutually exclusive; no flags means a real model review.

### Outputs

Reports go under `reviews/` in the current working directory:

- Review: `owner-repository-pr-N.md`
- Context only: `owner-repository-pr-N-context.md`
- Mock: `owner-repository-pr-N-mock.md`

Existing reports are preserved. Move an old report before rerunning the same mode
and PR. Older Phase 1 mock reports used the real-review filename; those also remain
untouched. Reports are ignored by Git and created with POSIX mode `0600`.

A successful review can have zero findings. A provider error, refusal or invalid
output after repair exits with an error and writes no review. Exit `0` means a
report was saved, including reports that clearly disclose partial coverage. It does
not mean the PR is bug-free or safe to merge.

## How the agent works

1. Validate the URL and mode-specific settings before connecting to external services.
2. Discover approved MCP capabilities at GitHub's official hosted endpoint.
3. Collect metadata, a bounded changed-file inventory, patches and optional status.
   Inventory entries take priority over patches within each page so large patches
   no longer hide later filenames. Recheck base/head revisions before model use.
4. Send a trusted review policy and separately labelled untrusted observations to
   Claude. The model can return a candidate review or request `read_changed_file`.
5. Validate each tool call, perform the allowed read, and return a bounded observation.
   Repeated requests reuse earlier evidence rather than refetching or repeating code.
6. Validate final JSON, file references and observed head-line numbers. Allow one
   tools-off repair if final output is invalid.
7. Filter confidence below the configured threshold, remove exact duplicate findings,
   assign finding IDs, and sort by severity/confidence when formatting. If filtering
   removes any finding, replace the original model summary with retained counts and
   exclusion reasons so it cannot describe discarded findings. This needs no extra
   model request; unchanged results preserve their original summary.
8. Recheck PR revisions, write the report and close the MCP connection.

The application owns coverage, timestamps and finding IDs. Model output contains
only `summary` and `findings`; it cannot assert that an unseen file was inspected.

### Read-only file tool

`read_changed_file({ path, revision })` accepts only a collected changed-file path
and `head` or `base`. Repository identities and immutable SHAs come from PR metadata.
Fork heads use their recorded repository; base reads use the PR target repository.
Renamed files resolve their old path at base; removed files can only be read at base.
Unknown head repositories fail rather than falling back to a default branch.

The GitHub adapter maps this tool to `get_file_contents`. It accepts embedded text
resources or supported JSON file contents and decodes base64 strictly. Directories,
resource links, binary data and unsupported formats yield limitations. It never
follows a content URL. Reads are bounded to complete numbered lines for location
validation. There is no shell execution, code search or arbitrary repository read.

### Permissions and untrusted content

MCP requests go only to `https://api.githubcopilot.com/mcp/`, with
`X-MCP-Readonly: true` and the explicit `pull_request_read,get_file_contents` tools.
An application allow-list independently rejects unapproved tools and arguments.
Provider tool definitions come from our code, not server descriptions. Repository
instructions cannot change tool permissions. GitHub comments, approvals, commits,
merges and other mutations are never exposed.

The Anthropic adapter uses `api.anthropic.com`, disables automatic retries and SDK
logging, requests strict tools/structured JSON, and prohibits redirects. Repository
controls and known token formats are sanitised; configured secret values are redacted
from model observations and reports. This is not a general secret scanner.

Logs contain operational events and token totals, not source, provider error bodies
or hidden reasoning. Structured validation checks shape and observed locations; it
cannot prove that a finding is substantively correct.

## Limits

- `MAX_AGENT_STEPS=8`: normal model turns; at most one tool call each.
- One extra tools-off finalisation call when a limit is reached before a final result.
- One tools-off output-repair attempt per run. Thus at most **10 model requests**
  with defaults, and at most **8 model-requested file-read attempts**.
- `MAX_FILES_TO_INSPECT=20`: retained changed-file inventory and unique inspected paths.
- `MAX_TOOL_RESULT_CHARS=30000`: retained metadata/page and tool-observation cap.
- `MAX_CONTEXT_CHARS=100000`: full serialised Anthropic request body, including policy,
  tool/output schemas and history. Initial patches are reduced to leave room for
  later observations, with 4096 characters reserved for finalisation/repair.
- `MAX_PATCH_CHARS=10000`: per-patch cap and returned file-observation cap.
- `MCP_TIMEOUT_MS=15000`: request timeout, capped at 120000 ms.
- `LLM_TIMEOUT_MS=60000`: request timeout, capped at 120000 ms; cancellation is propagated.
- `MAX_LLM_OUTPUT_TOKENS=8192`: per-response output limit, capped at 16384.
- `MIN_FINDING_CONFIDENCE=0.75`: retained only after schema/evidence validation.
- `LOG_LEVEL=info`: `debug`, `info`, `warn`, `error` or `silent`.

Character limits use JavaScript string length, not model token counts. The initial
MCP collector's separate accounting sums serialised metadata/files and status; the
model adapter checks the actual complete request body. Actual input/output token
usage is logged. These bounds do not promise a fixed dollar cost.

MCP HTTP response bodies are capped at 2 MB and Anthropic responses at 1 MB before
parsing. Tool discovery is capped at 10 pages/1000 tools; file inventory collection
at 100 pages/2000 entries plus the lower configured file cap. There are no automatic
application retries or SSE reconnection retries.

## Coverage and failure behaviour

- A listed filename is not inspected code. Inspected means nonempty code was supplied
  to the model. Partial patches/reads remain disclosed, and inspection does not prove
  that the model understood every line.
- A non-null finding line must be an actually observed head-side line. Base-only
  evidence uses `line: null` and the policy requires identifying the base revision.
- GitHub can omit or shorten patches. Missing context never proves a defect.
- Combined commit status is not check-run inspection. Test-file recognition is a
  path heuristic; reading a test does not execute it.
- Failed additional reads become error observations. Budget limits trigger finalisation.
  Unknown tools cannot dispatch; unexpected multi-tool batches fail the protocol.
- Initial revision instability prevents model review. A PR change detected after
  review is disclosed, and the report records the reviewed base/head SHAs.
- Refusals, provider failures and twice-invalid output never become a clean review.

## Source map

- `src/cli.ts`, `config.ts`, `logger.ts`: modes, configuration, lifecycle and logs.
- `src/github/`: URL validation, MCP transport, tool permissions and initial context.
- `src/llm/types.ts`, `anthropic.ts`: provider-independent contract and Anthropic adapter.
- `src/agent/prompts.ts`, `state.ts`, `loop.ts`: policy, evidence/budgets and bounded loop.
- `src/review/`: runtime schemas, candidate validation, filtering and Markdown output.
- `tests/`: deterministic model sequences, mocked MCP/HTTP, and CLI integration tests.
- `docs/specification.md`, `docs/phase-3-plan.md`: original specification and agreed plan.

## Verification and next phases

Automated tests make no live GitHub or Anthropic requests. They exercise the real
SDKs with mocked HTTP, injected CLI dependencies and deterministic model responses.
Coverage includes permission failures, prompt injection, fork/rename/deletion reads,
context/turn limits, duplicate requests, invalid evidence, one repair, token redaction,
provider errors and cleanup. Typecheck covers both source and tests.

Phase 3's live integration was verified on PR #3 (head `712e7f5`) on 2026-09-18
(Pacific/Auckland): five model requests, four additional file reads, and a saved
report with code from 10 of 29 changed files supplied to the model. One candidate
was filtered out and the run correctly disclosed partial coverage. A stale summary
claim exposed by that run was subsequently fixed and verified with offline regression
tests; the revised summary has not been rerun live. The last full check passed 179
tests (including the cart demo), typecheck and build. No review-accuracy claim is
made from these checks or the live smoke test.

Phase 4 adds surrounding implementation/context search and test discovery. Phase 5
refines deduplication and reports beyond current confidence filtering and exact
record deduplication. Phase 6 adds curated evaluations and measured precision/recall.

## References

- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic tool-call protocol](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [GitHub MCP server](https://github.com/github/github-mcp-server)
- [GitHub MCP configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
