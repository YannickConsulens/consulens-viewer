/* Consulens viewer tools: section planes (clipping) + distance measurement. */

import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

interface ToolOpts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  getPickables: () => THREE.Object3D[];
}

type Axis = 'x' | 'y' | 'z';
const AXES: Axis[] = ['x', 'y', 'z'];

// IFC / Belgian convention: Z = height. Scene is Y-up (IFClite converts IFC
// Z-up -> Three Y-up), so label X->scene x, Y->scene z, Z(height)->scene y.
const SECTION_BUTTONS: Array<{ label: string; axis: Axis }> = [
  { label: 'X', axis: 'x' },
  { label: 'Y', axis: 'z' },
  { label: 'Z', axis: 'y' },
];

const AXIS_NORMAL: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

export interface ViewerTools { onModelLoaded(): void; }

export function initViewerTools(opts: ToolOpts): ViewerTools {
  const { renderer, scene, camera, controls: _controls, canvas, container, getPickables } = opts;
  void _controls;
  renderer.localClippingEnabled = true;

  const section: Record<Axis, { enabled: boolean; sign: number; value: number; plane: THREE.Plane }> = {
    x: { enabled: false, sign: 1, value: 0, plane: new THREE.Plane(AXIS_NORMAL.x.clone(), 0) },
    y: { enabled: false, sign: 1, value: 0, plane: new THREE.Plane(AXIS_NORMAL.y.clone(), 0) },
    z: { enabled: false, sign: 1, value: 0, plane: new THREE.Plane(AXIS_NORMAL.z.clone(), 0) },
  };
  let bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  function refreshClipping() {
    const active: THREE.Plane[] = [];
    for (const a of AXES) {
      const s = section[a];
      if (!s.enabled) continue;
      s.plane.normal.copy(AXIS_NORMAL[a]).multiplyScalar(s.sign);
      s.plane.constant = -s.value * s.sign;
      active.push(s.plane);
    }
    renderer.clippingPlanes = active;
  }

  let measuring = false;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pending: THREE.Vector3 | null = null;
  interface Measurement { a: THREE.Vector3; b: THREE.Vector3; line: THREE.Line; ma: THREE.Mesh; mb: THREE.Mesh; label: HTMLElement; }
  const measurements: Measurement[] = [];
  let pendingMarker: THREE.Mesh | null = null;

  const markerGeo = new THREE.SphereGeometry(1, 12, 12);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xe94560, depthTest: false });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xe94560, depthTest: false });

  function markerSize(): number {
    const d = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1);
    return d * 0.006;
  }
  function makeMarker(p: THREE.Vector3): THREE.Mesh {
    const m = new THREE.Mesh(markerGeo, markerMat);
    m.position.copy(p);
    m.scale.setScalar(markerSize());
    m.renderOrder = 3;
    scene.add(m);
    return m;
  }

  function raycastPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(getPickables(), false);
    return hits.length ? hits[0].point.clone() : null;
  }

  const measureLayer = document.createElement('div');
  measureLayer.id = 'measure-layer';
  container.appendChild(measureLayer);

  function addMeasurement(a: THREE.Vector3, b: THREE.Vector3) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, lineMat);
    line.renderOrder = 3;
    scene.add(line);
    const ma = makeMarker(a);
    const mb = makeMarker(b);
    const label = document.createElement('div');
    label.className = 'measure-label';
    label.textContent = `${a.distanceTo(b).toFixed(2)} m`;
    measureLayer.appendChild(label);
    measurements.push({ a, b, line, ma, mb, label });
  }

  function clearMeasurements() {
    for (const m of measurements) {
      scene.remove(m.line, m.ma, m.mb);
      m.line.geometry.dispose();
      m.label.remove();
    }
    measurements.length = 0;
    if (pendingMarker) { scene.remove(pendingMarker); pendingMarker = null; }
    pending = null;
  }

  const tmp = new THREE.Vector3();
  (function updateLabels() {
    requestAnimationFrame(updateLabels);
    if (!measurements.length) return;
    const w = container.clientWidth, h = container.clientHeight;
    for (const m of measurements) {
      tmp.copy(m.a).add(m.b).multiplyScalar(0.5).project(camera);
      const behind = tmp.z > 1;
      m.label.style.display = behind ? 'none' : 'block';
      m.label.style.left = `${(tmp.x * 0.5 + 0.5) * w}px`;
      m.label.style.top = `${(-tmp.y * 0.5 + 0.5) * h}px`;
    }
  })();

  let downX = 0, downY = 0;
  canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; }, true);
  canvas.addEventListener('click', (e) => {
    if (!measuring) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
    e.stopImmediatePropagation();
    const p = raycastPoint(e.clientX, e.clientY);
    if (!p) return;
    if (!pending) { pending = p; pendingMarker = makeMarker(p); }
    else { if (pendingMarker) { scene.remove(pendingMarker); pendingMarker = null; } addMeasurement(pending, p); pending = null; }
  }, true);

  function setMeasuring(on: boolean) {
    measuring = on;
    container.classList.toggle('measuring', on);
    btnMeasure.classList.toggle('active', on);
    if (!on && pendingMarker) { scene.remove(pendingMarker); pendingMarker = null; pending = null; }
  }

  const bar = document.createElement('div');
  bar.id = 'tool-bar';
  bar.innerHTML = `
    <div class="tool-group" id="section-group">
      <span class="tool-label">Snijvlak</span>
      ${SECTION_BUTTONS.map(({ label, axis }) => `<button class="tool-btn sec-toggle" data-axis="${axis}">${label}</button>`).join('')}
      <button class="tool-btn" id="sec-flip" title="Keer richting om" disabled>⇄</button>
      <input type="range" id="sec-slider" min="0" max="1" step="0.001" value="0.5" disabled />
    </div>
    <div class="tool-group">
      <button class="tool-btn" id="btn-measure" title="Meet afstand tussen twee punten">📏 Meten</button>
      <button class="tool-btn" id="btn-clear" title="Wis metingen">Wis</button>
    </div>`;
  container.appendChild(bar);

  const secToggles = Array.from(bar.querySelectorAll<HTMLButtonElement>('.sec-toggle'));
  const slider = bar.querySelector<HTMLInputElement>('#sec-slider')!;
  const flipBtn = bar.querySelector<HTMLButtonElement>('#sec-flip')!;
  const btnMeasure = bar.querySelector<HTMLButtonElement>('#btn-measure')!;
  const btnClear = bar.querySelector<HTMLButtonElement>('#btn-clear')!;
  let activeAxis: Axis | null = null;

  function axisRange(a: Axis): [number, number] { return [bounds.min[a], bounds.max[a]]; }
  function syncSliderToAxis(a: Axis) {
    const [lo, hi] = axisRange(a);
    slider.min = String(lo); slider.max = String(hi);
    slider.step = String(Math.max((hi - lo) / 1000, 1e-4));
    slider.value = String(section[a].value);
  }

  for (const btn of secToggles) {
    btn.addEventListener('click', () => {
      const a = btn.dataset.axis as Axis;
      const s = section[a];
      s.enabled = !s.enabled;
      btn.classList.toggle('active', s.enabled);
      if (s.enabled) {
        const [lo, hi] = axisRange(a);
        if (s.value < lo || s.value > hi) s.value = (lo + hi) / 2;
        activeAxis = a;
        slider.disabled = false; flipBtn.disabled = false;
        syncSliderToAxis(a);
      } else if (activeAxis === a) {
        const other = AXES.find((x) => section[x].enabled) ?? null;
        activeAxis = other;
        if (other) syncSliderToAxis(other);
        else { slider.disabled = true; flipBtn.disabled = true; }
      }
      refreshClipping();
    });
  }
  slider.addEventListener('input', () => { if (activeAxis) { section[activeAxis].value = parseFloat(slider.value); refreshClipping(); } });
  flipBtn.addEventListener('click', () => { if (activeAxis) { section[activeAxis].sign *= -1; refreshClipping(); } });
  btnMeasure.addEventListener('click', () => setMeasuring(!measuring));
  btnClear.addEventListener('click', clearMeasurements);

  return {
    onModelLoaded() {
      const pk = getPickables();
      const box = new THREE.Box3();
      for (const o of pk) box.expandByObject(o);
      if (!box.isEmpty()) bounds = box;
      for (const a of AXES) { section[a].enabled = false; section[a].sign = 1; section[a].value = (bounds.min[a] + bounds.max[a]) / 2; }
      for (const btn of secToggles) btn.classList.remove('active');
      activeAxis = null;
      slider.disabled = true; flipBtn.disabled = true;
      refreshClipping();
      clearMeasurements();
      setMeasuring(false);
    },
  };
}
