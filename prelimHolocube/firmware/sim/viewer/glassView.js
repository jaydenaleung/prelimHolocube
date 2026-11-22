// Glass-stack view: the stack is a solid box of 18 parallel slabs and every camera ray that hits the box is traced
// THROUGH it in 3D (see glassModel.js for the same physics in plain JS):
//   * the ray refracts (Snell) when it enters, at every slab interface and when it leaves; where light inside would
//     hit an interface beyond the critical angle it is totally internally reflected and stays trapped in the plates
//   * it is dimmed along its true path length, T^(path / thickness) per slab, so a ray crossing a screen sideways
//     loses far more than one crossing it face-on (screens are 85 % per 1 mm): that is why the dots are hard to see
//     through the edge but still there
//   * whenever it crosses a screen's emission plane it picks up the light point under it, already dimmed by everything
//     between that dot and the eye. The dots therefore live in real 3D positions, on each screen, and can be seen
//     through the front, the back and the edges
//   * leaving the box it continues to the walls of a lit room, dimmed by what it went through
import * as THREE from 'three';
import { GLASS_DEFAULTS, buildStack, packForShader, MAX_SLABS, NUM_SCREENS } from '/viewer/glassModel.js';

const ACTIVE_MM = 20.14;
const PX_MM = ACTIVE_MM / 128;
const ROOM_HALF = 240;        // mm: half-size of the cubic room around the stack (the camera stays inside it)
const EXPOSURE = 1.25;
const MAX_STEPS = 72;

const COMMON = /* glsl */`
precision highp float;
precision highp sampler2DArray;
#define MAXS ${MAX_SLABS}
uniform float uRoom;
uniform float uAmbient;
const float EXPOSURE = ${EXPOSURE.toFixed(2)};
const float ROOM_HALF = ${ROOM_HALF.toFixed(1)};

float fresnelT(float c, float n) {
  c = clamp(c, 1e-4, 1.0);
  float sinT = sqrt(max(0.0, 1.0 - c * c)) / n;
  float cosT = sqrt(1.0 - sinT * sinT);
  float rs = (c - n * cosT) / (c + n * cosT);
  float rp = (n * c - cosT) / (n * c + cosT);
  return 1.0 - 0.5 * (rs * rs + rp * rp);
}

// the "room": a lit cubic room with a 5 mm / 25 mm grid on every wall, so refraction (shift) and darkening can be
// judged by eye. N = outward wall normal, fp = size of one screen pixel on the wall in mm (to anti-alias the lines).
vec3 backdrop(vec3 P, vec3 N, float fp) {
  vec3 a = abs(N);
  vec2 uv = a.x > 0.5 ? P.zy : (a.y > 0.5 ? P.xz : P.xy);
  float shade = a.y > 0.5 ? (N.y > 0.0 ? 0.35 : 0.85) : mix(0.55, 1.0, smoothstep(-ROOM_HALF, ROOM_HALF, P.y));
  float base = uRoom * shade;
  vec2 g = uv / 5.0;
  vec2 f = abs(fract(g + 0.5) - 0.5) / max(fp / 5.0, 1e-4);
  float line = 1.0 - clamp(min(f.x, f.y), 0.0, 1.0);
  vec2 g2 = uv / 25.0;
  vec2 f2 = abs(fract(g2 + 0.5) - 0.5) / max(fp / 25.0, 1e-4);
  float major = 1.0 - clamp(min(f2.x, f2.y), 0.0, 1.0);
  vec3 col = vec3(base) * vec3(0.90, 0.95, 1.0);
  col += uRoom * (0.16 * line + 0.40 * major) * vec3(0.8, 0.9, 1.0);
  return col;
}
// radiance (linear light) -> soft-clipped, gamma-encoded display value
vec3 tonemap(vec3 c) { return pow(1.0 - exp(-max(c, 0.0) * EXPOSURE), vec3(1.0 / 2.2)); }
`;

const VERT = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const BACKDROP_FRAG = /* glsl */`${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 fw = fwidth(vWorld);
  gl_FragColor = vec4(tonemap(backdrop(vWorld, normalize(vNormal), max(fw.x, max(fw.y, fw.z)))), 1.0);
}`;

