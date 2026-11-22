// Physical model of the glass stack, kept free of any WebGL so it can be unit-tested and so the shader and the
// numeric readouts share one definition.
//
// Stack, front (display-1 side, -z) to back (display-7 side, +z):
//   glass, glass, SCREEN 1, acrylic, SCREEN 2, ..., acrylic, SCREEN 7, acrylic, SCREEN 8 (unlit), glass
// = 2 + 8 + 7 + 1 = 18 slabs. The slab "transparency" numbers are treated as the TOTAL normal-incidence
// transmittance of one element (absorption + its own surface reflections), exactly as quoted.
//
// Everything marked ASSUMED is a guess because the brief did not give a value; all of them are editable in the UI.

export const MID = 3;               // display 4 (layer index 3) sits at z = 0
export const NUM_SCREENS = 8;       // 7 driven + 1 spare, unlit
export const MAX_SLABS = 24;

export const GLASS_DEFAULTS = {
  screenT: 0.85,        // given: each screen passes 85 % of the light
  acrylicT: 0.95,       // given: each acrylic spacer passes 95 %
  glassT: 0.92,         // ASSUMED: plain cover glass, typical clear float glass incl. its two surface reflections
  screenThk: 1.0,       // given: mm, thickness of one transparent PMOLED screen
  glassThk: 1.5,        // given: mm, each cover glass sheet
  nScreen: 1.52,        // soda-lime / borosilicate glass
  nAcrylic: 1.49,       // PMMA
  nGlass: 1.52,
  frontGlass: 2,        // given
  backGlass: 1,         // given
  slabSize: 24,         // ASSUMED: mm, lateral size of the glass plates (the active area is 20.14 mm)
  roomBrightness: 0.15, // radiance of the wall / room behind the stack (0 = pitch-dark room), viewer-side independent
  roomLight: 0.40,      // how much room light reflects off the front glass surface (veiling glare)
};

/** Build the ordered slab list (ascending z = front side first). Screens are centred on their emission plane. */
export function buildStack(p = GLASS_DEFAULTS, pitch = 2.5) {
  const st = Math.min(p.screenThk, Math.max(0.05, pitch - 0.05));
  const acT = Math.max(0.05, pitch - st);
  const slabs = [];
  let z = (0 - MID) * pitch - st / 2 - p.frontGlass * p.glassThk;
  const add = (kind, t, n, T, screen = -1) => { slabs.push({ kind, z0: z, z1: z + t, t, n, T, screen }); z += t; };
  for (let i = 0; i < p.frontGlass; i++) add('glass', p.glassThk, p.nGlass, p.glassT);
  for (let k = 0; k < NUM_SCREENS; k++) {
    add('screen', st, p.nScreen, p.screenT, k);
    if (k < NUM_SCREENS - 1) add('acrylic', acT, p.nAcrylic, p.acrylicT);
  }
  for (let i = 0; i < p.backGlass; i++) add('glass', p.glassThk, p.nGlass, p.glassT);
  return { slabs, zFront: slabs[0].z0, zBack: slabs[slabs.length - 1].z1,
    screenZ: slabs.filter((s) => s.kind === 'screen').map((s) => (s.z0 + s.z1) / 2), screenThk: st, acrylicThk: acT };
}

/** Unpolarised power transmittance of an air -> medium(n) interface at incidence cosine cosI. */
export function fresnelT(cosI, n) {
  cosI = Math.min(1, Math.max(1e-6, cosI));
  const sinT = Math.sqrt(Math.max(0, 1 - cosI * cosI)) / n;
  const cosT = Math.sqrt(1 - sinT * sinT);
  const rs = (cosI - n * cosT) / (cosI + n * cosT);
  const rp = (n * cosI - cosT) / (n * cosI + cosT);
  return 1 - 0.5 * (rs * rs + rp * rp);
}

