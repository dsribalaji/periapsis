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
- `testTimeout` is 20 s, not Vitest's 5 s default. A handful of tests do real numerical work - the
  lunar free-return flies a 4,000-sample N-body integration twice, the departure phase search
  scans many geometries - and take 3-4 s each when the whole suite is competing for the CPU. At
  5 s they failed on load rather than on the physics. A timeout is a load budget, not leniency:
  no assertion, tolerance or test was changed to accommodate it (D-042).

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
| A wide numeric tolerance          | ±1,000 km around an altitude passed a readout that was wrong by 343,000 km                                 | Assert a readout against another readout, not against a constant      |
| `expect()` per pixel              | A 259,200-pixel opacity loop took 1.8 s alone and hit the 5 s timeout under 24 parallel workers            | Sweep with a stride, and assert the two ends explicitly               |
| A number copied into prose        | A return altitude of "337 km" survived a re-read; 7,045 − 6,371 = 686 is only checked when computed        | Every number in a doc comes from a printed measurement, not a draft   |

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

A sixth, from M5.5, and the most expensive one so far: **a tolerance wide enough to absorb a real
error is not a tolerance, it is a blindfold.** The e2e test for the mission altitude asserted
`-1000 < altitude < 1000` km, a range chosen to mean "sane" for an orbit at 550 km. It passed
while the app was reporting 337,018.8 km, because the defect it should have caught was in the
frame the _live radius_ is derived from and the number it read was simply not on the same orbit as
the plan. Two things fixed it: the live radius is now asserted against the panel's own apoapsis
(two readouts that describe the same orbit must agree), and the regression test is a craft that
does not move relative to its body, which must draw as a point. A tolerance has to be derived from
what the system can actually do, not picked to be safely round.

A seventh, from M6.2: **when two readouts disagree, derive the disagreement before you widen the
bound.** The ground-track map's altitude and the mission panel's altitude are the same quantity —
the true radius of one craft — so the first instinct was that they must be equal, and the second
was that the tiny gap was float32 storage. It was neither. The panel's radius comes from the drawn
frame, whose samples are joined by straight lines, so between samples it reports the chord radius
and the map reports the arc radius; the gap is the chord sagitta, `r(1 − cos(θ/2))`, predicted
3,526 m and measured 3,642 m at 550 km. Writing the derivation down took one line of arithmetic and
turned a "why doesn't this match" into a bounded, explanatory number — and, just as important, it
made the _other_ possible cause (a frame defect) refutable by four orders of magnitude. A test that
had simply grown a 5 km tolerance would have accepted the D-032 class of bug without noticing.

An eighth, from M6.3: **assert the mechanism, not the symptom, and check that the negative case
fails for the right reason.** The free-return scenario's claim is that the Moon turns the craft
around, so the test disables the Moon and requires no return. The first version also asserted that
the no-Moon path never comes near the Moon — and failed at 4,672 km, because the burn is aimed at
the Moon's position whatever gravity is acting. The scenario was fine; the test was asserting
geometry that could not separate the two cases. The lesson is not "loosen the bound" but "pick the
observable that only the mechanism can produce": here, the return distance, 43.7x larger without
the Moon. A related habit came out of the same session — every number that went into PHYSICS.md §14
was measured in one script that printed the whole table at once, because the first draft of the
prose carried an apogee and a return altitude that were arithmetically wrong (a 337 km return that
is really 686 km, 7,045 minus 6,371). Prose is not compiled, so a number in it needs to come from
an output buffer, not from a previous draft.

A ninth, from M7.2: **when the failure modes want different responses, model them separately at
the type level.** The first version of `loadScenario` returned `{ ok: false, reason: 'unreadable' }`
for both "the browser will not give me storage" and "the stored copy came from a newer build". The
app only needed to tell them apart at one point - whether it may overwrite the entry - and the
consequence of getting it wrong is silent data loss: a newer build's scenario replaced by a
default. Splitting `unreadable` into `unreadable` and `newer`, and then asserting the split in a
boot test that checks the store is byte-identical afterwards, turned a policy that lived in a
comment into one the compiler and the test both enforce. A boolean `ok` would have been enough to
load a scenario; it is not enough to decide what a failure is allowed to destroy.

The same milestone's e2e block produced a rule worth keeping: **an accepted-looking test can be
asserting the wrong layer.** Six tests passed on the first run, which is pleasant and also a
reason to check what they would catch. The reload test asserts the mission panel's planned delta-v
after the reload, not just the select's value, because restoring the dropdown alone would pass
while the spacecraft stayed on the default's orbit - the select is state, the plan is what that
state is supposed to produce.

## Coverage

`vitest` reports coverage over `src/core`, `src/sim` and `src/scenarios` only. `src/render` and
`src/ui` are covered by e2e instead: a line-coverage number for a WebGL scene measures that
lines ran, not that anything was drawn.

The exception is `src/ui/porkchopView.ts`, `src/ui/transferView.ts` and
`src/ui/groundTrackView.ts`, which are pure and unit tested even though they live in `src/ui`. The
rule is not "which folder" but "can it be tested without a browser": the colour ramp, the image
buffers and their orientation, the pointer-to-cell mapping, the axis ticks, the hover readout, the
cell-to-node conversion, the horizon decision, the equirectangular projection, the antimeridian and
gap splits, the marker interpolation and the track summary are all arithmetic, so they are asserted
directly and the canvases keep only the `putImageData` call. Both canvases are 2D, so their e2e
tests read them back with `getImageData` directly — the screenshot-decode path below is only needed
for the WebGL view.

