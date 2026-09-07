/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC viewer: @ifc-lite/geometry + Three.js — Consulens edition.
 * Federation, section planes, measurement, isolate/hide, X-ray,
 * discipline toggles, colour-by-class, storey plans, preset & saved views.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { initViewerTools } from './tools.js';
import { initControls, type LegendItem } from './controls.js';
import {
  batchWithVertexColors,
  findEntityByFace,
  type TriangleMaps,
  type TriangleRange,
} from './ifc-to-threejs.js';
import {
  buildDataStore,
  buildSpatialTreeFromStore,
  getEntityData,
  IfcTypeEnum,
  type IfcDataStore,
  type EntityData,
  type SpatialTreeNode,
} from './ifc-data.js';

const canvas          = document.getElementById('viewer')          as HTMLCanvasElement;
const fileInput       = document.getElementById('file-input')      as HTMLInputElement;
const status          = document.getElementById('status')          as HTMLElement;
const selectionPanel  = document.getElementById('selection-panel')  as HTMLElement;
const entityTypeBadge = document.getElementById('entity-type-badge');
const entityIdEl      = document.getElementById('entity-id');
const panelBody       = document.getElementById('panel-body')      as HTMLElement;
const panelClose      = document.getElementById('panel-close')     as HTMLButtonElement;
const spatialTree     = document.getElementById('spatial-tree')    as HTMLElement;
const spatialSearch   = document.getElementById('spatial-search')  as HTMLInputElement;
const spatialCount    = document.getElementById('spatial-entity-count') as HTMLElement;
const containerEl     = (document.getElementById('canvas-container') as HTMLElement) ?? canvas.parentElement!;

if (!canvas || !fileInput || !status || !selectionPanel || !panelBody || !panelClose) {
  throw new Error('Required DOM elements missing — check index.html');
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1b2a);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
camera.position.set(20, 15, 20);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(50, 80, 50);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xb0c4de, 0.3);
fillLight.position.set(-30, 10, -20);
scene.add(fillLight);

const geometry = new GeometryProcessor();

interface LoadedModel { name: string; store: IfcDataStore | null; spatialRoot: SpatialTreeNode | null; }
const models: LoadedModel[] = [];
const triangleMaps: TriangleMaps = new Map();
const meshModel = new Map<THREE.Mesh, number>();
const meshDataByKey = new Map<string, MeshData>();

let modelsGroup: THREE.Group | null = null;
let selectedKey: string | null = null;
let selectionHighlight: THREE.Mesh | null = null;

const disciplineHidden = new Set<number>();
const hiddenKeys = new Set<string>();
let isolateKeys: Set<string> | null = null;
let isolationGroup: THREE.Group | null = null;
let baseTriangles: Array<[THREE.Mesh, TriangleRange[]]> = [];
let baseMeshModel: Array<[THREE.Mesh, number]> = [];
let xray = false;
let byClass = false;

const viewerTools = initViewerTools({
  renderer, scene, camera, controls, canvas,
  container: containerEl,
  getPickables: () => livePickables(),
});

const viewerControls = initControls({
  camera, controls, renderer, container: containerEl,
  savedViewsKey: 'consulens-views:' + new URLSearchParams(location.search).getAll('model').join('|'),
  getBounds: currentBounds,
  fitCamera: fitCameraToScene,
  getDisciplines: () => models.map((m, i) => ({ name: m.name, hidden: disciplineHidden.has(i) })),
  setDisciplineHidden,
  getLegend,
  setXray: (on) => { xray = on; applyMaterialModes(); },
  setByClass: (on) => { byClass = on; applyMaterialModes(); },
  showAll,
});

