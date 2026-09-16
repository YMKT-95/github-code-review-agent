# Phase 3 plan — Anthropic and a bounded review loop

Status: implemented and verified offline, 2026-09-17. Live Anthropic smoke testing
is pending local `LLM_API_KEY` and `LLM_MODEL` configuration. The sections below
retain the agreed plan and acceptance criteria.
Branch: `feat/llm-agent-loop`, based on merged Phase 2 (`84161b5`).
Provider decision: Anthropic, selected by the project owner.

## Outcome

Running the default review command will collect PR context, let Claude request
approved additional reads, and produce a validated Markdown review with actual
coverage limitations. GitHub access remains read-only; publishing and merging are
outside the project scope.

Success does not require findings: a valid empty result is preferable to a
speculative defect. A failed model call must never be presented as a clean review.

## Scope and phase boundaries

Implement the provider adapter, review policy, explicit loop/state, structured
result validation, one repair attempt, operational traces and offline tests.

Give the loop one useful context tool: `read_changed_file`, restricted to paths in
the PR's collected changed-file inventory. This supplies a small end-to-end agent
capability for Phase 3. Phase 4 expands retrieval to other implementation files,
callers, contracts, code search and test discovery.

Enforce the existing confidence threshold before reporting real findings. This
small part of Phase 5 moves forward because it is a core output requirement;
semantic deduplication and broader report refinement remain in Phase 5. Exact
duplicate records can be removed deterministically now.

## 1. Prepare the Phase 2 context for model use

Observed prerequisite: `collectInitialContext` stops collecting file entries when
the current page's patch budget is exhausted. The live run retained 9 of 18 files,
even though `MAX_FILES_TO_INSPECT` was 20.

- Separate the compact changed-file inventory from retained patches. Reserve room
  for filenames/status/counts first, then allocate the remaining patch budget.
- Continue bounded inventory collection when a patch/page budget is spent. Preserve
  per-file flags for omitted or truncated patches; do not silently increase budgets.
- Distinguish listed files, retrieved content, and content delivered to the model.
- Reserve context capacity for later tool observations and finalisation rather than
  filling the entire model input with initial patches.
- Retain base/head SHA and repository identity, including fork-head identity and
  previous filenames for renames. Refuse a live review if initial retrieval already
  detected mixed revisions. Context-only mode can continue to disclose that condition.
- Remove the hard-coded Phase 2/no-model limitation from the shared collector and
  add that wording only in the context-only report path.

Acceptance: an 18-file fixture with oversized early patches still exposes all 18
inventory entries when inventory and file-count budgets permit; truncated patches
remain disclosed and are not counted as complete inspections.

## 2. Add one Anthropic adapter

Use the official `@anthropic-ai/sdk` Messages API. Keep SDK request/response types
inside the adapter; core logic depends on a small `LlmClient` interface.

The interface normalises a turn to a tool request, final review candidate, or typed
failure, with token usage and provider stop reason. Conversation state remains
per-run and in memory. The adapter preserves tool-call IDs and the required
assistant/user tool-result message sequence.