const BOX_FRAG = /* glsl */`${COMMON}
#define MAXIT ${MAX_STEPS}
uniform sampler2DArray uTex;
uniform int uCount;
uniform float uT[MAXS];     // slab thickness (mm)
uniform float uN[MAXS];     // refractive index
uniform float uTr[MAXS];    // transmittance of the slab for a straight path through its thickness
uniform float uKind[MAXS];  // 0 glass, 1 screen, 2 acrylic
uniform float uScr[MAXS];   // screen index for kind 1
uniform float uZ0[MAXS];
uniform float uZ1[MAXS];
uniform float uOrtho;
uniform vec3 uFwd;
uniform float uGain, uPx, uActHalf, uSlabHalf, uRim, uSideRays;
uniform float uLayerOn[${NUM_SCREENS}];
uniform vec3 uColor;
varying vec3 vWorld;
varying vec3 vNormal;

// light of one screen's dot pattern at position pxy (mm) on its emission plane
vec3 screenLight(int layer, vec2 pxy, float cellPx) {
  vec2 g = vec2(pxy.x / uPx + 64.0, 64.0 - pxy.y / uPx);
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float I = textureLod(uTex, vec3((cell + 0.5) / 128.0, float(layer)), 0.0).r * 1.5;
  float lod = clamp(log2(2.2 / cellPx), 0.0, 7.0);
  float avg = textureLod(uTex, vec3(g / 128.0, float(layer)), lod).r * 1.5;
  float d2 = dot(f, f);
  float dotShape = exp(-d2 * 16.0) + 0.22 * exp(-d2 * 3.5);
  float v = mix(I * dotShape, avg * 0.36, smoothstep(3.5, 1.6, cellPx));
  float inside = step(0.0, g.x) * step(g.x, 128.0) * step(0.0, g.y) * step(g.y, 128.0);
  float edge = max(abs(pxy.x), abs(pxy.y)) - uActHalf;     // faint outline of the screen's active area
  return uColor * v * uGain * inside * uLayerOn[layer] + vec3(0.30, 0.45, 0.60) * 0.060 * smoothstep(0.07, 0.0, abs(edge));
}

void main() {
  vec3 P = vWorld;
  vec3 N = normalize(vNormal);                        // outward normal of the face we hit
  vec3 d = uOrtho > 0.5 ? normalize(uFwd) : normalize(P - cameraPosition);
  vec3 fwv = fwidth(P);                               // pixel footprint, taken before any branching
  float fwE = max(fwv.x, max(fwv.y, fwv.z));
  float distE = uOrtho > 0.5 ? 1.0 : length(P - cameraPosition);
  float fpWall = fwE * (uOrtho > 0.5 ? 1.0 : (distE + 150.0) / distE);
  bool isSide = abs(N.z) < 0.5;
  if (isSide && uSideRays < 0.5) discard;             // test hook: ignore rays entering through the edges

  // slab we enter
  int idx = 0;
  if (N.z > 0.5) idx = uCount - 1;
  else if (isSide) {
    for (int i = 0; i < MAXS; i++) {
      if (i >= uCount) break;
      if (P.z >= uZ0[i] - 1e-4 && P.z <= uZ1[i] + 1e-4) idx = i;
    }
  }
  int idx0 = idx;
  float n0 = uN[idx];
  float cosIn = clamp(dot(-d, N), 1e-3, 1.0);
  float A = fresnelT(cosIn, n0) / fresnelT(1.0, n0);   // entry surface (normalised: the quoted T already holds the normal-incidence loss)
  vec3 t = refract(d, N, 1.0 / n0);
  vec3 p = P;
  vec3 emit = vec3(0.0);
  bool exited = false;
  vec3 posOut = P;
  vec3 dirOut = d;
  float H = uSlabHalf;

  for (int it = 0; it < MAXIT; it++) {
    float thk = uT[idx];
    float zb = t.z > 0.0 ? uZ1[idx] : uZ0[idx];
    float dz = abs(t.z) > 1e-5 ? (zb - p.z) / t.z : 1e9;
    float dx = abs(t.x) > 1e-5 ? ((t.x > 0.0 ? H : -H) - p.x) / t.x : 1e9;
    float dy = abs(t.y) > 1e-5 ? ((t.y > 0.0 ? H : -H) - p.y) / t.y : 1e9;
    float s = max(0.0, min(dz, min(dx, dy)));

    // inside a screen: does this segment cross its emission plane (mid-thickness)?
    if (uKind[idx] > 0.5 && uKind[idx] < 1.5 && abs(t.z) > 1e-5) {
      float sc = (0.5 * (uZ0[idx] + uZ1[idx]) - p.z) / t.z;
      if (sc > 0.0 && sc <= s) {
        float Ac = A * pow(uTr[idx], sc / thk);
        float cellPx = uPx / (fwE / max(abs(t.z), 0.1));
        emit += Ac * screenLight(int(uScr[idx] + 0.5), (p + t * sc).xy, cellPx);
      }
    }
    A *= pow(uTr[idx], s / thk);                       // Beer-Lambert along the real path length
    p += t * s;

    if (dz <= dx && dz <= dy) {                        // reached a z interface
      float sg = t.z > 0.0 ? 1.0 : -1.0;
      int nidx = idx + (t.z > 0.0 ? 1 : -1);
      vec3 Nin = vec3(0.0, 0.0, -sg);
      if (nidx < 0 || nidx >= uCount) {                // front / back surface: out into the air, or trapped
        vec3 r = refract(t, Nin, uN[idx]);
        if (dot(r, r) < 0.5) t = reflect(t, Nin);
        else { A *= fresnelT(abs(r.z), uN[idx]) / fresnelT(1.0, uN[idx]); posOut = p; dirOut = normalize(r); exited = true; break; }
      } else {                                         // into the neighbouring slab
        vec3 r = refract(t, Nin, uN[idx] / uN[nidx]);
        if (dot(r, r) < 0.5) t = reflect(t, Nin);
        else { t = normalize(r); idx = nidx; }
      }
    } else {                                           // reached the edge of the plates
      vec3 No = (dx <= dy) ? vec3(t.x > 0.0 ? 1.0 : -1.0, 0.0, 0.0) : vec3(0.0, t.y > 0.0 ? 1.0 : -1.0, 0.0);
      vec3 Nin = -No;
      vec3 r = refract(t, Nin, uN[idx]);
      if (dot(r, r) < 0.5) t = reflect(t, Nin);
      else { A *= fresnelT(abs(dot(r, No)), uN[idx]) / fresnelT(1.0, uN[idx]); posOut = p; dirOut = normalize(r); exited = true; break; }
    }
  }

  vec3 col = emit;
  if (exited) {                                        // continue in the air until the ray hits a wall of the room
    vec3 tw = vec3(1e9);
    if (abs(dirOut.x) > 1e-5) tw.x = ((dirOut.x > 0.0 ? ROOM_HALF : -ROOM_HALF) - posOut.x) / dirOut.x;
    if (abs(dirOut.y) > 1e-5) tw.y = ((dirOut.y > 0.0 ? ROOM_HALF : -ROOM_HALF) - posOut.y) / dirOut.y;
    if (abs(dirOut.z) > 1e-5) tw.z = ((dirOut.z > 0.0 ? ROOM_HALF : -ROOM_HALF) - posOut.z) / dirOut.z;
    float tmin = min(tw.x, min(tw.y, tw.z));
    vec3 Nw = tmin == tw.x ? vec3(sign(dirOut.x), 0.0, 0.0) : (tmin == tw.y ? vec3(0.0, sign(dirOut.y), 0.0) : vec3(0.0, 0.0, sign(dirOut.z)));
    col += A * backdrop(posOut + dirOut * tmin, Nw, fpWall);
  }

  // surface look: veiling glare, a window mirrored in the glass, bright polished edges and interface lines
  vec3 r = reflect(d, N);
  float R = 1.0 - fresnelT(cosIn, n0);
  float win = smoothstep(0.90, 0.985, dot(r, normalize(vec3(0.5, 0.55, -0.7))));
  col += vec3(0.95, 0.98, 1.0) * uAmbient * R * (mix(0.25, 1.0, r.y * 0.5 + 0.5) + 14.0 * win);
  if (!isSide) {
    float rim = smoothstep(uSlabHalf - 0.35, uSlabHalf, max(abs(P.x), abs(P.y)));
    col += uRim * rim * vec3(0.22, 0.42, 0.40) * (0.15 + uRoom);
  } else {
    float dzE = min(abs(P.z - uZ0[idx0]), abs(P.z - uZ1[idx0]));
    col += uRim * smoothstep(0.05, 0.0, dzE) * vec3(0.30, 0.45, 0.45) * (0.25 + uRoom);
    col += uRim * vec3(0.012, 0.03, 0.026) * (0.4 + uRoom);                 // faint scatter from the polished edge
  }
  gl_FragColor = vec4(tonemap(col), 1.0);
}`;

