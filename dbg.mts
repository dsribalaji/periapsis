import { advanceElements, centuriesFromJd, positionFromElements, relativeVelocity, meanMotionFromElementRates } from "./src/core/ephemeris/ephemeris.ts";
import { JPL_TABLE_1 } from "./src/core/ephemeris/solarSystem.ts";
import { SECONDS_PER_DAY } from "./src/core/constants.ts";
import { jdFromIsoUtc } from "./src/core/time/time.ts";
const jd = jdFromIsoUtc("2026-11-18T00:00:00Z");
const el = JPL_TABLE_1.neptune;
const cur = advanceElements(el, centuriesFromJd(jd));
const v = relativeVelocity(el, jd);
console.log("|v| analytic:", Math.hypot(v.x,v.y,v.z).toFixed(3));
for (const h of [1, 10, 60, 600]) {
  const pP = positionFromElements(advanceElements(el, centuriesFromJd(jd + h/SECONDS_PER_DAY)));
  const pM = positionFromElements(advanceElements(el, centuriesFromJd(jd - h/SECONDS_PER_DAY)));
  const fd = Math.hypot(pP.x-pM.x, pP.y-pM.y, pP.z-pM.z)/(2*h);
  console.log(`h=${h}s  |v| fd = ${fd.toFixed(3)}  relerr=${((Math.hypot(v.x,v.y,v.z)-fd)/fd).toExponential(2)}`);
}
// Now: hold elements fixed, advance ONLY M
const n = meanMotionFromElementRates(el);
console.log("\nHolding elements fixed, varying only M:");
for (const h of [1, 10, 60]) {
  const pP = positionFromElements({...cur, meanAnomaly: cur.meanAnomaly + n*h});
  const pM = positionFromElements({...cur, meanAnomaly: cur.meanAnomaly - n*h});
  const fd = Math.hypot(pP.x-pM.x, pP.y-pM.y, pP.z-pM.z)/(2*h);
  console.log(`h=${h}s  |v| fd = ${fd.toFixed(3)}  relerr=${((Math.hypot(v.x,v.y,v.z)-fd)/fd).toExponential(2)}`);
}
