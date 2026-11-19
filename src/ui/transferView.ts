/**
 * Transfer-to-node view-model: turns a chosen porkchop cell into a maneuver node.
 *
 * This is the join the two halves of the mission tools were missing. A porkchop plot answers
 * "when should this leave?" in hyperbolic excess speed; a maneuver node is what the
 * simulation can actually fly. Everything between those two is arithmetic, and it lives here
 * rather than in either panel so that it can be tested without a browser and so that neither
 * panel has to know the other's conventions.
 *
 * Three conversions happen, in this order, and each is a place a plausible-looking bug can
 * hide:
 *
 * 1. **Frame.** The porkchop's excess velocity is `v_heliocentric - v_body`, which is exactly
 *    a body-relative velocity. A parking orbit about that body is defined in body-relative
 *    terms too, so the aim direction transfers with no rotation. Getting this wrong is the
 *    classic "heliocentric burn" bug: prograde would then mean "along the planet's orbital
 *    velocity", off by 90 degrees for a LEO departure.
 *
 * 2. **Cost.** The porkchop's number is an excess speed, not a burn. `planDeparture` turns it
 *    into the real impulsive burn from the parking orbit, Oberth effect included (PHYSICS.md
 *    11.2). The difference is large and routinely in the thousands of m/s, so the node is
 *    built from the burn, never from the cell's cost.
 *
 * 3. **Timing.** The cell's departure date is a calendar fact; the burn cannot happen at an
 *    arbitrary point on the parking orbit. `planDeparture` picks the cheapest phase and this
 *    module converts that phase into a node time relative to the scenario epoch. The
 *    conversion uses the craft's *actual* phase at the requested date, not the epoch phase:
 *    see {@link waitToPhase} for why the naive answer is wrong by a whole orbit. The node
 *    therefore sits within one parking period after the cell's departure instant, and the
 *    shift is reported so it is visible rather than silently absorbed.
 *
 * Pure: no DOM, no clock, no randomness.
 */

import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import { SECONDS_PER_DAY } from '../core/constants.js';
import { isoUtcFromJd, jdFromIsoUtc, jdUtcFromJdTt } from '../core/time/time.js';
import { type Vec3, dot, normalize } from '../core/math/vec3.js';
import { planDeparture, type DeparturePlan } from '../core/transfer/departure.js';
import type { CellAsymptote } from '../core/transfer/porkchop.js';
import { circularOrbitFrame, type CircularOrbitSpec, type CraftSpec } from '../sim/craft.js';
import type { Maneuver } from '../sim/maneuver.js';

/** Everything a caller must supply to convert a cell into a node. */
export interface TransferContext {
  /** The cell's departure asymptote, from `departureAsymptote`. */
  readonly asymptote: CellAsymptote;
  /** Body the craft is parked around. Must equal the cell's departure body. */
  readonly centralBody: BodyId;
  /**
   * The craft's parking orbit: altitude, inclination and phase.
   *
   * The phase is taken from here rather than as a separate argument on purpose. It is the same
   * number `craftFromSpec` uses, so the node cannot be built for a craft sitting somewhere its
   * own description does not put it. Two sources for one phase is how the burn ends up at the
   * right radius and the wrong place.
   */
  readonly orbit: CircularOrbitSpec;
  /** Scenario epoch, ISO-8601 UTC. Node times are measured from it. */
  readonly epochUtc: string;
}

export interface TransferNode {
  readonly maneuver: Maneuver;
  /** The full departure solution, so a panel can explain itself. */
  readonly plan: DeparturePlan;
  /** Departure instant the cell asked for, ISO-8601 UTC. */
  readonly requestedDepartureIso: string;
  /** Instant the burn actually happens, ISO-8601 UTC. */
  readonly burnIso: string;
  /**
   * How far the burn sits after the requested departure instant, seconds.
   *
   * Between 0 and one parking period. See {@link buildTransferNode} for why it is not zero.
   */
  readonly shiftSeconds: number;
  /**
   * Where on the parking orbit the craft is at the burn, radians from the epoch radial.
   *
   * Equal to the node's component frame: the burn's `prograde`/`normal`/`radial` are the
   * local axes *here*. Returned so a caller can assert the two agree instead of trusting it.
   */
  readonly burnPhaseRad: number;
  /**
   * Facts about the node that do not make it unflyable but that a planner should see.
   *
   * Currently one kind: a periapsis inside the body. That is not an error — the burn happens
   * on the outbound leg and the craft's radius only increases afterwards, so the simulated
   * path never enters the body — but it means the arc grazes the surface, which no real
   * departure would be allowed to do. Reported rather than refused.
   */
  readonly warnings: readonly TransferIssue[];
}