function resize() {
  const el = canvas.parentElement ?? document.body;
  renderer.setSize(el.clientWidth, el.clientHeight);
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

function worldVisible(o: THREE.Object3D | null): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
function livePickables(): THREE.Mesh[] {
  return [...triangleMaps.keys()].filter((m) => worldVisible(m));
}

function pickAt(clientX: number, clientY: number): { mi: number; id: number } | null {
  if (triangleMaps.size === 0) return null;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(livePickables(), false);
  if (!hits.length || hits[0].faceIndex == null) return null;
  const mesh = hits[0].object as THREE.Mesh;
  const ranges = triangleMaps.get(mesh);
  const mi = meshModel.get(mesh);
  if (!ranges || mi == null) return null;
  const id = findEntityByFace(ranges, hits[0].faceIndex);
  return id == null ? null : { mi, id };
}

const DRAG_THRESHOLD_PX = 4;
let pointerDownX = 0, pointerDownY = 0, didDrag = false;

canvas.addEventListener('pointerdown', (e) => { pointerDownX = e.clientX; pointerDownY = e.clientY; didDrag = false; });

let hoverRafPending = false;
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) {
    if (!didDrag && Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > DRAG_THRESHOLD_PX) {
      didDrag = true;
      canvas.classList.add('dragging');
      canvas.classList.remove('hovering');
    }
    return;
  }
  if (hoverRafPending) return;
  hoverRafPending = true;
  const cx = e.clientX, cy = e.clientY;
  requestAnimationFrame(() => { hoverRafPending = false; canvas.classList.toggle('hovering', pickAt(cx, cy) != null); });
});

canvas.addEventListener('pointerup', () => canvas.classList.remove('dragging'));
canvas.addEventListener('mouseleave', () => canvas.classList.remove('hovering', 'dragging'));

canvas.addEventListener('click', (e) => {
  if (didDrag) return;
  const hit = pickAt(e.clientX, e.clientY);
  if (!hit) { clearSelection(); closePanel(); }
  else selectEntity(hit.mi, hit.id);
});

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearSelection(); closePanel(); } });

async function loadFiles(files: File[]) {
  if (!files.length) return;
  clearSelection();
  closePanel();
  resetSpatialPanel();
  const t0 = performance.now();

  try {
    await geometry.init();
    clearScene();

    modelsGroup = new THREE.Group();
    modelsGroup.name = 'models';
    scene.add(modelsGroup);

    for (let mi = 0; mi < files.length; mi++) {
      const file = files[mi];
      const prefix = files.length > 1 ? `Model ${mi + 1}/${files.length} — ` : '';
      status.textContent = `${prefix}${file.name} laden…`;

      const rawBuffer = await file.arrayBuffer();
      const buffer = new Uint8Array(rawBuffer);

      const allMeshes: MeshData[] = [];
      for await (const event of geometry.processStreaming(buffer)) {
        if (event.type === 'batch') {
          allMeshes.push(...event.meshes);
          status.textContent = `${prefix}${allMeshes.length} onderdelen…`;
        }
      }

      const { group, triangleMaps: tmaps } = batchWithVertexColors(allMeshes);
      group.name = `model-${mi}`;
      modelsGroup.add(group);
      for (const [mesh, ranges] of tmaps) { triangleMaps.set(mesh, ranges); meshModel.set(mesh, mi); }
      for (const m of allMeshes) meshDataByKey.set(`${mi}:${m.expressId}`, m);

      let store: IfcDataStore | null = null;
      let sroot: SpatialTreeNode | null = null;
      try {
        store = await buildDataStore(rawBuffer);
        sroot = buildSpatialTreeFromStore(store);
      } catch (err) {
        console.warn('[viewer] data store failed for', file.name, err);
      }
      models.push({ name: file.name, store, spatialRoot: sroot });

      if (mi === 0) fitCameraToScene();
    }

    baseTriangles = [...triangleMaps.entries()];
    baseMeshModel = [...meshModel.entries()];

    fitCameraToScene();
    viewerTools.onModelLoaded();
    renderSpatialPanel();
    viewerControls.refresh();

    status.textContent = files.length > 1
      ? `${files.length} modellen — ${meshDataByKey.size} onderdelen`
      : `${files[0].name} — ${meshDataByKey.size} onderdelen`;
    console.log(`[viewer] ${files.length} model(s), ${meshDataByKey.size} elements in ${(performance.now() - t0).toFixed(0)} ms`);
  } catch (err) {
    console.error(err);
    status.textContent = `Fout: ${(err as Error).message}`;
  }
}

fileInput.addEventListener('change', () => { loadFiles(fileInput.files ? Array.from(fileInput.files) : []); });

// ── Visibility / display ──────────────────────────────────────────────
function currentDisplayRoot(): THREE.Object3D | null { return isolationGroup ?? modelsGroup; }

