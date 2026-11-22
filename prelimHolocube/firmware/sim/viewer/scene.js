// Three.js viewer: one 128x128 texture per panel, drawn as glowing round dots with additive blending.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { intensityFromState, INTENSITY_MAX, WIDTH, HEIGHT } from '/emulator/sh1107.js';
import { GlassView } from '/viewer/glassView.js';
import { GLASS_DEFAULTS, NUM_SCREENS } from '/viewer/glassModel.js';

export const ACTIVE_MM = 20.14;
export const PX_MM = ACTIVE_MM / 128;
export const MID = 3;

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Dot shader. When a texel gets smaller than ~2 screen pixels the dot pattern would alias, so the shader
// cross-fades to an area-averaged brightness taken from the texture's mip chain.
const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uTex;
uniform float uGain;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 g = vec2(vUv.x, 1.0 - vUv.y) * 128.0;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float cellPx = 1.0 / max(max(fwidth(g.x), fwidth(g.y)), 1e-6);
  vec2 tuv = (cell + 0.5) / 128.0;
  float I = textureLod(uTex, tuv, 0.0).r * ${INTENSITY_MAX.toFixed(2)};
  float d2 = dot(f, f);
  float dotShape = exp(-d2 * 16.0) + 0.22 * exp(-d2 * 3.5);
  float lod = clamp(log2(2.2 / cellPx), 0.0, 7.0);
  float avg = textureLod(uTex, g / 128.0, lod).r * ${INTENSITY_MAX.toFixed(2)};
  float mixAmt = smoothstep(3.5, 1.6, cellPx);
  float v = mix(I * dotShape, avg * 0.36, mixAmt);
  gl_FragColor = vec4(uColor * v * uGain, 1.0);
}`;

function makeLabel(text, color) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(0.45, 0.45, 1);
  return s;
}

export class HoloScene {
  constructor(canvas, { layerPitch = 2.5, numLayers = NUM_SCREENS } = {}) {
    this.canvas = canvas;
    this.layerPitch = layerPitch;
    this.numLayers = numLayers;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x03050a, 1);
    this.scene = new THREE.Scene();
    this.gain = 1.0;
    this.ortho = false;
    this.mode = 'points';          // 'points' = just the light points, 'glass' = ray-traced glass stack
    this.viewSide = 1;             // +1: viewer on the display-1 side (where the two cover glasses are), -1: display-7 side
    this.layers = [];
    this.buffers = [];
    this.dirty = true;
    this.persp = new THREE.PerspectiveCamera(24, 1, 0.5, 2000);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 2000);
    this.cam = this.persp;
    this.orthoHalfH = ACTIVE_MM * 0.62;
    this._buildLayers();
    this._buildGlass();
    this._buildGizmo();
    this.worldAxes = this._buildWorldAxes();
    this.worldAxes.visible = false;
    this.scene.add(this.worldAxes);
    this.controls = null;
    this.setView('front');
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    const loop = () => { this.render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _buildLayers() {
    for (let k = 0; k < this.numLayers; k++) {
      const data = new Uint8Array(WIDTH * HEIGHT);
      const tex = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RedFormat, THREE.UnsignedByteType);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: tex }, uGain: { value: this.gain }, uColor: { value: new THREE.Color(0.80, 0.93, 1.0) } },
        vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(ACTIVE_MM, ACTIVE_MM), mat);
      const half = ACTIVE_MM / 2;
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, y]) => new THREE.Vector3(x, y, 0))),
        new THREE.LineBasicMaterial({ color: 0x2c4e6e, transparent: true, opacity: 0.8, depthTest: false }));
      const group = new THREE.Group();
      group.add(mesh, outline);
      this.scene.add(group);
      this.layers.push({ group, mesh, outline, tex, data, mat, visible: true });
      this.buffers.push(data);
    }
    this.setLayerPitch(this.layerPitch);
  }

  _buildGlass() {
    this.arrData = new Uint8Array(WIDTH * HEIGHT * this.numLayers);
    const tex = new THREE.DataArrayTexture(this.arrData, WIDTH, HEIGHT, this.numLayers);
    tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType;
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true; tex.needsUpdate = true;
    this.arrTex = tex;
    this.glass = new GlassView({ texture: tex, layerPitch: this.layerPitch, params: GLASS_DEFAULTS });
    this.glass.group.visible = false;
    this.scene.add(this.glass.group);
  }

  _buildWorldAxes() {
    const g = new THREE.Group();
    const mk = (dir, col) => {
      const pts = [new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(14)];
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, depthTest: false }));
      g.add(l);
    };
    mk(new THREE.Vector3(1, 0, 0), 0xff5a5a); mk(new THREE.Vector3(0, 1, 0), 0x5aff7a); mk(new THREE.Vector3(0, 0, 1), 0x6a9bff);
    return g;
  }

  _buildGizmo() {
    this.gizmoScene = new THREE.Scene();
    this.gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    const add = (dir, col, label) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]), new THREE.LineBasicMaterial({ color: col }));
      this.gizmoScene.add(l);
      const s = makeLabel(label, '#' + col.toString(16).padStart(6, '0'));
      s.position.copy(dir.clone().multiplyScalar(1.28));
      this.gizmoScene.add(s);
    };
    add(new THREE.Vector3(1, 0, 0), 0xff6b6b, 'x');
    add(new THREE.Vector3(0, 1, 0), 0x6bff8a, 'y');
    add(new THREE.Vector3(0, 0, 1), 0x7aa8ff, 'z');
  }

  setLayerPitch(mm) {
    this.layerPitch = mm;
    this.layers.forEach((L, k) => L.group.position.z = (k - MID) * mm);
    if (this.glass) this.glass.setParams(this.glass.params, mm);
    this.dirty = true;
  }

  /** 'points' = only the light points; 'glass' = the physical glass/acrylic stack with refraction and absorption. */
  setMode(mode) {
    this.mode = mode;
    this.layers.forEach((L) => { L.group.visible = mode === 'points' && L.visible; });
    this.glass.group.visible = mode === 'glass';
    this.arrTex.needsUpdate = true;
    this.setView(this.viewKind || 'front');   // re-frame: the glass plates are larger than the dot area
  }
  setGlassParams(p) { this.glass.setParams({ ...this.glass.params, ...p }, this.layerPitch); }

  /** +1: look from the display-1 side (front, the two cover glasses), -1: from the display-7 side. */
  setViewSide(side) { this.viewSide = side; this.setView(this.viewKind || 'front'); }

  setLayerVisible(k, v) {
    this.layers[k].visible = v;
    this.layers[k].group.visible = v && this.mode === 'points';
    this.glass.setLayerOn(k, v);
    this.dirty = true;
  }
  setOutlines(v) { this.layers.forEach((L) => L.outline.visible = v); }
  setWorldAxes(v) { this.worldAxes.visible = v; }
  setGizmo(v) { this.showGizmo = v; }
  setGain(g) { this.gain = g; this.layers.forEach((L) => L.mat.uniforms.uGain.value = g); this.glass.setGain(g * 1.2); }

  /** Upload a bus snapshot to the textures. */
  update(snap) {
    snap.panels.forEach((p, k) => {
      const L = this.layers[k];
      if (!L) return;
      intensityFromState(p.ram, p.state, L.data);
      L.tex.needsUpdate = true;
      this.arrData.set(L.data, k * WIDTH * HEIGHT);
    });
    if (this.mode === 'glass') this.arrTex.needsUpdate = true;
  }

  resize() {
    const p = this.canvas.parentElement;
    const w = Math.max(10, p.clientWidth), h = Math.max(10, p.clientHeight);
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    this.persp.aspect = this.aspect; this.persp.updateProjectionMatrix();
    this._fitOrtho();
  }

  _fitOrtho() {
    const h = this.orthoHalfH;
    this.orthoCam.left = -h * this.aspect; this.orthoCam.right = h * this.aspect;
    this.orthoCam.top = h; this.orthoCam.bottom = -h;
    this.orthoCam.updateProjectionMatrix();
  }

  /** 'front' = straight along -z from the display-7 side, the way a person looks at the stack. 'orbit' = oblique. */
  setView(kind) {
    this.viewKind = kind;
    // far enough that the nearest layer (the display-7 end, +4 pitches incl. the spare 8th screen) still fits the frame
    const nearZ = (this.numLayers - 1 - MID) * this.layerPitch + (this.mode === 'glass' ? 4 : 0);
    const fit = Math.min(1, this.aspect || 1);
    const span = (this.mode === 'glass' ? this.glass.params.slabSize : ACTIVE_MM) * 1.12;   // glass plates are bigger than the active area
    const dist = nearZ + span / (2 * Math.tan((this.persp.fov * Math.PI) / 360)) / fit;
    this.orthoBase = (kind === 'front' ? 0.62 : 1.0) * (this.mode === 'glass' ? 1.2 : 1);   // orbit view needs more room: the stack is seen at an angle
    const sg = -this.viewSide;   // viewer on the display-1 side sits at -z
    const pos = kind === 'front' ? new THREE.Vector3(0, 0, sg * dist) : new THREE.Vector3(dist * 0.55, dist * 0.32, sg * dist * 0.78).multiplyScalar(1.5);
    this._setCamera(this.ortho, pos);
  }

  setOrtho(on) {
    const pos = this.cam.position.clone();
    this.ortho = on;
    this._setCamera(on, pos, true);
  }

  _setCamera(ortho, pos, keepTarget = false) {
    const target = keepTarget && this.controls ? this.controls.target.clone() : new THREE.Vector3(0, 0, 0);
    if (this.controls) this.controls.dispose();
    this.cam = ortho ? this.orthoCam : this.persp;
    this.cam.position.copy(pos);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(target);
    if (ortho) { this.orthoHalfH = ACTIVE_MM * (this.orthoBase || 0.62); this._fitOrtho(); this.orthoCam.zoom = 1; this.orthoCam.updateProjectionMatrix(); }
    this.controls = new OrbitControls(this.cam, this.canvas);
    this.controls.target.copy(target);
    this.controls.maxDistance = 200;       // stay inside the glass-view room
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.update();
  }

  render() {
    this.controls.update();
    const r = this.renderer;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;   // CSS px: three multiplies by the pixel ratio itself
    r.setViewport(0, 0, w, h); r.setScissorTest(false);
    r.autoClear = true;
    if (this.mode === 'glass') this.glass.update(this.cam, this.ortho);
    r.render(this.scene, this.cam);
    if (this.showGizmo !== false) {
      const s = Math.round(Math.min(w, h) * 0.2);
      r.setScissorTest(true);
      r.setViewport(8, 8, s, s); r.setScissor(8, 8, s, s);
      r.autoClear = false; r.clearDepth();
      this.gizmoCam.position.copy(this.cam.position).sub(this.controls.target).normalize().multiplyScalar(4);
      this.gizmoCam.up.copy(this.cam.up);
      this.gizmoCam.lookAt(0, 0, 0);
      r.render(this.gizmoScene, this.gizmoCam);
      r.setScissorTest(false);
      r.autoClear = true;
    }
  }
}
