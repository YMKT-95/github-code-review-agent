# Cart demo: from a visible bug to a PR review

A local sample storefront for the HackAotearoa presentation. No extra dependencies,
API keys, checkout service or network calls are needed to run the page.

```bash
npm run demo:cart
# Open http://127.0.0.1:4173
npm run test:cart
```

The server binds only to loopback and serves five public assets. It cannot serve
`.env`, review reports or other repository files. Set `DEMO_PORT` to change the port.
Refresh the browser after editing source; assets are not cached. Stop with Ctrl+C.

## The shared behaviour

`pricing.js` is imported by both the browser and the regression tests. Amounts are
integer NZD cents. One tote costs $30; orders of $50 or more ship free; otherwise
shipping costs $5. Quantity is limited to 1–10.

The checked-in baseline is correct:

- Quantity 1: subtotal $30, shipping $5, total $35.
- Quantity 2: subtotal $60, shipping FREE, total $60.

The eligibility message reflects the advertised rule. The shipping charge and
total come from `calculateCart`. A regression in that function therefore becomes
visible as a contradiction between the stated eligibility and actual charge.

## Create the reviewable regression

First land the correct demo baseline (these files and tests) on your PR target
branch, normally `main`, through your usual review process. Keep the Phase 3
implementation PR separate from this small demonstration PR.

Then create a fresh branch from the updated target branch:

```bash
git switch main
git pull --ff-only
git switch -c demo/shipping-regression
```

In `demos/cart/pricing.js`, change just this expression:

```js
// Baseline
const shippingCents = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_FEE_CENTS;

// Deliberately introduced regression: substitute for the line above
const shippingCents = UNIT_PRICE_CENTS >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_FEE_CENTS;
```

Leave the tests unchanged. `npm run test:cart` should now fail on the two multi-item
cases. This is an intentional, disclosed evaluation fixture, not a real customer bug.
Refresh the page and select quantity 2: it now charges $5 on a qualifying $60 order.

Commit only this change and push the demo branch:

```bash
git add demos/cart/pricing.js
git commit -m "Demo: introduce a shipping eligibility regression"
git push -u origin demo/shipping-regression
```

Create a PR to `main` on GitHub. Explain the intended rule in its description:
“Orders of NZ$50 or more should ship free. Below that, shipping is NZ$5.” Tell your
audience the bug is seeded. Do not merge the intentionally broken version.

## Three-minute presentation

1. **Page:** select quantity 2. Show the free-shipping promise and the incorrect $65 total.
2. **PR:** show the small change and its actual GitHub URL.
3. **Agent:** from this repository run `npm run review -- ACTUAL_PR_URL`, replacing
   the placeholder with that URL. This step uses GitHub credentials and paid
   Anthropic API access; the storefront itself uses neither.
4. **Evidence:** open the Markdown report under `reviews/`. Explain the file/line,
   impact, and coverage. The agent reads PR code; it does not see or operate this page.
5. **Human verification:** run `npm run test:cart` to reproduce the defect. This is
   your test execution, not a capability of the review agent.
6. **Fix:** restore the subtotal comparison, refresh, and show the $60 total and
   passing tests. Commit and push the fix if you want the agent to review it again.

Before rerunning review on the same PR, rename the old report to preserve it (for
example, append `-before-fix`). The CLI refuses to overwrite reports. The original
report records its reviewed SHA; a local fix alone does not update the remote PR.

The Phase 4 agent can discover and read related tests and surrounding files at the
recorded revisions. These tools depend on MCP capability availability, budgets and
the model's choices. Search is indexed and not pinned to the PR; only subsequent
file reads count as evidence. Additional reads and finding the seeded bug are not
guaranteed. Keep the actual report even if it misses the bug; do not replace
it with fabricated findings. Rehearse and save a real recording/report as a fallback.
`--mock` is only a labelled offline example and does not review this cart's code.