function currentMeshes(): THREE.Mesh[] {
  const root = currentDisplayRoot();
  if (!root) return [];
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh && o.userData.originalColors) out.push(o); });
  return out;
}

function currentBounds(): THREE.Box3 | null {
  const root = currentDisplayRoot();
  if (!root) return null;
  const box = new THREE.Box3().setFromObject(root);
  return box.isEmpty() ? null : box;
}

function restoreBaseMaps() {
  triangleMaps.clear(); meshModel.clear();
  for (const [m, r] of baseTriangles) triangleMaps.set(m, r);
  for (const [m, mi] of baseMeshModel) meshModel.set(m, mi);
}

function rebuildVisibility() {
  if (isolationGroup) { scene.remove(isolationGroup); disposeObject(isolationGroup); isolationGroup = null; }

  const needTemp = isolateKeys != null || hiddenKeys.size > 0;
  if (!needTemp) {
    restoreBaseMaps();
    if (modelsGroup) {
      modelsGroup.visible = true;
      for (const child of modelsGroup.children) {
        const mi = Number(String(child.name).replace('model-', ''));
        child.visible = !disciplineHidden.has(mi);
      }
    }
    applyMaterialModes();
    return;
  }

  const wanted = isolateKeys ? isolateKeys : new Set(meshDataByKey.keys());
  triangleMaps.clear(); meshModel.clear();
  isolationGroup = new THREE.Group();
  isolationGroup.name = 'isolation';

  const byModel = new Map<number, MeshData[]>();
  for (const key of wanted) {
    if (hiddenKeys.has(key)) continue;
    const mi = Number(key.split(':')[0]);
    if (disciplineHidden.has(mi)) continue;
    const md = meshDataByKey.get(key);
    if (!md) continue;
    let arr = byModel.get(mi);
    if (!arr) { arr = []; byModel.set(mi, arr); }
    arr.push(md);
  }
  for (const [mi, mds] of byModel) {
    const { group, triangleMaps: tmaps } = batchWithVertexColors(mds);
    group.name = `iso-${mi}`;
    isolationGroup.add(group);
    for (const [mesh, ranges] of tmaps) { triangleMaps.set(mesh, ranges); meshModel.set(mesh, mi); }
  }
  if (modelsGroup) modelsGroup.visible = false;
  scene.add(isolationGroup);
  applyMaterialModes();
}

function applyMaterialModes() {
  for (const mesh of currentMeshes()) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const buf = (byClass ? mesh.userData.classColors : mesh.userData.originalColors) as Float32Array | undefined;
    if (buf) {
      geo.setAttribute('color', new THREE.BufferAttribute(buf, 3));
      (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat.userData.baseOpacity === undefined) {
      mat.userData.baseOpacity = mat.opacity;
      mat.userData.baseTransparent = mat.transparent;
      mat.userData.baseDepthWrite = mat.depthWrite;
    }
    if (xray) { mat.transparent = true; mat.opacity = 0.25; mat.depthWrite = false; }
    else {
      mat.opacity = mat.userData.baseOpacity as number;
      mat.transparent = mat.userData.baseTransparent as boolean;
      mat.depthWrite = mat.userData.baseDepthWrite as boolean;
    }
    mat.needsUpdate = true;
  }
}

function setDisciplineHidden(mi: number, hidden: boolean) {
  if (hidden) disciplineHidden.add(mi); else disciplineHidden.delete(mi);
  rebuildVisibility();
}

function isolateSelected() { if (selectedKey) { isolateKeys = new Set([selectedKey]); rebuildVisibility(); } }
function hideSelected() {
  if (!selectedKey) return;
  hiddenKeys.add(selectedKey);
  isolateKeys?.delete(selectedKey);
  clearSelection();
  closePanel();
  rebuildVisibility();
}
function showAll() { isolateKeys = null; hiddenKeys.clear(); rebuildVisibility(); }