export class GlassView {
  constructor({ texture, layerPitch = 2.5, params = GLASS_DEFAULTS }) {
    this.group = new THREE.Group();
    this.params = { ...params };
    this.pitch = layerPitch;
    const shared = {
      uTex: { value: texture },
      uCount: { value: 0 },
      uT: { value: [] }, uN: { value: [] }, uTr: { value: [] }, uKind: { value: [] }, uScr: { value: [] },
      uZ0: { value: [] }, uZ1: { value: [] },
      uOrtho: { value: 0 }, uFwd: { value: new THREE.Vector3(0, 0, 1) },
      uGain: { value: 1.2 }, uPx: { value: PX_MM }, uActHalf: { value: ACTIVE_MM / 2 }, uSlabHalf: { value: 12 },
      uLayerOn: { value: new Array(NUM_SCREENS).fill(1) },
      uColor: { value: new THREE.Color(0.80, 0.93, 1.0) },
      uRoom: { value: params.roomBrightness }, uAmbient: { value: params.roomLight },
      uRim: { value: 1 },            // 0 disables the edge highlights (numeric self-check)
      uSideRays: { value: 1 },       // 0 ignores rays entering through the edges (numeric self-check)
    };
    this.u = shared;
    this.box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.ShaderMaterial({
      uniforms: shared, vertexShader: VERT, fragmentShader: BOX_FRAG, depthWrite: true, side: THREE.FrontSide,
    }));
    this.room = new THREE.Mesh(new THREE.BoxGeometry(2 * ROOM_HALF, 2 * ROOM_HALF, 2 * ROOM_HALF), new THREE.ShaderMaterial({
      uniforms: shared, vertexShader: VERT, fragmentShader: BACKDROP_FRAG, side: THREE.BackSide, depthWrite: false }));
    this.room.renderOrder = -10;
    this.group.add(this.room, this.box);
    this.setParams(this.params, layerPitch);
  }

  setParams(p, pitch = this.pitch) {
    this.params = { ...GLASS_DEFAULTS, ...p };
    this.pitch = pitch;
    this.stack = buildStack(this.params, pitch);
    const pk = packForShader(this.stack);
    const u = this.u;
    u.uCount.value = pk.count;
    u.uT.value = pk.t; u.uN.value = pk.n; u.uTr.value = pk.T; u.uKind.value = pk.kind; u.uScr.value = pk.screen;
    u.uZ0.value = pk.z0; u.uZ1.value = pk.z1;
    u.uSlabHalf.value = this.params.slabSize / 2;
    u.uRoom.value = this.params.roomBrightness; u.uAmbient.value = this.params.roomLight;
    this._layoutGeometry();
  }

  _layoutGeometry() {
    const { zFront, zBack } = this.stack;
    const S = this.params.slabSize;
    this.box.geometry.dispose();
    this.box.geometry = new THREE.BoxGeometry(S, S, zBack - zFront);
    this.box.position.set(0, 0, (zFront + zBack) / 2);
  }

  setLayerOn(k, on) { if (k < NUM_SCREENS) this.u.uLayerOn.value[k] = on ? 1 : 0; }
  setGain(g) { this.u.uGain.value = g; }

  /** Call every frame before rendering. */
  update(camera, ortho) {
    this.u.uOrtho.value = ortho ? 1 : 0;
    camera.getWorldDirection(this.u.uFwd.value);
  }

  dispose() { this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
}