/** Why a cell could not become a node. Machine-readable so a panel can group them. */
export type TransferIssue =
  | { readonly kind: 'wrong-body'; readonly message: string }
  | { readonly kind: 'no-solution'; readonly message: string }
  | { readonly kind: 'below-surface'; readonly message: string }
  | { readonly kind: 'before-epoch'; readonly message: string };

export type TransferResult =
  | { readonly ok: true; readonly node: TransferNode }
  | { readonly ok: false; readonly issues: readonly TransferIssue[] };

/**
 * Builds the maneuver node for a chosen porkchop cell.
 *
 * The node is expressed in the craft's local orbital frame (`frame: 'local'`), because that is
 * what makes a burn mean the same thing wherever the craft happens to be, and because the
 * departure solution was derived in exactly that frame. The node time is measured from the
 * scenario epoch, since that is what `Maneuver.timeSeconds` means.
 *
 * **The timing shift, stated plainly.** The burn must happen at the phase the solve chose, so
 * it happens at the first passage of that phase at or after the cell's departure date. That
 * places it up to one parking period *after* the requested date. For a 300 km orbit that is
 * at most 90 minutes against a transfer measured in hundreds of days: 0.02% of the time of
 * flight. The alternative - burning at the calendar instant wherever the craft happens to be -
 * can cost thousands of m/s, which is not a rounding error. The shift is returned rather than
 * hidden, so a panel can show it.
 */