/**
 * Trace one ray through the planar stack.
 * @param {{slabs:Array}} stack
 * @param {1|-1} side   +1: viewer on the front (display-1) side, ray travels toward +z; -1: viewer behind.
 * @param {number} sinAir sine of the ray's angle from the stack normal in air (0 = straight on)
 * @returns {{emission:Array<{screen:number, A:number, lateral:number, depth:number}>, A:number, lateral:number}}
 *   emission[k]: fraction of a dot's light that reaches the viewer (A), how far the ray has moved sideways by the
 *   time it reaches that dot (lateral, mm along the ray's azimuth) and the true depth below the entry face (mm).
 *   A = transmittance of the whole stack for the room behind it.
 */
export function trace(stack, side, sinAir) {
  const order = side > 0 ? stack.slabs : stack.slabs.slice().reverse();
  const cos0 = Math.sqrt(Math.max(0, 1 - sinAir * sinAir));
  const entryN = order[0].n, exitN = order[order.length - 1].n;
  let A = fresnelT(cos0, entryN) / fresnelT(1, entryN);
  let lateral = 0, depth = 0;
  const emission = [];
  for (const s of order) {
    const sinI = sinAir / s.n, cosI = Math.sqrt(1 - sinI * sinI), tanI = sinI / cosI;
    if (s.kind === 'screen') {
      emission[s.screen] = { screen: s.screen, A: A * Math.pow(s.T, 0.5 / cosI), lateral: lateral + 0.5 * s.t * tanI, depth: depth + s.t / 2 };
    }
    A *= Math.pow(s.T, 1 / cosI);          // Beer-Lambert: oblique rays travel t/cos(theta) through the slab
    lateral += s.t * tanI;
    depth += s.t;
  }
  A *= fresnelT(cos0, exitN) / fresnelT(1, exitN);
  return { emission, A, lateral, depth };
}

/**
 * Apparent depth of a dot as judged by the viewer (where the straight line along the ray entering the eye meets
 * the dot's lateral position). Paraxial limit = sum(t / n): the stack looks thinner than it is.
 */
export function apparentDepth(stack, side, screen, sinAir) {
  if (sinAir < 1e-6) {
    const order = side > 0 ? stack.slabs : stack.slabs.slice().reverse();
    let d = 0;
    for (const s of order) {
      if (s.kind === 'screen' && s.screen === screen) return d + s.t / (2 * s.n);
      d += s.t / s.n;
    }
  }
  const e = trace(stack, side, sinAir).emission[screen];
  const tan0 = sinAir / Math.sqrt(1 - sinAir * sinAir);
  return e.lateral / tan0;
}

/** True geometric depth of a screen's emission plane below the entry face on the given viewing side. */
export function trueDepth(stack, side, screen) {
  return trace(stack, side, 0).emission[screen].depth;
}

/** Rows for the UI table + headline numbers. thetaDeg = off-axis viewing angle in air. */
export function summary(p = GLASS_DEFAULTS, pitch = 2.5, side = 1, thetaDeg = 0) {
  const stack = buildStack(p, pitch);
  const on = trace(stack, side, 0);
  const off = trace(stack, side, Math.sin((thetaDeg * Math.PI) / 180));
  const rows = [];
  for (let k = 0; k < NUM_SCREENS; k++) {
    rows.push({ screen: k, onAxis: on.emission[k].A, offAxis: off.emission[k].A,
      apparent: apparentDepth(stack, side, k, 0), depth: trueDepth(stack, side, k) });
  }
  return { rows, background: on.A, backgroundOff: off.A, stack };
}

/** Pack the stack for the shader's uniform arrays. */
export function packForShader(stack) {
  const n = stack.slabs.length;
  const arr = (f) => { const a = new Array(MAX_SLABS).fill(0); stack.slabs.forEach((s, i) => { a[i] = f(s); }); return a; };
  return {
    count: n, t: arr((s) => s.t), n: arr((s) => s.n), T: arr((s) => s.T),
    kind: arr((s) => (s.kind === 'screen' ? 1 : s.kind === 'acrylic' ? 2 : 0)), screen: arr((s) => s.screen),
    z0: arr((s) => s.z0), z1: arr((s) => s.z1),
  };
}
