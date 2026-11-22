// In-browser numeric self-check of the glass shader against glassModel.js.
// Usage (devtools or automation): const r = await (await import('/viewer/selfcheck.js')).runGlassSelfCheck(window.__holo.scene);
// Lights ONE screen at a time (room, glare, rim and glass edges off), reads the canvas back and compares
//   * head-on brightness of every display with the model's transmittance,
//   * at 30 deg: the width of the lit square (cos law), the sideways shift of its unclipped edge between displays
//     (Snell refraction through the slabs) and the brightness (longer glass path + Fresnel).
// It leaves the scene altered (textures frozen): reload the page afterwards.
import { buildStack, trace } from '/viewer/glassModel.js';

export async function runGlassSelfCheck(sc) {
  const checks = [];
  const check = (name, measured, expected, tol, unit = '') => {
    checks.push({ name, measured: +measured.toFixed(4), expected: +expected.toFixed(4), tol, ok: Math.abs(measured - expected) <= tol, unit });
  };
  sc.update = () => {};                                   // stop the running sketch from overwriting the test textures
  sc.setMode('glass');
  if (!sc.ortho) sc.setOrtho(true);
  sc.setGlassParams({ roomBrightness: 0, roomLight: 0 });
  sc.glass.u.uSideRays.value = 0;                         // only rays entering through the front face
  sc.glass.u.uRim.value = 0;
  sc.glass.u.uGain.value = 1.0;
  const params = sc.glass.params;
  const stack = buildStack(params, sc.layerPitch);

  const cv = sc.canvas;
  const off = document.createElement('canvas');
  const ctx = off.getContext('2d', { willReadFrequently: true });
  const grab = () => { sc.render(); off.width = cv.width; off.height = cv.height; ctx.drawImage(cv, 0, 0); return ctx.getImageData(0, 0, off.width, off.height); };
  const lightOnly = (k) => { sc.arrData.fill(0); sc.arrData.fill(170, k * 16384, (k + 1) * 16384); sc.arrTex.needsUpdate = true; };
  const camera = (deg, zoom) => {
    const R = 120, t = (deg * Math.PI) / 180;
    sc.cam.position.set(Math.sin(t) * R, 0, -Math.cos(t) * R);   // viewer on the display-1 side
    sc.controls.target.set(0, 0, 0); sc.cam.up.set(0, 1, 0); sc.cam.lookAt(0, 0, 0);
    sc.orthoCam.zoom = zoom; sc.orthoCam.updateProjectionMatrix(); sc.controls.update();
  };
  const radiance = (b) => -Math.log(1 - Math.pow(b / 255, 2.2)) / 1.25;   // undo tonemap + gamma (blue channel, never clips)
  const px = (im, x, y) => im.data[(y * im.width + x) * 4 + 2];

  // 1) head-on
  camera(0, 0.3);
  const e = [];
  for (let k = 0; k < 8; k++) { lightOnly(k); const im = grab(); e.push(radiance(px(im, im.width >> 1, im.height >> 1))); }
  const m0 = trace(stack, 1, 0);
  for (const k of [1, 3, 5, 7]) check(`head-on display ${k + 1} / display 1`, e[k] / e[0], m0.emission[k].A / m0.emission[0].A, 0.012);

  // 2) 30 degrees off axis
  const th = 30, sinA = Math.sin((th * Math.PI) / 180), cosT = Math.cos((th * Math.PI) / 180);
  const m30 = trace(stack, 1, sinA);
  camera(th, 0.3);
  const pxPerMm = cv.height / ((sc.orthoCam.top - sc.orthoCam.bottom) / sc.orthoCam.zoom);
  const rows = [];
  for (const k of [0, 3, 6]) {
    lightOnly(k);
    const im = grab(), y = im.height >> 1;
    let mx = 0; for (let x = 0; x < im.width; x++) mx = Math.max(mx, px(im, x, y));
    // the lit square = the FIRST contiguous run. Beyond it the polished plate edge totally internally reflects shallow rays,
    // which shows a second, mirrored copy of the lit screen: real physics, but not what we are measuring here.
    let lo = -1, hi = -1;
    for (let x = 0; x < im.width; x++) if (px(im, x, y) > mx * 0.5) { lo = x; break; }
    hi = lo; while (hi + 1 < im.width && px(im, hi + 1, y) > mx * 0.5) hi++;
    rows.push({ k, width: (hi - lo) / pxPerMm, hiMm: (hi - im.width / 2) / pxPerMm, e: radiance(px(im, hi - Math.round(3 * pxPerMm), y)) });
  }
  check('30 deg: lit width of display 1 = 20.14 mm * cos(theta)', rows[0].width, 20.14 * cosT, 0.25, 'mm');
  // the right edge is the unclipped one (the left edge of deeper screens is cut off by the plate edge)
  for (const [i, k] of [[1, 3], [2, 6]])
    check(`30 deg: sideways shift of display ${k + 1} vs display 1 (refraction)`, rows[i].hiMm - rows[0].hiMm,
      -(m30.emission[k].lateral - m30.emission[0].lateral) * cosT, 0.2, 'mm');
  check('30 deg: brightness display 7 / display 1', rows[2].e / rows[0].e, m30.emission[6].A / m30.emission[0].A, 0.02);
  check('30 deg: brightness display 4 / display 1', rows[1].e / rows[0].e, m30.emission[3].A / m30.emission[0].A, 0.02);
  // deep screens lose their far edge to the plate boundary: width shrinks, matching the geometry
  const clipped = 24 / 2 - (-(m30.emission[6].lateral) * 1) ;   // informational only
  void clipped;
  return { ok: checks.every((c) => c.ok), checks, pxPerMm: +pxPerMm.toFixed(2) };
}