function setTopView() {
  const box = currentBounds();
  if (!box) return;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z) || 1;
  controls.target.copy(c);
  camera.position.set(c.x, c.y + r * 1.7, c.z + 0.0001);
  camera.near = r * 0.001; camera.far = r * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function findSpatialNode(node: SpatialTreeNode, id: number): SpatialTreeNode | null {
  if (node.expressId === id) return node;
  for (const c of node.children) { const f = findSpatialNode(c, id); if (f) return f; }
  return null;
}
function collectElementIds(node: SpatialTreeNode, out: number[]) {
  for (const g of node.elementGroups) out.push(...g.ids);
  for (const c of node.children) collectElementIds(c, out);
}
function collectStoreys(node: SpatialTreeNode, out: SpatialTreeNode[]) {
  if (node.type === IfcTypeEnum.IfcBuildingStorey) out.push(node);
  for (const c of node.children) collectStoreys(c, out);
}

// Isolate a storey across ALL loaded models: match by elevation (±0.30 m) or
// by name, so a federated view shows the whole level (architecture + structure).
function isolateStorey(sourceMi: number, storeyId: number) {
  const srcRoot = models[sourceMi]?.spatialRoot;
  if (!srcRoot) return;
  const src = findSpatialNode(srcRoot, storeyId);
  if (!src) return;

  const targetElev = src.elevation;
  const targetName = (src.name || '').trim().toLowerCase();
  const ELEV_TOL = 0.30;

  const keys = new Set<string>();
  models.forEach((m, mi) => {
    if (!m.spatialRoot) return;
    const storeys: SpatialTreeNode[] = [];
    collectStoreys(m.spatialRoot, storeys);
    for (const st of storeys) {
      const isSource  = mi === sourceMi && st.expressId === storeyId;
      const elevMatch = targetElev != null && st.elevation != null && Math.abs(st.elevation - targetElev) <= ELEV_TOL;
      const nameMatch = targetName !== '' && (st.name || '').trim().toLowerCase() === targetName;
      if (isSource || elevMatch || nameMatch) {
        const ids: number[] = [];
        collectElementIds(st, ids);
        for (const id of ids) keys.add(`${mi}:${id}`);
      }
    }
  });

  isolateKeys = keys;
  rebuildVisibility();
  setTopView();
}

function getLegend(): LegendItem[] {
  const counts = new Map<string, number>();
  for (const md of meshDataByKey.values()) {
    const t = md.ifcType || 'IfcProduct';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count, css: classHsl(type) }));
}
function classHsl(t: string): string {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360},55%,55%)`;
}

// ── Selection ─────────────────────────────────────────────────────────
function selectEntity(mi: number, id: number) {
  selectedKey = `${mi}:${id}`;
  const md = meshDataByKey.get(selectedKey);
  if (!md) return;

  const ifcType = md.ifcType ?? 'IfcProduct';
  openPanel(ifcType, id);
  applyHighlight(md);

  const store = models[mi]?.store;
  if (store) renderPanel(getEntityData(store, id, ifcType));
  else panelBody.innerHTML = `<p class="loading-data">Eigenschappen laden…</p>`;

  revealInTree(mi, id);
}

function clearSelection() {
  selectedKey = null;
  removeHighlight();
  for (const row of spatialTree.querySelectorAll('.tree-row.selected')) row.classList.remove('selected');
}

function applyHighlight(md: MeshData) {
  removeHighlight();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(md.normals,   3));
  geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x4f46e5, emissive: 0x4f46e5, emissiveIntensity: 0.45,
    transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthTest: true,
  });

  selectionHighlight = new THREE.Mesh(geo, mat);
  if (md.origin) selectionHighlight.position.fromArray(md.origin);
  selectionHighlight.renderOrder = 1;
  scene.add(selectionHighlight);
}

function removeHighlight() {
  if (!selectionHighlight) return;
  scene.remove(selectionHighlight);
  selectionHighlight.geometry.dispose();
  (selectionHighlight.material as THREE.Material).dispose();
  selectionHighlight = null;
}

function openPanel(ifcType: string, id: number) {
  if (entityTypeBadge) entityTypeBadge.textContent = ifcType;
  if (entityIdEl)      entityIdEl.textContent      = `#${id}`;
  selectionPanel.classList.add('open');
}

function closePanel() { selectionPanel.classList.remove('open'); clearSelection(); }
panelClose.addEventListener('click', closePanel);

