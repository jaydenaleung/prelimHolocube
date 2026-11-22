import test from 'node:test';
import assert from 'node:assert/strict';
import { GLASS_DEFAULTS as D, buildStack, trace, fresnelT, apparentDepth, trueDepth, summary, packForShader, NUM_SCREENS } from '../viewer/glassModel.js';

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);

test('stack composition: 2 glass, 8 screens, 7 acrylic between them, 1 glass at the back (18 slabs)', () => {
  const { slabs } = buildStack(D, 2.5);
  assert.equal(slabs.length, 18);
  assert.equal(slabs.map((s) => s.kind[0]).join(''), 'ggsasasasasasasasg', 'order front to back');
  assert.equal(slabs.filter((s) => s.kind === 'screen').length, NUM_SCREENS);
  assert.equal(slabs.filter((s) => s.kind === 'acrylic').length, 7, 'acrylic between every pair of screens, none on the outer sides');
  assert.equal(slabs.filter((s) => s.kind === 'glass').length, 3, 'two in front, one behind');
  assert.deepEqual([slabs[0].kind, slabs[1].kind, slabs[2].kind], ['glass', 'glass', 'screen']);
  assert.equal(slabs.at(-1).kind, 'glass');
  assert.equal(slabs.at(-2).kind, 'screen', 'the unlit 8th screen is directly in front of the back glass');
});

test('slabs are contiguous and the screen emission planes sit exactly one layer pitch apart, display 4 at z = 0', () => {
  for (const pitch of [2.5, 3.0, 1.8]) {
    const st = buildStack(D, pitch);
    for (let i = 1; i < st.slabs.length; i++) close(st.slabs[i].z0, st.slabs[i - 1].z1, 1e-9, 'contiguous');
    st.screenZ.forEach((z, k) => close(z, (k - 3) * pitch, 1e-9, `screen ${k + 1} plane at pitch ${pitch}`));
  }
});

test('on-axis transmittance is the plain product of the quoted numbers', () => {
  const st = buildStack(D, 2.5);
  const r = trace(st, 1, 0);
  close(r.A, 0.92 ** 3 * 0.85 ** 8 * 0.95 ** 7, 1e-12);
  close(r.A, 0.1479, 5e-4);                                    // ~14.8 % of the room behind survives the whole stack
  // dot on screen k (0-based) seen from the front: 2 cover glasses, k screens, k acrylics, half of its own screen
  for (let k = 0; k < 8; k++) close(r.emission[k].A, 0.92 ** 2 * (0.85 * 0.95) ** k * 0.85 ** 0.5, 1e-12, `screen ${k + 1}`);
  // seen from the back the order reverses: only the back glass, the unlit screen 8 etc. are in the way
  const b = trace(st, -1, 0);
  close(b.emission[7].A, 0.92 * 0.85 ** 0.5, 1e-12);
  close(b.emission[0].A, 0.92 * (0.85 * 0.95) ** 7 * 0.85 ** 0.5, 1e-12, 'screen 1 from behind: back glass, 7 screens, 7 acrylics, half its own');
  close(b.A, r.A, 1e-12, 'whole-stack transmittance does not depend on the viewing side');
});

test('the deepest screens are the dimmest: compounding transparency, quantified', () => {
  const s = summary(D, 2.5, 1, 0);
  for (let k = 1; k < 8; k++) assert.ok(s.rows[k].onAxis < s.rows[k - 1].onAxis);
  assert.ok(s.rows[6].onAxis / s.rows[0].onAxis < 0.30, 'display 7 shows < 30 % of display 1 brightness from the front');
  assert.ok(s.rows[6].onAxis > s.background, 'a lit dot on display 7 is still brighter than the room seen through the stack');
});

test('refraction: slab interfaces obey Snell\'s law (sin(theta) * n is conserved)', () => {
  const st = buildStack(D, 2.5);
  const sinAir = Math.sin((50 * Math.PI) / 180);
  const r = trace(st, 1, sinAir);
  // lateral shift accumulated over the first glass sheet: t * tan(theta_glass), theta_glass = asin(sinAir / n)
  const g = st.slabs[0];
  const tg = Math.asin(sinAir / g.n);
  const firstScreen = r.emission[0];
  const expected = 2 * g.t * Math.tan(tg) + 0.5 * st.screenThk * Math.tan(Math.asin(sinAir / D.nScreen));
  close(firstScreen.lateral, expected, 1e-9);
  assert.ok(tg < (50 * Math.PI) / 180, 'light bends toward the normal inside glass');
});

test('the stack looks thinner than it is: apparent depth is the true depth divided by ~n (paraxial)', () => {
  const st = buildStack(D, 2.5);
  const side = 1;
  for (const k of [0, 3, 6]) {
    const real = trueDepth(st, side, k), app = apparentDepth(st, side, k, 0);
    assert.ok(app < real);
    assert.ok(real / app > 1.45 && real / app < 1.53, `compression ${real / app}`);
    close(apparentDepth(st, side, k, 1e-4), app, 1e-3, 'continuous with the paraxial limit');
  }
  // spacing between layers as seen: 2.5 mm real, ~1.65 mm apparent
  const spacing = apparentDepth(st, 1, 4, 0) - apparentDepth(st, 1, 3, 0);
  close(spacing, 1.0 / 1.52 + 1.5 / 1.49, 1e-9);
  assert.ok(spacing < 2.5 * 0.7);
});

test('oblique viewing dims everything: longer glass path + Fresnel loss, monotonic with angle', () => {
  const st = buildStack(D, 2.5);
  let prev = Infinity;
  for (const deg of [0, 20, 40, 60, 75, 85]) {
    const r = trace(st, 1, Math.sin((deg * Math.PI) / 180));
    assert.ok(r.A < prev, `${deg} deg`);
    assert.ok(r.emission[6].A < r.emission[0].A);
    prev = r.A;
  }
  const a0 = trace(st, 1, 0).A, a60 = trace(st, 1, Math.sin(Math.PI / 3)).A;
  assert.ok(a60 / a0 < 0.9, 'at 60 deg the stack is noticeably darker than head-on');
});

test('Fresnel: ~92 % through one air/glass surface at normal incidence, collapsing toward grazing', () => {
  close(fresnelT(1, 1.52), 1 - ((1.52 - 1) / (1.52 + 1)) ** 2, 1e-12);
  close(fresnelT(1, 1.52), 0.9574, 5e-4);
  assert.ok(fresnelT(Math.cos((85 * Math.PI) / 180), 1.52) < 0.45);
});

test('changing the layer pitch changes the acrylic thickness, not the screens', () => {
  const a = buildStack(D, 2.5), b = buildStack(D, 3.5);
  close(a.acrylicThk, 1.5, 1e-12); close(b.acrylicThk, 2.5, 1e-12);
  assert.equal(a.screenThk, b.screenThk);
});

test('shader packing matches the stack', () => {
  const st = buildStack(D, 2.5), pk = packForShader(st);
  assert.equal(pk.count, 18);
  assert.equal(pk.kind.slice(0, 5).join(), '0,0,1,2,1');
  assert.equal(pk.screen[2], 0); assert.equal(pk.screen[4], 1);
  assert.equal(pk.t.length, 24);
});
