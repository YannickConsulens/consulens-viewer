/* Consulens viewer — view/display controls: preset views, home, fullscreen,
 * screenshot, discipline visibility, colour-by-class + legend, X-ray, show
 * all, and saved viewpoints (localStorage). */

import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface LegendItem { type: string; css: string; count: number; }

export interface ControlsCtx {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  container: HTMLElement;
  savedViewsKey: string;
  getBounds: () => THREE.Box3 | null;
  fitCamera: () => void;
  getDisciplines: () => Array<{ name: string; hidden: boolean }>;
  setDisciplineHidden: (index: number, hidden: boolean) => void;
  getLegend: () => LegendItem[];
  setXray: (on: boolean) => void;
  setByClass: (on: boolean) => void;
  showAll: () => void;
}

interface SavedView { name: string; pos: number[]; target: number[]; }
export interface ViewControls { refresh(): void; }

export function initControls(ctx: ControlsCtx): ViewControls {
  const { camera, controls, renderer, container } = ctx;

  function presetView(dir: THREE.Vector3) {
    const box = ctx.getBounds();
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 1;
    const distance = radius * 1.6;
    controls.target.copy(center);
    camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(distance));
    camera.near = radius * 0.001; camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function screenshot() {
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `consulens-3d-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else container.requestFullscreen?.();
  }

  function loadViews(): SavedView[] {
    try { return JSON.parse(localStorage.getItem(ctx.savedViewsKey) || '[]'); } catch { return []; }
  }
  function storeViews(v: SavedView[]) {
    try { localStorage.setItem(ctx.savedViewsKey, JSON.stringify(v)); } catch { /* ignore */ }
  }
  function goToView(v: SavedView) {
    camera.position.fromArray(v.pos);
    controls.target.fromArray(v.target);
    camera.updateProjectionMatrix();
    controls.update();
  }

  const bar = document.createElement('div');
  bar.id = 'view-bar';
  bar.innerHTML = `
    <button class="vbtn" data-act="home" title="Pas in beeld">⌂</button>
    <button class="vbtn" data-act="top" title="Bovenaanzicht">Boven</button>
    <button class="vbtn" data-act="front" title="Vooraanzicht">Voor</button>
    <button class="vbtn" data-act="side" title="Zijaanzicht">Zij</button>
    <button class="vbtn" data-act="iso" title="Isometrisch">ISO</button>
    <div class="vsep"></div>
    <button class="vbtn" data-act="xray" title="Doorzichtig (X-ray)">X-ray</button>
    <button class="vbtn" data-act="byclass" title="Kleur per IFC-klasse">Klasse</button>
    <button class="vbtn" data-act="legend" title="Legende">Legende</button>
    <button class="vbtn" data-act="disc" title="Disciplines tonen/verbergen">Lagen</button>
    <button class="vbtn" data-act="showall" title="Toon alles">Reset</button>
    <div class="vsep"></div>
    <button class="vbtn" data-act="views" title="Opgeslagen standpunten">Standpunten</button>
    <button class="vbtn" data-act="fs" title="Volledig scherm">⛶</button>
    <button class="vbtn" data-act="shot" title="Schermafbeelding">Foto</button>`;
  container.appendChild(bar);

  const pop = document.createElement('div');
  pop.id = 'view-pop';
  pop.style.display = 'none';
  container.appendChild(pop);

  let openPop: string | null = null;
  function closePop() { pop.style.display = 'none'; openPop = null; bar.querySelectorAll('.vbtn.active').forEach((b) => { if (!(b as HTMLElement).dataset.act || !['xray', 'byclass'].includes((b as HTMLElement).dataset.act!)) b.classList.remove('active'); }); }
  function showPop(kind: string, btn: HTMLElement, html: string) {
    if (openPop === kind) { closePop(); return; }
    closePop();
    openPop = kind;
    btn.classList.add('active');
    pop.innerHTML = html;
    pop.style.display = 'block';
  }

  let xray = false, byClass = false;

  function disciplineHtml(): string {
    const d = ctx.getDisciplines();
    if (d.length <= 1) return `<div class="pop-title">Disciplines</div><p class="pop-empty">Slechts één model geladen.</p>`;
    return `<div class="pop-title">Disciplines</div>` + d.map((m, i) =>
      `<label class="pop-row"><input type="checkbox" data-disc="${i}" ${m.hidden ? '' : 'checked'}/> ${escapeHtml(m.name)}</label>`
    ).join('');
  }
  function legendHtml(): string {
    const items = ctx.getLegend();
    if (!items.length) return `<div class="pop-title">Legende</div><p class="pop-empty">Nog geen model geladen.</p>`;
    return `<div class="pop-title">Legende (per klasse)</div>` + items.map((it) =>
      `<div class="pop-row"><span class="legend-swatch" style="background:${it.css}"></span>${escapeHtml(it.type.replace('Ifc', ''))} <span class="legend-count">${it.count}</span></div>`
    ).join('');
  }
  function viewsHtml(): string {
    const views = loadViews();
    const list = views.length
      ? views.map((v, i) => `<div class="pop-row view-row"><button class="view-go" data-view-go="${i}" title="Ga naar standpunt">${escapeHtml(v.name)}</button><button class="view-del" data-view-del="${i}" title="Verwijder">✕</button></div>`).join('')
      : `<p class="pop-empty">Nog geen standpunten opgeslagen.</p>`;
    return `<div class="pop-title">Opgeslagen standpunten</div>${list}<button class="pop-save" data-view-save="1">+ Huidig standpunt bewaren</button>`;
  }

  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.vbtn');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'home':  ctx.fitCamera(); closePop(); break;
      case 'top':   presetView(new THREE.Vector3(0, 1, 0.0001)); closePop(); break;
      case 'front': presetView(new THREE.Vector3(0, 0, 1)); closePop(); break;
      case 'side':  presetView(new THREE.Vector3(1, 0, 0)); closePop(); break;
      case 'iso':   presetView(new THREE.Vector3(1, 0.8, 1)); closePop(); break;
      case 'fs':    toggleFullscreen(); break;
      case 'shot':  screenshot(); break;
      case 'xray':  xray = !xray; btn.classList.toggle('active', xray); ctx.setXray(xray); break;
      case 'byclass': byClass = !byClass; btn.classList.toggle('active', byClass); ctx.setByClass(byClass); if (openPop === 'legend') pop.innerHTML = legendHtml(); break;
      case 'showall': ctx.showAll(); closePop(); break;
      case 'disc':  showPop('disc', btn, disciplineHtml()); break;
      case 'legend': showPop('legend', btn, legendHtml()); break;
      case 'views': showPop('views', btn, viewsHtml()); break;
    }
  });

  pop.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const go = t.closest<HTMLElement>('[data-view-go]')?.dataset.viewGo;
    const del = t.closest<HTMLElement>('[data-view-del]')?.dataset.viewDel;
    const save = t.closest<HTMLElement>('[data-view-save]');
    if (go != null) { const v = loadViews()[+go]; if (v) goToView(v); return; }
    if (del != null) { const v = loadViews(); v.splice(+del, 1); storeViews(v); pop.innerHTML = viewsHtml(); return; }
    if (save) {
      const name = prompt('Naam voor dit standpunt:', `Standpunt ${loadViews().length + 1}`);
      if (name) { const v = loadViews(); v.push({ name, pos: camera.position.toArray(), target: controls.target.toArray() }); storeViews(v); pop.innerHTML = viewsHtml(); }
      return;
    }
  });

  pop.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement;
    if (cb.dataset.disc != null) ctx.setDisciplineHidden(+cb.dataset.disc, !cb.checked);
  });

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return {
    refresh() {
      xray = false; byClass = false;
      bar.querySelector('[data-act="xray"]')?.classList.remove('active');
      bar.querySelector('[data-act="byclass"]')?.classList.remove('active');
      if (openPop === 'disc') pop.innerHTML = disciplineHtml();
      else if (openPop === 'legend') pop.innerHTML = legendHtml();
      else if (openPop === 'views') pop.innerHTML = viewsHtml();
    },
  };
}