function renderPanel(data: EntityData) {
  const attrs: Array<[string, string]> = [
    ['GlobalId',    data.globalId    || '—'],
    ['Name',        data.name        || '—'],
    ['Description', data.description || '—'],
    ['ObjectType',  data.objectType  || '—'],
    ['Tag',         data.tag         || '—'],
  ];
  const attrsHtml = attrs.map(([label, value]) => {
    const empty = value === '—';
    return `<div class="attr-row"><span class="attr-label">${esc(label)}</span>` +
           `<span class="attr-value${empty ? ' empty' : ''}">${esc(value)}</span></div>`;
  }).join('');

  panelBody.innerHTML = `
    <div class="sel-actions">
      <button class="tool-btn" data-act="isolate">Isoleer</button>
      <button class="tool-btn" data-act="hide">Verberg</button>
      <button class="tool-btn" data-act="showall">Toon alles</button>
    </div>
    <div class="attr-section"><h3>Attributes</h3>${attrsHtml}</div>
    <div class="attr-section"><h3>Property Sets</h3>
      ${renderSets(data.propertySets.map(ps => ({ name: ps.name, rows: ps.properties.map(p => [p.name, p.value] as [string, string]) })), 'No property sets')}
    </div>
    <div class="attr-section"><h3>Quantity Sets</h3>
      ${renderSets(data.quantitySets.map(qs => ({ name: qs.name, rows: qs.quantities.map(q => [q.name, q.value] as [string, string]) })), 'No quantity sets')}
    </div>`;

  panelBody.querySelector('[data-act="isolate"]')?.addEventListener('click', isolateSelected);
  panelBody.querySelector('[data-act="hide"]')?.addEventListener('click', hideSelected);
  panelBody.querySelector('[data-act="showall"]')?.addEventListener('click', showAll);

  for (const btn of panelBody.querySelectorAll('.pset-toggle')) {
    btn.addEventListener('click', () => { btn.classList.toggle('open'); btn.nextElementSibling?.classList.toggle('open'); });
  }
}

function renderSets(sets: Array<{ name: string; rows: Array<[string, string]> }>, emptyMsg: string) {
  if (!sets.length) return `<p class="no-data">${emptyMsg}</p>`;
  return sets.map(({ name, rows }) => `
    <div class="pset-section">
      <button class="pset-toggle" type="button"><span>${esc(name)}</span><span class="pset-chevron">▶</span></button>
      <div class="pset-body">
        ${rows.map(([n, v]) => `<div class="pset-prop"><span class="pset-prop-name">${esc(n)}</span><span class="pset-prop-value">${esc(v)}</span></div>`).join('')}
      </div>
    </div>`).join('');
}

// ── Spatial panel (multi-model) ───────────────────────────────────────
function renderSpatialPanel() {
  const withTree = models.filter((m) => m.spatialRoot && m.store);
  if (!withTree.length) { spatialTree.innerHTML = `<p class="spatial-placeholder">Geen structuur gevonden.</p>`; return; }

  let total = 0;
  for (const m of models) if (m.spatialRoot) total += m.spatialRoot.totalElements;
  spatialCount.textContent = `${total}`;
  spatialCount.style.display = '';

  const multi = withTree.length > 1;
  let html = '';
  models.forEach((m, mi) => {
    if (!m.spatialRoot || !m.store) return;
    if (multi) {
      html += `
<div class="tree-node" id="sn-model-${mi}">
  <div class="tree-row" data-spatial="1" data-express-id="model-${mi}" style="--tree-depth:0">
    <span class="tree-toggle expanded" data-toggle-id="model-${mi}">▶</span>
    <span class="tree-icon icon-project">IFC</span>
    <span class="tree-label">${esc(m.name)}</span>
    <span class="tree-count">${m.spatialRoot.totalElements}</span>
  </div>
  <div class="tree-children open" id="sc-model-${mi}">
    ${buildNodeHtml(m.spatialRoot, 1, m.store, mi)}
  </div>
</div>`;
    } else {
      html += buildNodeHtml(m.spatialRoot, 0, m.store, mi);
    }
  });

  spatialTree.innerHTML = html;
  spatialTree.onclick = handleTreeClick;
  spatialSearch.oninput = () => filterTree(spatialSearch.value.trim().toLowerCase());
}

function resetSpatialPanel() {
  spatialTree.innerHTML = `<p class="spatial-placeholder">Open een IFC-bestand om de structuur te verkennen.</p>`;
  spatialTree.onclick = null;
  spatialSearch.value = '';
  spatialSearch.oninput = null;
  spatialCount.style.display = 'none';
}

