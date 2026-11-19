# TESTING

What is tested, at which level, and what a test is allowed to assert.

## The three levels

| Level      | Command                                | Where    | Runs in                               |
| ---------- | -------------------------------------- | -------- | ------------------------------------- |
| Unit       | `npm test` (`vitest run`)              | `tests/` | Node, no DOM, no browser              |
| End-to-end | `npm run test:e2e` (`playwright test`) | `e2e/`   | Real Chromium against the real bundle |
| Gate       | `npm run verify`                       | —        | typecheck + lint + unit + build       |

`npm run verify` is what "green" means. It does not include the e2e suite, because that needs
a browser download; run both before claiming a milestone is done.

## What each level is for

**Unit tests** are the physics evidence. They run with no DOM and no timer, which is only
possible because `src/core` and `src/sim` are pure. A physics claim that is not backed by a
unit test is not a claim.

**E2E tests** are the evidence that the app runs. A green unit suite says nothing about
whether React mounts, whether WebGL starts, or whether the clock visible on screen actually
moves. Each e2e test drives the real page in a real browser.

**Nothing is tested at two levels for its own sake.** A Hohmann transfer is a unit test; "the
clock on screen advances" is an e2e test. The overlap is deliberately small.

## Rules that are not negotiable

1. **Never weaken or delete a test to get green.** If a test is wrong, fix the test and say why
   in the commit. If the code is wrong, fix the code.
2. **Every tolerance has a justification.** Numeric assertions are not tuned until they pass.
   Each bound is either derived from the model's error budget or measured, and it is written
   down in `PHYSICS.md` alongside the test. A tolerance without a justification is a bug.
3. **A passing claim means the command was run.** Not inferred, not assumed from a previous
   run.
4. **Tests must fail for the right reason.** A test that would also pass if the feature were
   removed is not testing the feature. The e2e drag test asserts both that the frame changed
   _and_ that the selection did not, because either alone is satisfiable by a broken app.

## Conventions

- Test names state the behaviour, not the method: `rejects a warp the clock does not offer`,
  not `test warp validation`.
- Property tests (`fast-check`) are used where an invariant should hold for all inputs —
  round trips, conservation laws — and a **concrete example is asserted too**, so a failure is
  readable.
- Comparisons use `toBeCloseTo` with an explicit digit count, which states the tolerance at
  the call site.
- Tests that would otherwise be flaky are made deterministic rather than retried. The e2e suite
  runs with `retries: 0` on purpose: a test that needs a retry is a test that is wrong.

## Known gotchas

| Gotcha                            | Why                                                                                                        | What to do                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| IEEE-754 subnormals               | A generator can produce values so small that relative error explodes                                       | Exclude them in the generator                                         |
| `-0` vs `+0`                      | `Object.is(-0, 0)` is false, so `toBe` fails                                                               | Use `toBeCloseTo`                                                     |
| Element round trip near apsides   | True anomaly is ill-conditioned there (~1.5e-8 relative)                                                   | Bound the test accordingly, and say why in a comment                  |
| WebGL canvas readback             | `readPixels` returns blank after compositing                                                               | Screenshot the element and decode the PNG in-page                     |
| Clock readout assertions          | The clock is running, so any time-of-day assertion races                                                   | Assert something that does not move (the epoch label), or pause first |
| Dev server in a piped shell       | Background shells die when piped through `Select-Object`                                                   | Let Playwright start the server itself                                |
| 2D canvas in the sidebar          | Its lower half is below the fold at 1280x720, so `mouse.move` misses                                       | `scrollIntoViewIfNeeded` before computing the hover point             |
| `display: flex` on a container    | It beats the `hidden` attribute's UA `display: none`                                                       | Add an explicit `[hidden] { display: none }` rule                     |
| A form option named like a body   | `<option>Mars</option>` makes `getByText('Mars').first()` the option                                       | Scope the locator to the region under test (`.body-list`)             |
| A hover that drives a button      | `pointerleave` clears it exactly as the user reaches the button                                            | Select on click, and act on the selection (D-027)                     |
| Two axis ticks, one label         | A narrow range rounds two ticks to the same string, so `key={label}` duplicates                            | Key by position, not by text                                          |
| Wall-clock assertions on a laptop | The CPU idles at 1.5 GHz of 2.2 GHz on battery, so a timing budget fails for reasons unrelated to the code | Compare measurements taken in the same clock state, or record both    |

A fourth rule, learned the hard way in M5.3: **a test that hovers must also prove the hover
survives.** Replacing a short hint with a tall list reflows the sidebar, which moves the plot
out from under the pointer, which clears the hover — the readout flickers between "hovered" and
"not hovered" forever, and a single `mouse.move` followed by an assertion passes on the first
frame of that oscillation. The regression test hovers once and then asserts the _same_ cell an
idle 700 ms later; the fix was a fixed-height readout block that is always present.

A fifth, from M5.4: **assert the invariant, not the sample that happened to satisfy it.** An e2e
test pinned the cheapest porkchop window to `depart 2026-` because 2026 was where the cheapest
cell fell. When the default window was moved to start at the epoch (D-028), the cheapest cell
became the 2028 Mars window and the test failed while the app was more correct than before. The
test now extracts the departure date and the scenario epoch and asserts the ordering between
them, which is the property that actually matters (a past cell cannot become a node). A date
literal in an assertion is usually a measurement wearing an invariant's clothes.

## Coverage

`vitest` reports coverage over `src/core`, `src/sim` and `src/scenarios` only. `src/render` and
`src/ui` are covered by e2e instead: a line-coverage number for a WebGL scene measures that
lines ran, not that anything was drawn.

The exception is `src/ui/porkchopView.ts` and `src/ui/transferView.ts`, which are pure and unit
tested even though they live in `src/ui`. The rule is not "which folder" but "can it be tested
without a browser": the colour ramp, the image buffer and its orientation, the pointer-to-cell
mapping, the axis ticks, the hover readout, the cell-to-node conversion and the horizon decision
are all arithmetic, so they are asserted directly and the canvas keeps only the `putImageData`
call. That canvas is 2D, so its e2e test reads it back with `getImageData` directly — the
screenshot-decode path below is only needed for the WebGL view.

Note on screenshots: the agent building this cannot view images, so a screenshot is never
evidence in itself. `scripts/inspect-screenshot.mjs <file>` decodes one and reports its
dimensions, the fraction of non-background pixels, the number of distinct colour buckets and
how many pixels match the mission colour, so a blank or trajectory-free frame fails loudly.
The real evidence that drawing works is the e2e pixel-colour test, which runs against the live
canvas.

## Adding a test

- Physics or time behaviour → `tests/<module>.test.ts`, plus a `PHYSICS.md` entry if the test
  asserts a numeric tolerance.
- Scenario or validation behaviour → `tests/scenario.test.ts`.
- Anything that requires the DOM, React or WebGL → `e2e/shell.spec.ts`.

If a test needs a fake, prefer a real value object (`createClock`, a hand-built scenario
literal) over a mock. There is nothing in the lower layers that cannot be constructed directly.
