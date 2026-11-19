# Engineering notes

Four bugs from this project that are worth reading about. Each one shipped past a passing test
suite, and each one says something general about building numerical software that draws what it
computes. The numbers are measured; the decision records they come from are linked.

## 1. The Moon orbited the Sun

**Symptom.** The "Earth and Moon" scenario drew the Moon beside the Sun, three quarters of the way
from Earth. The README's own screenshot showed it.

**Cause.** Planets were drawn 282x too large (a cube-root radius compression), because at true
scale Earth is invisible from any useful distance. A 400 km orbit then sat _inside_ the inflated
Earth, so trajectories were drawn at Earth's exaggeration too, and so was the Moon, to keep it on
the trajectory flying to it. The Moon landed 72 scene units from Earth. Earth is 100 units from
the Sun.

**The tempting fix**, and the one first attempted: hide the Moon when the camera is far away. It
removes the wrong picture without correcting the position, and it hid the Moon in the one
scenario built to show it.

**The real fix** removed the second scale. Every length is drawn at one true scale, and
visibility moved to the screen: a body is drawn at its true radius or a few pixels, whichever is
larger, recomputed every frame. A satellite appears once it visibly separates from its parent.
With one scale, the Moon is 60.3 Earth radii out _by construction_; there is no placement rule
left to get wrong. ([ADR-0008](ADR/ADR-0008-true-scale-bodies.md))

**Lesson.** When a compensation needs its own compensation, the first one is the bug.

## 2. A 550 km orbit drawn as a 343,000 km streak

**Symptom.** The low-Earth-orbit path smeared off the planet, and the mission panel read "radius
now 343,389 km" directly above "apoapsis 7,152 km".

**Cause.** The heliocentric trajectory was converted to Earth-relative by subtracting Earth's
position at the _epoch_. Earth moves 30 km/s, so over a few hours the offsets accumulated
Earth's own travel, and the scene then added Earth's live position back on top. Two
individually reasonable steps counted the same motion twice.

**Fix.** Subtract Earth's position at _each sample's own time_. A regression test pins the
invariant in its simplest form: a craft sitting on Earth's centre must be drawn at the origin at
every sample, however far Earth travels. ([D-032](DECISIONS.md))

**Lesson.** The test that caught it compared two of the app's own readouts against each other.
Self-consistency checks are cheap and find frame bugs that tolerance checks wave through.

## 3. A random seed found a precision loss at apoapsis

**Symptom.** The state-to-elements round-trip property test failed once, on a random seed: an
e = 0.79 orbit 3e-10 rad short of apoapsis came back with a 1.2e-7 relative velocity error
against a 1e-7 bound.

**Cause.** The true anomaly was computed with `acos` of a cosine near -1, which loses half the
mantissa. The comment beside the bound already explained this; the inclination had already been
moved to `atan2` for exactly that reason; the other three angles had not.

**Fix.** Not a looser bound. All in-plane angles are now `atan2(sine, cosine)`, with the sine
taken from a cross product, which also removed three hand-written sign patches. The
counterexample is pinned as its own test and now round-trips at about 1e-16; the property
passed 40,000 runs after the change. ([D-048](DECISIONS.md))

**Lesson.** A property test with an unpinned seed is a fuzzer. Treat its rare failures as bug
reports, keep the seed, and pin the counterexample.

## 4. Procedural textures made the app take 14.7 s to start

**Symptom.** An unrelated end-to-end test ("remembers the scenario across a reload") began timing
out at 30 s. The whole suite went from 4.7 to 16.6 minutes.

**Cause.** The new procedural planet textures were generated on the main thread at 1024 and 512
pixels: 2.8 million pixels and 1.8 billion noise-hash operations before the first interaction.

**Fix.** A pixel budget per body, set by how large the body is ever actually drawn, measured at
760 ms for all of them. ([D-046](DECISIONS.md))

**Lesson.** The interaction tests had a time budget, so a visual feature that silently made the
app unusable failed a test about something else. Budgets in tests catch regressions that no
assertion names.

## How the project is checked

- **About 730 unit tests**, with every numerical tolerance justified in [PHYSICS.md](PHYSICS.md).
  Physics is checked against independent facts rather than restated formulas: Apophis passing
  within 0.01 AU of Earth on 13 April 2029, Halley at perihelion on 9 February 1986, a Hohmann
  GTO costing what the textbook says.
- **About 70 end-to-end tests** in a real Chromium with software WebGL, including ones that count
  pixels of the trajectory colour on the canvas, because "the line is in the scene graph" and
  "the line is on the screen" are different claims.
- **A lint-enforced pure core**: no DOM, no clock and no randomness under `src/core` and
  `src/sim`, so the physics is testable without a browser.
- **CI** runs formatting, typecheck, lint, unit tests, the build and the browser suite on every
  push.