function buildNodeHtml(node: SpatialTreeNode, depth: number, store: IfcDataStore, mi: number): string {
  const hasChildren = node.children.length > 0 || node.elementGroups.length > 0;
  const { icon, abbr } = spatialNodeMeta(node.type);
  const nameText = node.name || store.entities.getName(node.expressId) || `#${node.expressId}`;
  const subLabel = node.elevation != null ? ` ${node.elevation.toFixed(1)}m` : '';
  const autoOpen = depth < 2;
  const isStorey = node.type === IfcTypeEnum.IfcBuildingStorey;

  let childrenHtml = '';
  for (const child of node.children) childrenHtml += buildNodeHtml(child, depth + 1, store, mi);
  for (const { typeName, ids } of node.elementGroups) childrenHtml += buildTypeGroupHtml(typeName, ids, depth + 1, mi);

  return `
<div class="tree-node" id="sn-${mi}-${node.expressId}">
  <div class="tree-row" data-express-id="${node.expressId}" data-model="${mi}" data-spatial="1" style="--tree-depth:${depth}">
    <span class="tree-toggle${hasChildren ? (autoOpen ? ' expanded' : '') : ' leaf'}" data-toggle-id="${mi}-${node.expressId}">▶</span>
    <span class="tree-icon ${icon}">${abbr}</span>
    <span class="tree-label">${esc(nameText)}</span>
    ${subLabel ? `<span class="tree-sublabel">${esc(subLabel)}</span>` : ''}
    ${isStorey ? `<span class="storey-plan" data-storey="${mi}-${node.expressId}" title="Toon enkel deze verdieping">▣</span>` : ''}
    ${node.totalElements > 0 ? `<span class="tree-count">${node.totalElements}</span>` : ''}
  </div>
  <div class="tree-children${autoOpen ? ' open' : ''}" id="sc-${mi}-${node.expressId}">
    ${childrenHtml}
  </div>
</div>`;
}

function buildTypeGroupHtml(typeName: string, ids: number[], depth: number, mi: number): string {
  const color = typeColor(typeName);
  const elemRows = ids.map((id) => `
  <div class="tree-row" data-express-id="${id}" data-model="${mi}" data-element="1" id="en-${mi}-${id}" style="--tree-depth:${depth + 1}">
    <span class="tree-toggle leaf">▶</span>
    <span class="tree-icon icon-element" style="background:${color}"></span>
    <span class="tree-label dim">#${id}</span>
  </div>`).join('');

  return `
<div class="tree-node">
  <div class="tree-row" data-type-group="${esc(typeName)}" style="--tree-depth:${depth}">
    <span class="tree-toggle${ids.length ? '' : ' leaf'}" data-toggle-type="${esc(typeName)}-${mi}-${depth}">▶</span>
    <span class="tree-icon icon-type" style="font-size:8px">${esc(typeName.replace('Ifc', '').substring(0, 3).toUpperCase())}</span>
    <span class="tree-label">${esc(typeName.replace('Ifc', ''))}</span>
    <span class="tree-count">${ids.length}</span>
  </div>
  <div class="tree-children" id="tg-${esc(typeName)}-${mi}-${depth}">
    ${elemRows}
  </div>
</div>`;
}

function handleTreeClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.tree-row');
  if (!row) return;

  const storey = (target.closest('[data-storey]') as HTMLElement | null)?.dataset.storey;
  if (storey) {
    const [mi, id] = storey.split('-').map(Number);
    isolateStorey(mi, id);
    e.stopPropagation();
    return;
  }

  const toggleId   = (target.closest('[data-toggle-id]')   as HTMLElement | null)?.dataset.toggleId;
  const toggleType = (target.closest('[data-toggle-type]') as HTMLElement | null)?.dataset.toggleType;
  const toggleTarget = toggleId ?? toggleType;
  if (toggleTarget) {
    const toggle = row.querySelector('.tree-toggle') ?? target.closest('.tree-toggle');
    const childrenId = toggleId ? `sc-${toggleId}` : `tg-${toggleType}`;
    const children = document.getElementById(childrenId);
    if (children) { const nowOpen = children.classList.toggle('open'); toggle?.classList.toggle('expanded', nowOpen); }
    e.stopPropagation();
    return;
  }

  if (row.dataset.spatial) {
    const id = row.dataset.expressId;
    const mi = row.dataset.model;
    const childId = mi != null ? `sc-${mi}-${id}` : `sc-${id}`;
    const children = document.getElementById(childId);
    const toggle = row.querySelector<HTMLElement>('.tree-toggle');
    if (children && toggle && !toggle.classList.contains('leaf')) {
      const nowOpen = children.classList.toggle('open');
      toggle.classList.toggle('expanded', nowOpen);
    }
    return;
  }

  if (row.dataset.element) {
    const id = parseInt(row.dataset.expressId ?? '', 10);
    const mi = parseInt(row.dataset.model ?? '', 10);
    if (!isNaN(id) && !isNaN(mi)) selectEntity(mi, id);
    return;
  }
}

function revealInTree(mi: number, id: number) {
  for (const row of spatialTree.querySelectorAll('.tree-row.selected')) row.classList.remove('selected');
  const container = document.getElementById(`en-${mi}-${id}`);
  const row = container?.querySelector('.tree-row') ?? container;
  if (!row) {
    const store = models[mi]?.store;
    const storeyId = store?.spatialHierarchy?.elementToStorey.get(id);
    if (storeyId != null) { expandSpatialNode(mi, storeyId); requestAnimationFrame(() => revealInTree(mi, id)); }
    return;
  }
  row.classList.add('selected');
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function expandSpatialNode(mi: number, id: number) {
  const children = document.getElementById(`sc-${mi}-${id}`);
  if (!children || children.classList.contains('open')) return;
  children.classList.add('open');
  document.querySelector(`[data-toggle-id="${mi}-${id}"]`)?.classList.add('expanded');
}

function filterTree(query: string) {
  if (!query) { renderSpatialPanel(); return; }
  const matches: Array<{ mi: number; id: number; typeName: string; name: string }> = [];
  models.forEach((m, mi) => { if (m.spatialRoot && m.store) collectMatchingElements(m.spatialRoot, query, m.store, mi, matches); });

  if (!matches.length) {
    spatialTree.innerHTML = `<p class="spatial-placeholder">Geen resultaten voor "${esc(query)}"</p>`;
    spatialTree.onclick = null;
    return;
  }

  const rows = matches.map(({ mi, id, typeName, name }) => {
    const color = typeColor(typeName);
    return `<div class="tree-row" data-express-id="${id}" data-model="${mi}" data-element="1" id="en-${mi}-${id}" style="--tree-depth:0">
      <span class="tree-toggle leaf">▶</span>
      <span class="tree-icon icon-element" style="background:${color}"></span>
      <span class="tree-label">${esc(name || `#${id}`)}</span>
      <span class="tree-sublabel">${esc(typeName.replace('Ifc', ''))}</span>
    </div>`;
  }).join('');

  spatialTree.innerHTML = `<div class="tree-node"><div class="tree-children open">${rows}</div></div>`;
  spatialTree.onclick = handleTreeClick;
}

function collectMatchingElements(
  node: SpatialTreeNode, query: string, store: IfcDataStore, mi: number,
  out: Array<{ mi: number; id: number; typeName: string; name: string }>,
) {
  for (const { typeName, ids } of node.elementGroups) {
    for (const id of ids) {
      const name = store.entities.getName(id) || '';
      if (typeName.toLowerCase().includes(query) || name.toLowerCase().includes(query) || String(id).includes(query)) {
        out.push({ mi, id, typeName, name });
      }
    }
  }
  for (const child of node.children) collectMatchingElements(child, query, store, mi, out);
}

function spatialNodeMeta(type: IfcTypeEnum): { icon: string; abbr: string } {
  switch (type) {
    case IfcTypeEnum.IfcProject:        return { icon: 'icon-project',  abbr: 'PRJ' };
    case IfcTypeEnum.IfcSite:           return { icon: 'icon-site',     abbr: 'SIT' };
    case IfcTypeEnum.IfcBuilding:       return { icon: 'icon-building', abbr: 'BLD' };
    case IfcTypeEnum.IfcFacility:
    case IfcTypeEnum.IfcBridge:
    case IfcTypeEnum.IfcRoad:
    case IfcTypeEnum.IfcRailway:
    case IfcTypeEnum.IfcMarineFacility: return { icon: 'icon-building', abbr: 'FAC' };
    case IfcTypeEnum.IfcBuildingStorey: return { icon: 'icon-storey',   abbr: 'STR' };
    case IfcTypeEnum.IfcFacilityPart:
    case IfcTypeEnum.IfcBridgePart:
    case IfcTypeEnum.IfcRoadPart:
    case IfcTypeEnum.IfcRailwayPart:    return { icon: 'icon-storey',   abbr: 'PRT' };
    case IfcTypeEnum.IfcSpace:          return { icon: 'icon-space',    abbr: 'SPC' };
    default:                            return { icon: 'icon-type',     abbr: '?' };
  }
}

function typeColor(typeName: string): string {
  let h = 0;
  for (let i = 0; i < typeName.length; i++) h = (h * 31 + typeName.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360},55%,52%)`;
}

function clearScene() {
  clearSelection();
  triangleMaps.clear();
  meshModel.clear();
  meshDataByKey.clear();
  models.length = 0;
  modelsGroup = null;
  if (isolationGroup) { scene.remove(isolationGroup); disposeObject(isolationGroup); isolationGroup = null; }
  isolateKeys = null;
  hiddenKeys.clear();
  disciplineHidden.clear();
  baseTriangles = [];
  baseMeshModel = [];

  const toRemove = scene.children.filter((o) => o instanceof THREE.Mesh || o instanceof THREE.Group);
  for (const o of toRemove) { scene.remove(o); disposeObject(o); }
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) (child.material as THREE.Material[]).forEach((m) => m.dispose());
      else (child.material as THREE.Material).dispose();
    }
  });
}