Use strict client-tool definitions and schema-constrained final JSON with
`output_config.format`, while retaining application-side Zod validation. Verify
compatibility of the installed SDK with the selected model during implementation.
Anthropic documents both mechanisms in its
[structured-output guide](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

Set automatic SDK retries to zero so request limits are transparent. Bound request
time and response output. Handle authentication errors, rate limits, timeouts,
refusals, output truncation and malformed responses explicitly. Never log provider
error bodies, message contents or hidden reasoning. Any protocol-required opaque
blocks stay inside the adapter and are not exposed in reports.

Configuration:

- `LLM_API_KEY`: Anthropic API key; pass explicitly to the SDK. Preserve the existing
  project variable name rather than introducing a second competing key variable.
- `LLM_MODEL`: required explicit model ID supporting tool use and structured output.
  Select and verify the exact ID before live testing; no hard-coded latest alias.
- `LLM_TIMEOUT_MS=60000`: proposed per-request timeout.
- `MAX_LLM_OUTPUT_TOKENS=8192`: proposed per-response output limit.

Validate required LLM settings before external requests in review mode. Mock and
context-only modes do not require an LLM key. Document that review mode sends
selected repository content to Anthropic; the GitHub token stays in the MCP layer.

## 3. Define the review policy and narrow tools

`prompts.ts` contains a stable policy focusing on behaviour changed by the PR,
correctness, error handling, validation, concrete security risks, meaningful test
gaps and material maintainability issues. It requires observed evidence, separates
severity from confidence, discourages style-only findings, and explicitly allows
no findings.

Repository content, file names, descriptions and tool responses are untrusted
observations. They cannot change the policy, provider settings or tool permissions.
Model-visible tool descriptions and schemas are defined by our code, not copied
from server-provided descriptions.

Tool: `read_changed_file({ path, revision })`, where revision is `head` or `base`.

- Resolve repository and immutable SHA in application code. Never accept owner,
  repository, arbitrary ref, URL or command arguments from the model.
- Only accept a collected changed path; resolve a previous filename for a base-side
  rename. A removed file can be inspected at the base revision.
- Map to discovered GitHub MCP `get_file_contents` inside the existing adapter.
  Add that read capability to the hosted server configuration, retaining read-only
  headers and the separate application allow-list.
- Handle fork heads using the captured head repository. Unavailable/deleted forks
  produce a recoverable observation, not a read from an unrelated default branch.
- Decode supported text/base64 responses, number observed lines, redact configured
  secrets and bound content before delivery. Binary files, oversized results and
  unsupported resource links produce explicit limitations; do not follow links.
- Cache by repository/SHA/path. A repeated request reuses the bounded observation
  without another GitHub request or duplicating the source in the transcript.

If this optional tool is unavailable, the model can review available patches with
the missing capability disclosed. Never substitute a similarly named write tool.

## 4. Implement the explicit bounded loop

Flow:

```text
Initial PR context + policy
  -> Claude turn
     -> validated read request -> MCP -> bounded observation -> next turn
     -> final candidate -> validation -> optional repair -> report
  -> limit reached -> tools disabled -> final candidate -> validation
```

State records PR identity/revisions, turn count, completed tool calls, cached
resources, observations delivered to the model, observed line ranges, character
budget, token usage, limitations and completion reason.

Proposed exact bounds:

- `MAX_AGENT_STEPS=8`: up to eight model turns where tool selection is enabled.
- At most one tool call per turn. Request this using
  `disable_parallel_tool_use: true`; reject an unexpected multi-call response
  without dispatching it. This keeps one turn from creating unbounded requests.
  See [Anthropic's tool-use control](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use).
- If a limit is reached before a final candidate, permit one additional tools-off
  finalisation request using only collected evidence.
- Permit at most one tools-off repair request per run for invalid final output.
  A second invalid result fails clearly. A refusal is not treated as a request to
  bypass refusal through repair.
- Thus the default has at most ten model requests and eight model-requested GitHub
  reads. Deterministic initial MCP calls retain their own existing limits.
- Keep the existing file, patch and tool-output caps. Count unique file paths once
  against the inspection cap; base/head reads still consume tool and context budgets.
- Apply `MAX_CONTEXT_CHARS` to the serialised model input, including history, policy,
  tool definitions and observations. Reserve space for finalisation/repair messages;
  fail early if fixed overhead cannot fit. Never truncate JSON or break tool pairs.
- Record actual input/output token usage. Character limits and request/output caps
  bound work but are not a promised dollar-cost cap.

Invalid tool arguments, forbidden tools and recoverable read failures return small
sanitised error observations and consume a turn. They never grant broader access.
Provider/network failure ends the review with an operational error and no fabricated
review result. Every request and connection is cleaned up on success or failure.

## 5. Validate evidence and build application-owned coverage

The model produces only `{ summary, findings }`. The application supplies the
timestamp, coverage, stable finding IDs and completion reason.

- Reuse the existing finding schema, adding sensible string/array limits.
- Accept file references only where patch or file content was actually delivered
  to the model, not merely listed. Validate non-null lines against observed ranges.
- Require head-side finding locations; represent deletion-only findings at a
  validated path with `line: null` and explicit base-side evidence in the text.
- Schema-valid evidence is not proof of a defect. The policy and later evaluations
  assess substantive correctness; do not claim schema validation establishes truth.
- Validate before applying `MIN_FINDING_CONFIDENCE=0.75`, exact-duplicate removal,
  and existing severity/confidence ordering. Count rejected candidates operationally.
- Repair invalid output once using concise field-level validation messages and
  already collected evidence; no new tools during repair.
- Coverage describes content supplied for inspection, not a guarantee that Claude
  understood every line. Do not count directory listings, missing patches or failed
  reads as inspected code. Truncated content remains partial in the report.
- Keep `checksInspected=false` when only combined commit status was fetched. Separate
  test-file reads from executed tests; the agent does not execute repository code.
- Preserve every limitation and choose one deterministic completion reason, with
  exhausted budgets taking priority over sufficient-evidence completion.
- Recheck revisions before saving a live report and disclose if the PR changed
  during the review; findings refer to the recorded revisions.

## 6. CLI and report compatibility

Proposed modes (mutually exclusive):

```bash
npm run review -- <actual-pr-url>                 # Claude review
npm run review -- --context-only <actual-pr-url>  # existing Phase 2 behaviour
npm run review -- --mock <actual-pr-url>          # offline demo
```

Keep the default real-review filename `owner-repository-pr-N.md` and context report
suffix `-context.md`. Move new mock reports to `-mock.md` so demos cannot occupy a
real review's output path. Existing files remain untouched; collisions fail before
network calls with a clear message. Update tests and README for this mode transition.

Reuse the Markdown formatter. Include the reviewed revision, partial coverage,
completion reason and limitations. Operational logs show turn number, tool name,
success/failure, usage and validation/filter counts, not model reasoning or raw code.

## Proposed file changes

Add:

- `src/llm/types.ts`: provider-independent turn and client contracts.
- `src/llm/anthropic.ts`: SDK calls, conversation protocol and safe failures.
- `src/agent/prompts.ts`: reusable policy and trusted tool descriptions.
- `src/agent/state.ts`: evidence, budgets, cache and coverage bookkeeping.
- `src/agent/loop.ts`: explicit bounded control flow and finalisation/repair.
- `src/review/validator.ts`: semantic file/line checks and minimal output filtering.
- Focused provider, tool, state and loop tests plus fixtures.

Modify existing config/CLI, GitHub context and adapter, schemas/formatter, README,
`.env.example`, dependency manifest and lockfile. Create no empty future modules.

## Implementation order

1. Fix inventory/patch accounting and introduce honest evidence/coverage state.
2. Define the client contract and implement/test the loop with a fake model.
3. Add the changed-file read tool with revision and permission tests.
4. Implement Anthropic protocol mapping and mocked SDK/HTTP tests.
5. Wire validation, CLI modes, reports, documentation and final offline checks.
6. Run a small live smoke test once an Anthropic key and supported model are
   configured locally. Record operational success, not an accuracy claim.

## Acceptance tests

Retain the Phase 2 tests, updating expectations only for intentional CLI changes.

- Immediate final result, including a valid empty review.
- One and several sequential reads before a final result, with correct call IDs.
- Unknown/forbidden tools, extra arguments, arbitrary repositories/refs, traversal,
  and unexpected multi-tool batches cause no unauthorised dispatch.
- Repeated resources make no additional MCP request and cannot grow context without bound.
- Recoverable reads fail with limitations; invalid input/config/provider failures
  fail cleanly and never produce a no-findings success.
- Step, file, tool-result and full-input budgets hold, including forced finalisation
  and repair. Test the absolute maximum number of model/network calls.
- Invalid final output is repaired once; repeated invalid output fails. Uninspected
  files and invented line numbers are rejected.
- Confidence at 0.75 is retained; lower confidence is excluded; output ordering is stable.
- Prompt injection in descriptions/source cannot trigger writes or expose credentials.
- Forks, deleted/renamed files, missing patches and moving PR heads have honest coverage.
- All modes preserve existing reports, close connections and redact errors/traces.

Required checks: `npm test`, `npm run typecheck`, `npm run build`. Automated tests
use no live GitHub or Anthropic access. Live smoke success must be reported separately
from offline checks and does not establish review accuracy.

## Remaining setup decision

Anthropic is selected. Choose an accessible Claude model ID supporting both tool
use and structured outputs when preparing the first live run; keep it configurable.
No API key is needed to review this plan or implement the offline tests. An actual
key belongs only in local `.env`, never in the plan, fixtures or chat.