export function buildTransferNode(context: TransferContext): TransferResult {
  const { asymptote, centralBody, orbit, epochUtc } = context;

  if (asymptote.departureBody !== centralBody) {
    return {
      ok: false,
      issues: [
        {
          kind: 'wrong-body',
          message:
            `The cell departs ${asymptote.departureBody} but the craft is parked at ` +
            `${centralBody}. Pick a cell whose departure body matches the craft.`,
        },
      ],
    };
  }

  const bodyRadius = BODIES[centralBody].radius;
  const mu = BODIES[centralBody].mu;
  const radius = bodyRadius + orbit.altitudeM;
  const warnings: TransferIssue[] = [];

  // The orbital frame comes from the craft's own parameterisation, via `circularOrbitFrame`,
  // not from a second derivation of the same geometry. That matters: hand-building the normal
  // as `(0, sin i, cos i)` gets its *sign* wrong for an inclined orbit (the true normal is
  // `(0, -sin i, cos i)` there, which is `r x v` for this basis), and that silently mirrors the
  // bump of the burn, so the node list and the propagator would disagree about what it means.
  // One definition, in `sim/craft.ts`, for both.
  const frame = circularOrbitFrame(orbit);

  const plan = planDeparture({
    mu,
    radius,
    vInf: asymptote.vInf,
    asymptote: asymptote.direction,
    parkingNormal: frame.normal,
    parkingRadial: frame.radial,
    bodyRadius,
  });

  if (!plan) {
    return {
      ok: false,
      issues: [
        {
          kind: 'no-solution',
          message:
            'No single burn from this parking orbit reaches that departure direction and speed. ' +
            'A parking plane closer to the target asymptote is usually the fix.',
        },
      ],
    };
  }

  if (plan.burn.periapsisBelowSurface) {
    // Not fatal, and the arithmetic says why: the burn happens on the outbound leg at radius
    // `r`, the true anomaly is positive, and the radius afterwards only grows toward infinity.
    // The craft never reaches that periapsis. It also is not harmless: a hyperbola whose
    // periapsis is inside the body is one a real departure trajectory would be rejected for,
    // so it is reported as a warning and carried into the node rather than swallowed.
    warnings.push({
      kind: 'below-surface',
      message:
        'The cheapest departure from this parking plane has its periapsis inside ' +
        `${centralBody} (${(plan.burn.periapsisRadius / 1000).toFixed(0)} km against a ` +
        `${(bodyRadius / 1000).toFixed(0)} km radius). The burn happens outbound so the path ` +
        'does not enter the body, but a real departure would not fly this arc: a parking ' +
        'inclination closer to the target asymptote removes the plane change that causes it.',
    });
  }

  // Node time. The cell's date is when the transfer leaves, but the craft is not sitting at
  // the chosen burn phase then: it is wherever its orbit has carried it. The solve's phase is
  // measured from the epoch radial (that is the basis `planDeparture` was given), so the craft
  // reaches phase `n t` at time `t` and the burn happens at the first passage of the solve's
  // phase at or after the requested instant.
  //
  // Skipping this and using `plan.timeToBurnSeconds` directly is wrong by an arbitrary angle:
  // measured on an Earth-Mars cell 314 days out, a 300 km orbit has advanced 3.5e4 rad, so the
  // node would be placed at a phase unrelated to the one the solve costed, and the burn would
  // not fly the trajectory the porkchop plotted.
  const departureJdUtc = jdUtcFromJdTt(asymptote.departureJdTt);
  const epochJdUtc = jdFromIsoUtc(epochUtc);
  const requestedSeconds = (departureJdUtc - epochJdUtc) * SECONDS_PER_DAY;
  const meanMotion = (2 * Math.PI) / plan.parkingPeriod;
  const phaseAtRequest = orbit.phaseRad + meanMotion * requestedSeconds;
  const shiftSeconds = wrapTo2Pi(plan.phaseRad - phaseAtRequest) / meanMotion;
  const timeSeconds = requestedSeconds + shiftSeconds;

  if (!(timeSeconds >= 0)) {
    return {
      ok: false,
      issues: [
        {
          kind: 'before-epoch',
          message:
            `That departure is ${Math.abs(requestedSeconds / SECONDS_PER_DAY).toFixed(0)} days ` +
            'before the scenario epoch, so it cannot be a node. Pick a later window or an ' +
            'earlier epoch.',
        },
      ],
    };
  }

  // A local burn's components are prograde/normal/radial, which is exactly what the
  // departure solve produced. No frame conversion is needed or wanted.
  const maneuver: Maneuver = {
    id: nodeId(asymptote),
    timeSeconds,
    a: plan.burn.prograde,
    b: plan.burn.normal,
    c: plan.burn.radial,
    frame: 'local',
    label: nodeLabel(centralBody, plan),
  };

  const burnJdUtc = epochJdUtc + timeSeconds / SECONDS_PER_DAY;

  return {
    ok: true,
    node: {
      maneuver,
      plan,
      requestedDepartureIso: isoUtcFromJd(departureJdUtc),
      burnIso: isoUtcFromJd(burnJdUtc),
      shiftSeconds,
      burnPhaseRad: plan.phaseRad,
      warnings,
    },
  };
}

/** `TMI 3.62 km/s` style label: the destination and the burn that gets there. */
export function nodeLabel(centralBody: BodyId, plan: DeparturePlan): string {
  void centralBody;
  return `Depart ${(plan.burn.deltaV / 1000).toFixed(2)} km/s`;
}

/**
 * A stable, readable node id derived from the departure date.
 *
 * Deterministic rather than random, so re-deriving the same node from the same cell produces
 * the same id and a scenario file diffs cleanly. Daily resolution is enough because a cell
 * carries a departure date, not an instant.
 */
export function nodeId(asymptote: CellAsymptote): string {
  const iso = isoUtcFromJd(jdUtcFromJdTt(asymptote.departureJdTt));
  return `depart-${iso.slice(0, 10)}`;
}

