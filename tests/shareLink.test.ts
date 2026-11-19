import { describe, expect, it } from 'vitest';
import { encodeShareLink, parseShareLink, type ShareState } from '../src/ui/shareLink.js';

const state: ShareState = {
  scenarioId: 'inner-system',
  timeUtc: '2029-04-13T21:46:00Z',
  selected: 'apophis',
  warp: 1000,
  radialMode: 'linear',
  camera: { azimuthRad: 0.6, elevationRad: 1.05, distanceUnits: 0.0523456, follow: 'earth' },
};

describe('share links', () => {
  it('round-trips every field', () => {
    const back = parseShareLink(`#${encodeShareLink(state)}`);
    expect(back).toEqual({
      ...state,
      // Distance is kept to five significant figures; that is a 1e-5 framing change.
      camera: { ...state.camera, distanceUnits: 0.052346 },
    });
  });

  it('keeps a Sun-centred camera as follow = null', () => {
    const back = parseShareLink(
      encodeShareLink({ ...state, camera: { ...state.camera, follow: null } }),
    );
    expect(back?.camera?.follow).toBeNull();
  });

  it('is not a share link without the version marker', () => {
    expect(parseShareLink('')).toBeNull();
    expect(parseShareLink('#section-2')).toBeNull();
    expect(parseShareLink('#v=99&s=inner-system')).toBeNull();
  });

  it('drops malformed fields instead of throwing', () => {
    const back = parseShareLink(
      '#v=1&s=Inner%20System!&t=yesterday&sel=<script>&w=12345&m=sideways&cam=1,2',
    );
    expect(back).toEqual({});
  });

  it('refuses a camera that is behind itself or looking straight down past the pole', () => {
    expect(parseShareLink('#v=1&cam=0,0,-5')?.camera).toBeUndefined();
    expect(parseShareLink('#v=1&cam=0,2,5')?.camera).toBeUndefined();
    expect(parseShareLink('#v=1&cam=0,NaN,5')?.camera).toBeUndefined();
  });

  it('keeps the valid half of a half-valid link', () => {
    const back = parseShareLink('#v=1&s=leo-raise&t=garbage&w=100');
    expect(back).toEqual({ scenarioId: 'leo-raise', warp: 100 });
  });
});
