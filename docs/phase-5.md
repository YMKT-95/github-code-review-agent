# Phase 5 — Filtering and report quality

Status: implemented, offline verification only, 2026-09-18 (Pacific/Auckland).
Branch: `feat/report-quality`, based on the committed Phase 4 branch. No live
GitHub/Anthropic review was started and existing reports were not modified.

## Changes

1. Validate schema and observed file/line evidence before applying confidence
   thresholds. Invalid low-confidence candidates still require the existing single
   repair; filtering never conceals invalid output.
2. Deduplicate otherwise matching records even when confidence/severity differ or
   prose contains different whitespace. The key includes file, line, category,
   title, description, evidence, impact and suggestion. Evidence stays exact after
   schema trimming, and paths remain case-sensitive. Preserve distinct problems
   at one location. Select the highest-confidence original record, then severity
   and deterministic text ordering; do not manufacture a merged claim.
3. Sort retained findings by severity, confidence, path, line (null last), category
   and prose. Assign IDs in final display order, including after redaction. Ordering
   is deterministic for the same records and locale-independent. IDs are per-report.
4. Include application-owned selection counts and threshold in reports. Validate
   that candidates = retained + below threshold + duplicates, and that retained
   matches the actual finding count. Statistics describe the final validated
   response after any repair; rejected drafts are not counted or disclosed.
5. Replace summaries after filtering with retained counts/exclusion reasons. Also
   replace summaries for empty candidate sets, preventing an unsupported prose claim
   of a defect when no finding was returned. Unfiltered nonempty summaries still
   come from the model and are not semantically verified by the application.
6. Show a prominent notice for partial/budget/tool-limited coverage, retain the
   required no-findings sentence, render finding IDs, and describe confidence as
   a model estimate rather than a measured probability. Mock output remains labelled
   and has no invented selection statistics.
7. Separate validated/retained/low-confidence/duplicate totals in operational logs.
   Print compact changed/additional/test coverage and suppress repeated warnings.
8. Classify Anthropic errors by SDK type and HTTP status without displaying raw
   bodies or headers. Identify the CLI stage on failure and distinguish output-path
   failures from model failures. Authentication, access, payment-required, resource
   lookup, rate-limit, bad-request, network, timeout and service errors have static
   guidance. HTTP 400 cannot safely identify a unique cause from status alone.

## Limits

No additional model calls, automatic retries or dependencies were introduced.
Thresholds are deterministic; model confidence itself is not calibrated. Matching
duplicates is not general semantic/paraphrase deduplication. Tests exercise the
pipeline and presentation, not substantive review accuracy. Source/test execution
and GitHub writes remain outside scope. Phase 4 live tool verification is still
pending the owner's manually initiated run.

## Validation

Required: `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`.
All passed: 253 tests across 18 files, plus a compiled CLI help smoke check.
Regression cases cover threshold boundaries (including 0 and 1), confidence/severity
duplicate variants, code-whitespace preservation, distinct same-line findings,
deterministic sorting/IDs, selection accounting, empty/filtered reports, limited
coverage notices, safely classified SDK errors, CLI stage/output failures and
warning deduplication. Existing Phase 3/4 tool-boundary tests remain in place.

## Next user-run review

Use the current local CLI against the intended PR URL after pushing the code you
want reviewed. Rename any existing report for that PR before rerunning; the CLI
does not overwrite reports. The generated report should show Finding Selection,
IDs for retained findings and a coverage notice when appropriate. A model may
return zero findings; that is not a failed integration or proof of bug-free code.

Phase 6 will evaluate finding quality on curated cases rather than infer accuracy
from these engineering tests or a single live smoke run.