/**
 * Which components of a departure burn dominate, for a one-line explanation.
 *
 * A burn quoted as "7.79 km/s" is unreadable; "6.51 along the orbit normal" is a diagnosis,
 * and it points at the fix (a parking plane nearer the target asymptote). Reported in order
 * of size, with anything under a few percent of the total omitted rather than printed as
 * noise.
 */
export function describeBurn(plan: DeparturePlan): string {
  const total = plan.burn.deltaV;
  if (!(total > 0)) return 'no burn';
  const parts: { name: string; value: number }[] = [
    { name: 'prograde', value: Math.abs(plan.burn.prograde) },
    { name: 'normal', value: Math.abs(plan.burn.normal) },
    { name: 'radial', value: Math.abs(plan.burn.radial) },
  ];
  parts.sort((a, b) => b.value - a.value);
  const significant = parts.filter((p) => p.value / total > 0.03);
  const list = significant.map((p) => `${(p.value / 1000).toFixed(2)} km/s along ${p.name}`);
  const lead = significant[0] && significant[0].value / total > 0.85 ? 'almost entirely' : 'mostly';
  return `${lead} ${list.join(', ')}`;
}

/**
 * Signed elevation of the aim above the parking plane, radians, in (-pi/2, pi/2).
 *
 * The single number that explains why a departure from a 28.5-degree orbit to a near-ecliptic
 * asymptote costs twice the ideal: the aim sits most of that angle out of the parking plane,
 * and the burn has to buy the difference.
 *
 * The plane normal comes from the zero-phase state, where the orbit crosses the reference x
 * axis, so it does not depend on where the craft happens to be when the function is called.
 */
export function aimElevationAboveParking(direction: Vec3, orbit: CircularOrbitSpec): number {
  const normal = circularOrbitFrame(orbit, 0).normal;
  const planar = normalize(direction);
  return Math.asin(Math.max(-1, Math.min(1, dot(planar, normal))));
}

/**
 * The departure excess speed implied by the node's own numbers.
 *
 * Independent of the solver's bookkeeping: the parking velocity is purely prograde with
 * magnitude `parkedSpeed`, so the post-burn speed is
 * `sqrt((parkedSpeed + prograde)^2 + normal^2 + radial^2)`, and the excess speed follows from
 * `w^2 = 2 mu / r + v_inf^2`. With `mu / r = parkedSpeed^2` this is
 * `sqrt(w^2 - 2 parkedSpeed^2)`. A panel that shows both the burn and the excess speed can
 * therefore not display two numbers that disagree.
 */
export function nodeExcessSpeed(plan: DeparturePlan): number {
  const { prograde, normal, radial } = plan.burn;
  const postSpeedSq = (plan.parkedSpeed + prograde) ** 2 + normal ** 2 + radial ** 2;
  const excessSq = postSpeedSq - 2 * plan.parkedSpeed * plan.parkedSpeed;
  return Math.sqrt(Math.max(0, excessSq));
}

/**
 * One paragraph describing a planned departure, for the panel under the plot.
 *
 * Reports four things a reader needs in order to trust the node: what it costs, what the
 * porkchop cell promised, when it happens, and how far the burn slid from the requested date.
 * The shift is the number most easily mistaken for a bug, so it is stated in minutes rather
 * than left out. Deliberately one string, not a structure: it is shown verbatim and asserted
 * verbatim.
 */
export function departureSummary(node: TransferNode): string {
  const burnKm = node.maneuver.label ?? `${(node.plan.burn.deltaV / 1000).toFixed(2)} km/s`;
  const excess = nodeExcessSpeed(node.plan);
  const minutes = node.shiftSeconds / 60;
  const shift =
    node.shiftSeconds < 1
      ? 'at the requested instant'
      : `${minutes.toFixed(0)} min after the requested date, at the cheapest point on the orbit`;
  return (
    `Node ${node.maneuver.id}: ${burnKm} (${describeBurn(node.plan)}) at ${node.burnIso}, ` +
    `${shift}. It reaches ${(excess / 1000).toFixed(2)} km/s of excess speed.`
  );
}