The ground-track tests deliberately split into two layers, because the failure modes are different.
`tests/groundTrackView.test.ts` builds **synthetic** tracks for the projection and split rules - a
live wire of latitudes and longitudes with the crossing flags already set - so a failure means the
renderer is wrong rather than the ephemeris having moved. Two tests then run the same rules against
the **real** frame chain (`leo-raise` must produce crossings; a craft at the Earth's centre must
break the track), so the synthetic input cannot quietly drift away from what the core module
actually emits.

## Contrast

Measured from the token values in `src/ui/styles.css` with the WCAG relative-luminance formula, not
estimated by eye. Text pairs are held to 4.5:1 (normal text) and 3:1 (large text and UI
boundaries); the numbers below are the ratio of foreground to background.

| Pair                                    | Ratio | Use                                     |
| --------------------------------------- | ----- | --------------------------------------- |
| `--text` on `--bg`                      | 15.66 | body text over the canvas               |
| `--text` on `--panel`                   | 14.71 | body text in the sidebar                |
| `--text-faint` on `--panel`             | 8.00  | quiet suffixes, e.g. "(opened file)"    |
| `--accent` on `--panel`                 | 7.53  | links, focus ring, active labels        |
| `--warn` on `--panel`                   | 7.54  | caveats and the paused badge            |
| `--text-dim` on `--panel`               | 6.35  | section headings, secondary labels      |
| `--text-dim` on a hovered body row      | 5.88  | the distance column under the pointer   |
| white on `--accent-dim` (active button) | 4.63  | large/bold only; a fill, not body text  |
| `--accent-dim` on `--panel`             | 4.11  | the selected row's border (non-text)    |
| `--text` on `--accent-dim`              | 3.58  | not used; recorded so it stays unused   |
| `--accent` on `--accent-dim`            | 1.83  | not used; the reason `.active` is white |

The last two rows are there on purpose. They are the pairs that would look plausible and fail, and
recording them is what keeps a future change from reaching for `--accent-dim` as a text background.
The 1.83 is the specific reason the active warp button sets `color: #fff` rather than leaving the
accent colour in place - which is what it did before this pass.

Accessibility itself is asserted in `e2e/shell.spec.ts`: the skip link is the first tab stop and
moves focus to the sidebar, the 3D view and both canvases carry `role="img"` with a descriptive
label, the body list is reachable and activatable by keyboard, the live region reports pause and
warp, an import failure is an `alert`, and a reduced-motion context has zero transition duration
while the clock still advances. Focus order, roles and announcements have no visual signature, so
they are the one part of the UI that only an end-to-end test can check at all.

## Performance is measured, not tested

There is no performance assertion anywhere in this suite, and that is deliberate rather than an
omission. A timing threshold in a test fails on a shared CI runner for reasons that have nothing to
do with the change under review, and the usual response to that is to widen the threshold until it
catches nothing - a test that has been made green rather than a measurement that has been made
honest.

Instead, `scripts/benchmark.mjs` and `scripts/benchmark-frames.mjs` print numbers and exit 0, and
PERFORMANCE.md records what they said on a named machine. A performance regression is caught by
running two commands and comparing, which is a minute of work on the occasions it matters, rather
than by a test that runs on every commit and is right perhaps half the time.

The second script exists because the first cannot answer the question that matters. Node timings
say how long a function takes; they say nothing about whether the app holds a frame rate, which
depends on the renderer and the pixel count. That distinction produced the milestone's actual
finding - the frame rate was rasteriser-bound, not script-bound - which no amount of Node
measurement would have revealed.

The bundled scenarios are covered from two directions, and both are needed. `scenario.test.ts`
validates every entry structurally, so a malformed scenario cannot ship. It also re-derives the
hard-coded burns in `gto-transfer` and `earth-mars-departure` from `hohmannTransfer` and the
circularisation geometry (D-033): a literal burn is a measurement, and a measurement that nothing
recomputes goes stale silently — the scenario would still load and still draw, with a burn that no
longer reaches where its own description says. `e2e/shell.spec.ts` then asserts the scenarios in
the running app, because "the data is right" and "the app does the right thing with it" are
different claims.

The free-return scenario is the strongest case of this, because it is the one scenario whose
correctness is a _flight_ rather than a number. Its eight unit tests propagate the scenario's own
spec and check what came back: the burn is re-derived from vis-viva to confirm the resulting orbit
reaches the Moon, the flyby and return distances are asserted against the propagated path, and the
plan's 9-day horizon is checked to contain the 6.36-day return. The most important one is the
mutation: with the Moon removed from the body list the craft must _not_ come home. Writing it
exposed a trap worth recording. The obvious assertion - "without the Moon it stays far from the
Moon" - is false, because the burn is aimed at where the Moon will be: the unperturbed ellipse
closes to 4,672 km of lunar altitude against 2,694 km with the Moon present. Distance cannot
distinguish the cases; only the return can, and the test now asserts a 43.7x ratio on return
distance. A test that had asserted the intuitive thing would have passed for the wrong reason on
the day it was written and failed confusingly later.

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
