/**
 * Performs the CPU work the app does, against the real modules, and prints numbers.
 *
 * Run with `npm run bench`. Nothing here is a test: no assertion, no threshold, no pass or fail.
 * The point is to produce the figures that STATE.md and TESTING.md quote, so the performance
 * claims in the docs come from an output buffer rather than from a guess - the same rule the
 * physics numbers follow.
 *
 * `runnerImport` from Vite loads the TypeScript sources through the project's own config, so what
 * is measured is the code that ships rather than a re-implementation of it. Vite is a
 * devDependency, so this needs no new one, and nothing is downloaded at run time.
 *
 * Timings are wall-clock on whatever machine runs this. They are reported with the machine's CPU
 * alongside so a reader knows what they are relative to, and the median is quoted rather than the
 * mean because a single garbage collection should not move the number the docs print.
 */

import { cpus, arch, platform } from 'node:os';
import { runnerImport } from 'vite';

const { SCENARIOS } = (await runnerImport('./src/scenarios/catalogue.ts')).module;
const { Simulation } = (await runnerImport('./src/sim/simulation.ts')).module;
const { buildMissionPlan, missionProgress } = (await runnerImport('./src/ui/missionView.ts'))
  .module;
const { computePorkchop } = (await runnerImport('./src/core/transfer/porkchop.ts')).module;
const { defaultPorkchopRequest, requestToOptions } = (
  await runnerImport('./src/ui/porkchopView.ts')
).module;
const { groundTrackImage, summariseGroundTrack } = (
  await runnerImport('./src/ui/groundTrackView.ts')
).module;

/** Milliseconds of wall clock for one call, measured `runs` times. */
function time(runs, fn) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  return { median, p95, min: samples[0], max: samples[samples.length - 1] };
}

function ms(value) {
  return value < 1 ? `${(value * 1000).toFixed(0)} us` : `${value.toFixed(2)} ms`;
}

/** Chip name, so a reader knows what the numbers are relative to. */
function cpuName() {
  const list = cpus();
  return `${list[0]?.model?.trim() ?? 'unknown CPU'} (${list.length} logical, ${platform()}/${arch()})`;
}

console.log(`Periapsis benchmark`);
console.log(`node ${process.version}`);
console.log(cpuName());
console.log('');

const missions = SCENARIOS.filter((s) => s.mission);

// ---------------------------------------------------------------------------------------------
// Mission plan build. This is the work behind a scenario switch and behind "Plan departure": a
// propagation, a frame conversion, an orbit-radius series and (for Earth) a ground track.
// ---------------------------------------------------------------------------------------------
console.log('buildMissionPlan - one call, the cost of switching to a scenario');
const planRows = [];
for (const scenario of missions) {
  const spec = scenario.mission;
  // Two warm-up calls so the timing is not dominated by the first-run JIT and module lazily
  // initialized state. The number reported is from the timed runs that follow.
  buildMissionPlan(spec, scenario.epochUtc);
  buildMissionPlan(spec, scenario.epochUtc);
  const t = time(9, () => buildMissionPlan(spec, scenario.epochUtc));
  const plan = buildMissionPlan(spec, scenario.epochUtc);
  planRows.push({ id: scenario.id, t, points: plan.frame.pointTimes.length });
  console.log(
    `  ${scenario.id.padEnd(20)} ${ms(t.median).padStart(9)} median  ` +
      `${ms(t.p95).padStart(9)} p95  ` +
      `${String(plan.frame.pointTimes.length).padStart(6)} points, ` +
      `${String(plan.groundTrack?.samples.length ?? 0).padStart(5)} track samples`,
  );
}

// ---------------------------------------------------------------------------------------------
// Frame loop. `Simulation.advance` plus `positions()` is what runs 60 times a second; the scene
// update and the draw are WebGL and are measured in the browser instead (see TESTING.md).
// ---------------------------------------------------------------------------------------------
console.log('');
console.log('frame work - advance() + positions() at a 16.7 ms frame, worst case at each warp');
const FRAME_MS = 16.7;
const worst = missions.reduce((a, b) =>
  b.mission.horizonSeconds > a.mission.horizonSeconds ? b : a,
);
for (const warp of [1, 1e3, 1e5, 1e7]) {
  const sim = new Simulation(worst.epochUtc, warp);
  // Let the clock settle out of its first frame, and let the ephemeris warm up.
  for (let i = 0; i < 8; i++) {
    sim.advance(FRAME_MS);
    sim.positions();
  }
  const t = time(60, () => {
    sim.advance(FRAME_MS);
    sim.positions();
  });
  // A frame budget is 16.7 ms at 60 Hz. The share below is how much of one frame this work
  // takes, which is the number that decides whether the app can hold 60 fps.
  const share = (t.median / FRAME_MS) * 100;
  console.log(
    `  warp ${String(warp).padStart(8)}  ${ms(t.median).padStart(9)} median  ` +
      `${ms(t.p95).padStart(9)} p95  ${share.toFixed(1).padStart(5)}% of a 60 Hz frame`,
  );
}

// ---------------------------------------------------------------------------------------------
// Porkchop. The default grid is 100x100 Lambert solves, which is the expensive deliberate action
// in the app; the field is offered up to 200x200.
// ---------------------------------------------------------------------------------------------
console.log('');
console.log('computePorkchop - one grid, the cost of pressing "Compute plot"');
const base = defaultPorkchopRequest(missions[0].epochUtc);
for (const size of [100, 200]) {
  const options = requestToOptions({ ...base, size });
  computePorkchop(options);
  const t = time(5, () => computePorkchop(options));
  const grid = computePorkchop(options);
  console.log(
    `  ${String(size).padStart(3)}x${size}  ${ms(t.median).padStart(9)} median  ` +
      `${ms(t.p95).padStart(9)} p95  ${String(grid.columns * grid.rows).padStart(6)} cells, ` +
      `${String(grid.totalDeltaV.filter((v) => Number.isFinite(v)).length).padStart(6)} solved`,
  );
}

// ---------------------------------------------------------------------------------------------
// Ground track image. Runs on every scenario switch for an Earth mission, and on every clock tick
// only the marker moves, so this is the per-plan cost rather than the per-frame one.
// ---------------------------------------------------------------------------------------------
console.log('');
console.log('groundTrackImage + summariseGroundTrack - one call, per Earth mission plan');
const earthMission = missions.find(
  (s) => s.mission.centralBody === 'earth' && s.id === 'leo-raise',
);
if (earthMission) {
  const plan = buildMissionPlan(earthMission.mission, earthMission.epochUtc);
  if (plan.groundTrack) {
    const track = plan.groundTrack;
    groundTrackImage(track);
    summariseGroundTrack(track);
    const t = time(20, () => {
      groundTrackImage(track);
      summariseGroundTrack(track);
    });
    console.log(
      `  ${String(track.samples.length).padStart(5)} samples  ${ms(t.median).padStart(9)} median  ` +
        `${ms(t.p95).padStart(9)} p95`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Progress. Runs on every frame while a mission is flying, so it is the one function whose cost is
// paid 60 times a second whether anything is happening or not.
// ---------------------------------------------------------------------------------------------
console.log('');
console.log('missionProgress - one call, per frame while a mission is live');
for (const scenario of missions) {
  const plan = buildMissionPlan(scenario.mission, scenario.epochUtc);
  missionProgress(plan, plan.horizonSeconds / 2);
  const t = time(200, (i) => missionProgress(plan, (plan.horizonSeconds / 200) * i));
  console.log(`  ${scenario.id.padEnd(20)} ${ms(t.median).padStart(9)} median`);
}