function fitCameraToScene() {
  const box = currentBounds();
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim <= 0 || !isFinite(maxDim)) return;

  const distance = maxDim * 1.5;
  const elevRad = THREE.MathUtils.degToRad(25);
  const planar = Math.cos(elevRad);
  const offset = new THREE.Vector3(
    planar * distance * Math.SQRT1_2,
    Math.sin(elevRad) * distance,
    -planar * distance * Math.SQRT1_2,
  );
  controls.target.copy(center);
  camera.position.copy(center).add(offset);
  camera.near = maxDim * 0.001;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

{
  const params = new URLSearchParams(location.search);
  const modelParams = params.getAll('model').flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  const embed = params.get('embed') === '1';
  const titleParam = params.get('title');

  const overlay = document.getElementById('load-overlay');
  const overlayText = document.getElementById('load-overlay-text');
  const setOverlay = (msg: string | null) => {
    if (!overlay || !overlayText) return;
    if (msg == null) { overlay.classList.remove('show'); return; }
    overlayText.textContent = msg;
    overlay.classList.add('show');
  };

  if (embed) document.body.classList.add('embed');
  if (titleParam) {
    const h1 = document.querySelector('header h1');
    if (h1) h1.textContent = titleParam;
    document.title = `${titleParam} — 3D-model`;
  }

  if (modelParams.length) {
    fileInput.style.display = 'none';
    const label = document.querySelector('label[for="file-input"]');
    if (label) (label as HTMLElement).style.display = 'none';

    const statusEl = document.getElementById('status');
    if (statusEl) {
      const mo = new MutationObserver(() => {
        const t = statusEl.textContent || '';
        if (/onderdelen$/.test(t) || /^Fout:/.test(t)) { setOverlay(null); mo.disconnect(); }
        else setOverlay(t);
      });
      mo.observe(statusEl, { childList: true, characterData: true, subtree: true });
    }

    (async () => {
      try {
        setOverlay(modelParams.length > 1 ? `${modelParams.length} modellen laden…` : '3D-model laden…');
        const files = await Promise.all(modelParams.map(async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} bij ${url}`);
          const blob = await res.blob();
          const name = decodeURIComponent(url.split('/').pop() || 'model.ifc');
          return new File([blob], name, { type: 'application/octet-stream' });
        }));
        loadFiles(files);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setOverlay('Kon het 3D-model niet laden. ' + msg);
        console.error('[Consulens viewer] model load failed:', err);
      }
    })();
  }
}