/**
 * Puts a node into a mission, replacing any node with the same id.
 *
 * Replacing rather than appending is what makes re-planning from the same cell idempotent: a
 * user who hovers, plans, changes a form field and plans the same cell again must end up with
 * one node, not two identical burns at the same instant. The output is ordered the same way
 * `sortedManeuvers` orders at propagation time, so the node list is not in a different order
 * from the burns that get flown.
 */
export function withManeuver(craft: CraftSpec, maneuver: Maneuver): CraftSpec {
  const others = craft.maneuvers.filter((m) => m.id !== maneuver.id);
  const maneuvers = [...others, maneuver].sort(
    (x, y) => x.timeSeconds - y.timeSeconds || x.id.localeCompare(y.id),
  );
  return { ...craft, maneuvers };
}

/**
 * Coast drawn after a planned departure, seconds: one day.
 *
 * A hyperbola with a 3 km/s excess speed has left the near-Earth region by then (2.6e8 m,
 * about 40 Earth radii at the scene's exaggeration), which is what makes the post-burn leg
 * visible as an escape rather than as a kink. Longer would draw a tail the envelope clips
 * anyway, at the cost of sampling density everywhere else.
 */
export const DEPARTURE_COAST_SECONDS = SECONDS_PER_DAY;

/**
 * Longest horizon a departure is allowed to extend a plan to, days.
 *
 * A porkchop window can be eleven years wide, and a node at the far end of it would ask for a
 * 4000-day propagation of a 96-minute orbit: correct in principle, a wall of aliased dots on
 * screen, and unbounded work in N-body mode. Four years covers every Earth-Mars window
 * (780 days) and the Venus synodic period three times over.
 */
export const MAX_DEPARTURE_HORIZON_DAYS = 1500;

export type DepartureApplyResult =
  | { readonly ok: true; readonly craft: CraftSpec; readonly horizonSeconds: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Adds a planned departure to a mission, extending the plan to cover it.
 *
 * A node past the horizon is not flown: `propagateTrajectory` drops burns after `horizonSeconds`
 * and the panel would then list a burn the trajectory never makes. So the plan is extended
 * instead, and by how much is reported rather than hidden.
 *
 * The N-body case is refused rather than extended. Integrating months of trajectory at
 * millisecond tolerances is far outside an interactive budget, and a plan that takes a minute
 * to appear is worse than a sentence saying why it will not.
 */
export function applyDepartureNode(craft: CraftSpec, node: TransferNode): DepartureApplyResult {
  const burnSeconds = node.maneuver.timeSeconds;
  if (!Number.isFinite(burnSeconds) || burnSeconds < 0) {
    return { ok: false, reason: 'That departure does not produce a usable node time.' };
  }

  if (burnSeconds <= craft.horizonSeconds) {
    return {
      ok: true,
      craft: withManeuver(craft, node.maneuver),
      horizonSeconds: craft.horizonSeconds,
    };
  }

  const wanted = burnSeconds + DEPARTURE_COAST_SECONDS;
  if (craft.propagation === 'nbody') {
    return {
      ok: false,
      reason:
        'That window is past this mission’s horizon, and extending an N-body plan that far ' +
        'is not interactive. Plan the departure on a two-body mission, or pick a nearer window.',
    };
  }
  if (wanted > MAX_DEPARTURE_HORIZON_DAYS * SECONDS_PER_DAY) {
    return {
      ok: false,
      reason:
        `That window is ${(wanted / SECONDS_PER_DAY).toFixed(0)} days out, past the ` +
        `${MAX_DEPARTURE_HORIZON_DAYS}-day limit a plan is extended to. Pick a nearer window.`,
    };
  }

  return {
    ok: true,
    craft: { ...withManeuver(craft, node.maneuver), horizonSeconds: wanted },
    horizonSeconds: wanted,
  };
}

/**
 * Wraps an angle into `[0, 2pi)`.
 *
 * The wait for a burn phase is a *forward* difference around a circle, so a negative
 * difference must become "a whole orbit minus that", not "a negative wait".
 */
function wrapTo2Pi(angle: number): number {
  const twoPi = 2 * Math.PI;
  const wrapped = angle % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
}
