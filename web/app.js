import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const view = document.getElementById('view');
const appVerEl = document.getElementById('appVer');
if (appVerEl) appVerEl.textContent = 'v20261019d';

window.addEventListener('error', (e) => {
  const st = document.getElementById('status');
  if (st) st.textContent = 'JS error: ' + (e.message || e.error);
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d21);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(1.3, 0.9, 1.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
view.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.35, 0);
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x33383f, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(2, 3, 2);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.7);
fill.position.set(-2, 1, -1.5);
scene.add(fill);

const sceneGrid = new THREE.GridHelper(2, 20, 0xffffff, 0xbbbbbb);
sceneGrid.material.transparent = true;
sceneGrid.material.opacity = 0.7;
sceneGrid.material.depthWrite = false;
scene.add(sceneGrid);
let sceneGridOn = true;

function setSceneGridColor(hue) {
  sceneGrid.material.color.setHSL(hue / 360, 0.7, 0.6);
}

const wireMaterial = new THREE.LineBasicMaterial({ color: 0x2f7fd8, transparent: true, opacity: 0.85 });
let wires = [];
let wireOn = false;

function setWireColor(hue) {
  wireMaterial.color.setHSL(hue / 360, 0.8, 0.6);
}

function buildWires(root) {
  wires.forEach((w) => w.geometry.dispose());
  wires = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const w = new THREE.LineSegments(new THREE.WireframeGeometry(o.geometry), wireMaterial);
      w.visible = wireOn;
      o.add(w);
      wires.push(w);
    }
  });
}

// --- Cage preview (Substance Painter style) ---
const cageMaterial = new THREE.MeshBasicMaterial({
  color: 0xff8800,
  transparent: true,
  opacity: 0.25,
  depthWrite: false,
  depthTest: true,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
let cageOn = false;

function cageExtrusion() {
  const el = document.getElementById('cage');
  return el ? parseFloat(el.value) : 0;
}

function clearCage(root) {
  if (!root) return;
  const remove = [];
  root.traverse((o) => {
    if (o.name === '__cage__') remove.push(o);
  });
  for (const o of remove) {
    if (o.geometry) o.geometry.dispose();
    if (o.parent) o.parent.remove(o);
  }
}

function buildCage(root, extrusion) {
  clearCage(root);
  if (!root || !(extrusion > 0)) return;
  root.updateWorldMatrix(true, true);
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.name !== '__cage__' && o.geometry && o.geometry.attributes.position) {
      meshes.push(o);
    }
  });
  for (const mesh of meshes) {
    let geo = mesh.geometry.clone();
    // keep only position so mergeVertices welds split verts (same pos, diff normal/uv)
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position') geo.deleteAttribute(name);
    }
    geo = mergeVertices(geo, 1e-4);
    geo.computeVertexNormals();
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    if (!norm) { geo.dispose(); continue; }
    const ws = new THREE.Vector3();
    mesh.getWorldScale(ws);
    const avg = (Math.abs(ws.x) + Math.abs(ws.y) + Math.abs(ws.z)) / 3 || 1;
    const e = extrusion / avg;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i,
        pos.getX(i) + norm.getX(i) * e,
        pos.getY(i) + norm.getY(i) * e,
        pos.getZ(i) + norm.getZ(i) * e);
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    const cage = new THREE.Mesh(geo, cageMaterial);
    cage.name = '__cage__';
    cage.visible = cageOn;
    cage.renderOrder = 1;
    mesh.add(cage);
  }
}

function refreshCage() {
  if (currentRoot) buildCage(currentRoot, cageExtrusion());
}

const loader = new GLTFLoader();
let material = null;
let currentRoot = null;
let currentRoom = 'bake';
let texVersion = Date.now();
let modelVersion = Date.now();

const animClock = new THREE.Clock(false);
let rigMixer = null;
let rigActions = [];
let rigClips = [];
let rigAction = null;
let rigPlaying = false;
let rigTotalFrames = 0;
let rigFps = 24;

const previewCanvas = document.getElementById('previewCanvas');
const previewRenderer = new THREE.WebGLRenderer({
  canvas: previewCanvas,
  antialias: false,
  preserveDrawingBuffer: true,
});
previewRenderer.setPixelRatio(1);
previewRenderer.outputColorSpace = THREE.SRGBColorSpace;

const procCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const procScene = new THREE.Scene();
const uniforms = {
  uTex: { value: null },
  uTexel: { value: new THREE.Vector2(1, 1) },
  uFlipY: { value: 0.0 },
  uBrightness: { value: 0 },
  uContrast: { value: 0 },
  uSaturation: { value: 1 },
  uHue: { value: 0 },
  uVibrance: { value: 0 },
  uExposure: { value: 0 },
  uGamma: { value: 1 },
  uTemperature: { value: 0 },
  uTint: { value: 0 },
  uLevelsBlack: { value: 0 },
  uLevelsWhite: { value: 1 },
  uSharpen: { value: 0 },
  uToLinear: { value: 0 },
};

const procMaterial = new THREE.ShaderMaterial({
  uniforms,
  depthTest: false,
  depthWrite: false,
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D uTex;
    uniform vec2 uTexel;
    uniform float uFlipY;
    uniform float uBrightness;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uHue;
    uniform float uVibrance;
    uniform float uExposure;
    uniform float uGamma;
    uniform float uTemperature;
    uniform float uTint;
    uniform float uLevelsBlack;
    uniform float uLevelsWhite;
    uniform float uSharpen;
    uniform float uToLinear;
    varying vec2 vUv;

    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }
    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }
    vec3 srgbToLinear(vec3 c) {
      return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
    }

    void main() {
      vec2 uv = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlipY));
      vec3 raw = texture2D(uTex, uv).rgb;
      vec3 c = raw;

      if (uSharpen > 0.0) {
        vec3 blur = vec3(0.0);
        blur += texture2D(uTex, uv + vec2(uTexel.x, 0.0)).rgb;
        blur += texture2D(uTex, uv - vec2(uTexel.x, 0.0)).rgb;
        blur += texture2D(uTex, uv + vec2(0.0, uTexel.y)).rgb;
        blur += texture2D(uTex, uv - vec2(0.0, uTexel.y)).rgb;
        blur *= 0.25;
        c = raw + (raw - blur) * uSharpen;
      }

      c *= pow(2.0, uExposure);
      c = (c - uLevelsBlack) / max(uLevelsWhite - uLevelsBlack, 1.0e-4);
      c += uBrightness;
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;
      c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / max(uGamma, 1.0e-3)));

      vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
      hsv.x = fract(hsv.x + uHue);
      if (abs(uVibrance) > 1.0e-5) {
        float mx = max(max(c.r, c.g), c.b);
        hsv.y = clamp(hsv.y + uVibrance * (1.0 - mx) * hsv.y, 0.0, 1.0);
      }
      hsv.y = clamp(hsv.y * uSaturation, 0.0, 1.0);
      c = hsv2rgb(hsv);

      c.r += uTemperature * 0.15;
      c.b -= uTemperature * 0.15;
      c.g += uTint * 0.15;
      c.r -= uTint * 0.075;
      c.b -= uTint * 0.075;

      c = clamp(c, 0.0, 1.0);
      if (uToLinear > 0.5) c = srgbToLinear(c);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
});
procScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), procMaterial));

let sourceTex = null;
let procRT = null;
let texW = 0;
let texH = 0;
let procW = 0;
let procH = 0;
const PROC_MAX = 2048;

function makeRT(w, h) {
  if (procRT) procRT.dispose();
  procRT = new THREE.WebGLRenderTarget(w, h, {
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  procRT.texture.wrapS = THREE.ClampToEdgeWrapping;
  procRT.texture.wrapT = THREE.ClampToEdgeWrapping;
}

function setupTargets() {
  texW = sourceTex.image.width;
  texH = sourceTex.image.height;
  const scale = Math.min(1, PROC_MAX / Math.max(texW, texH));
  procW = Math.max(1, Math.round(texW * scale));
  procH = Math.max(1, Math.round(texH * scale));

  makeRT(procW, procH);
  uniforms.uTex.value = sourceTex;
  uniforms.uTexel.value.set(1 / texW, 1 / texH);

  if (material) {
    material.map = procRT.texture;
    material.needsUpdate = true;
  }

  previewCanvas.width = procW;
  previewCanvas.height = procH;
  previewRenderer.setSize(procW, procH, false);
}

function readAdjustments() {
  const g = (id) => parseFloat(document.getElementById(id).value);
  uniforms.uBrightness.value = g('adjBrightness');
  uniforms.uContrast.value = g('adjContrast');
  uniforms.uSaturation.value = g('adjSaturation');
  uniforms.uHue.value = (g('adjHue') * Math.PI) / 180;
  uniforms.uVibrance.value = g('adjVibrance');
  uniforms.uExposure.value = g('adjExposure');
  uniforms.uGamma.value = g('adjGamma');
  uniforms.uTemperature.value = g('adjTemperature');
  uniforms.uTint.value = g('adjTint');
  uniforms.uLevelsBlack.value = g('adjLevelsBlack');
  uniforms.uLevelsWhite.value = g('adjLevelsWhite');
  uniforms.uSharpen.value = g('adjSharpen');
}

function processTexture() {
  if (!sourceTex || !procRT) return;
  readAdjustments();

  uniforms.uFlipY.value = 0.0;
  uniforms.uToLinear.value = 1.0;
  renderer.setRenderTarget(procRT);
  renderer.render(procScene, procCamera);
  renderer.setRenderTarget(null);

  uniforms.uFlipY.value = 1.0;
  uniforms.uToLinear.value = 0.0;
  previewRenderer.render(procScene, procCamera);
  uniforms.uFlipY.value = 0.0;
  uniforms.uToLinear.value = 0.0;
}

function loadTexture() {
  return new Promise((resolve) => {
    if (!sourceTex) {
      sourceTex = new THREE.Texture();
    }
    const img = new Image();
    img.onload = () => {
      sourceTex.image = img;
      sourceTex.colorSpace = THREE.NoColorSpace;
      sourceTex.flipY = false;
      sourceTex.wrapS = THREE.ClampToEdgeWrapping;
      sourceTex.wrapT = THREE.ClampToEdgeWrapping;
      sourceTex.minFilter = THREE.LinearFilter;
      sourceTex.magFilter = THREE.LinearFilter;
      sourceTex.generateMipmaps = false;
      sourceTex.needsUpdate = true;
      setupTargets();
      processTexture();
      resolve();
    };
    img.onerror = () => resolve();
    img.src = '/texture.png?v=' + (texVersion++);
  });
}

function frameObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  camera.position.set(maxDim * 1.7, maxDim * 1.2, maxDim * 2.0);
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();

  sceneGrid.scale.setScalar(maxDim);
  sceneGrid.position.y = -size.y / 2;
}

function loadModel() {
  return new Promise((resolve, reject) => {
    loader.load('./model.glb?v=' + (modelVersion++), (gltf) => {
      const root = gltf.scene;

      if (!material) {
        material = new THREE.MeshStandardMaterial({
          roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
        });
        if (procRT) material.map = procRT.texture;
      }

      let meshCount = 0;
      root.traverse((o) => {
        if (o.isMesh) {
          meshCount++;
          o.material = material;
        }
      });

      if (currentRoot) {
        scene.remove(currentRoot);
        wires.forEach((w) => w.geometry.dispose());
        wires = [];
        clearCage(currentRoot);
        currentRoot.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      }
      currentRoot = root;
      root.visible = currentRoom === 'bake';
      scene.add(root);
      buildWires(root);
      if (cageOn) buildCage(root, cageExtrusion());
      frameObject(root);
      resolve(meshCount);
    }, undefined, reject);
  });
}

loadModel()
  .then(() => loadTexture())
  .catch((err) => {
    const st = document.getElementById('status');
    if (st) st.textContent = 'Ошибка загрузки model.glb: ' + err;
    console.error(err);
  });

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const els = {
  cage: document.getElementById('cage'),
  ray: document.getElementById('ray'),
  margin: document.getElementById('margin'),
  resolution: document.getElementById('resolution'),
  bake: document.getElementById('bake'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  fileLow: document.getElementById('fileLow'),
  fileHigh: document.getElementById('fileHigh'),
  fileTex: document.getElementById('fileTex'),
  lowName: document.getElementById('lowName'),
  highName: document.getElementById('highName'),
  texName: document.getElementById('texName'),
  gridToggle: document.getElementById('sceneGridToggle'),
  gridColor: document.getElementById('sceneGridColor'),
  wireToggle: document.getElementById('wireToggle'),
  wireColor: document.getElementById('wireColor'),
  cageToggle: document.getElementById('cageToggle'),
  cageOpacity: document.getElementById('cageOpacity'),
  cageColor: document.getElementById('cageColor'),
  adjSave: document.getElementById('adjSave'),
  adjDownload: document.getElementById('adjDownload'),
  adjReset: document.getElementById('adjReset'),
};

function bindFile(input, label, emptyText) {
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) {
      label.textContent = f.name;
      label.classList.remove('empty');
    } else {
      label.textContent = emptyText;
      label.classList.add('empty');
    }
    updateBakeEnabled();
  });
}
bindFile(els.fileLow, els.lowName, 'выбрать…');
bindFile(els.fileHigh, els.highName, 'выбрать…');
bindFile(els.fileTex, els.texName, 'авто из high');

function updateBakeEnabled() {
  const ready = els.fileLow.files.length > 0 && els.fileHigh.files.length > 0;
  els.bake.disabled = !ready;
}
updateBakeEnabled();

const RECOMMENDED_MARGIN = { 512: 4, 1024: 8, 2048: 16, 4096: 32 };

function bind(id, fmt) {
  const el = els[id];
  const out = document.getElementById(id + '_v');
  const upd = () => { out.textContent = fmt(parseFloat(el.value)); };
  el.addEventListener('input', upd);
  upd();
}
bind('cage', (v) => v.toFixed(4));
bind('ray', (v) => v.toFixed(4));
bind('margin', (v) => v.toFixed(0));

els.resolution.addEventListener('change', () => {
  const res = parseInt(els.resolution.value, 10);
  const m = RECOMMENDED_MARGIN[res];
  if (m != null) {
    els.margin.value = String(m);
    document.getElementById('margin_v').textContent = String(m);
  }
});

function setLabel(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

els.gridToggle.addEventListener('change', () => {
  sceneGridOn = els.gridToggle.checked;
  sceneGrid.visible = sceneGridOn;
});
els.gridColor.addEventListener('input', () => {
  setSceneGridColor(parseFloat(els.gridColor.value));
  setLabel('sceneGridColor_v', els.gridColor.value);
});

els.wireToggle.addEventListener('change', () => {
  wireOn = els.wireToggle.checked;
  wires.forEach((w) => { w.visible = wireOn; });
});
els.wireColor.addEventListener('input', () => {
  setWireColor(parseFloat(els.wireColor.value));
  setLabel('wireColor_v', els.wireColor.value);
});

sceneGridOn = els.gridToggle.checked;
sceneGrid.visible = sceneGridOn;
setSceneGridColor(parseFloat(els.gridColor.value));
setLabel('sceneGridColor_v', els.gridColor.value);

wireOn = els.wireToggle.checked;
wires.forEach((w) => { w.visible = wireOn; });
setWireColor(parseFloat(els.wireColor.value));
setLabel('wireColor_v', els.wireColor.value);

// --- Cage controls ---
function setCageColor(hue) {
  cageMaterial.color.setHSL(hue / 360, 0.9, 0.55);
}

els.cageToggle.addEventListener('change', () => {
  cageOn = els.cageToggle.checked;
  if (cageOn) {
    refreshCage();
    const n = currentRoot ? currentRoot.getObjectsByProperty('name', '__cage__').length : 0;
    els.status.textContent = n > 0
      ? 'Кейдж включён: ' + n + ' оболочек, extrusion ' + cageExtrusion()
      : 'Кейдж: нет мешей для отображения';
  } else {
    if (currentRoot) clearCage(currentRoot);
    els.status.textContent = '';
  }
});
els.cageOpacity.addEventListener('input', () => {
  cageMaterial.opacity = parseFloat(els.cageOpacity.value) / 100;
  setLabel('cageOpacity_v', els.cageOpacity.value + '%');
});
els.cageColor.addEventListener('input', () => {
  setCageColor(parseFloat(els.cageColor.value));
  setLabel('cageColor_v', els.cageColor.value);
});
els.cage.addEventListener('input', () => {
  if (cageOn) refreshCage();
});

setCageColor(parseFloat(els.cageColor.value));
setLabel('cageColor_v', els.cageColor.value);
setLabel('cageOpacity_v', els.cageOpacity.value + '%');

const ADJ = [
  ['adjBrightness', (v) => v.toFixed(2)],
  ['adjContrast', (v) => v.toFixed(2)],
  ['adjSaturation', (v) => v.toFixed(2)],
  ['adjHue', (v) => String(Math.round(v))],
  ['adjVibrance', (v) => v.toFixed(2)],
  ['adjExposure', (v) => v.toFixed(2)],
  ['adjGamma', (v) => v.toFixed(2)],
  ['adjTemperature', (v) => v.toFixed(2)],
  ['adjTint', (v) => v.toFixed(2)],
  ['adjLevelsBlack', (v) => v.toFixed(3)],
  ['adjLevelsWhite', (v) => v.toFixed(3)],
  ['adjSharpen', (v) => v.toFixed(2)],
];
const ADJ_DEFAULTS = {
  adjBrightness: 0, adjContrast: 0, adjSaturation: 1, adjHue: 0, adjVibrance: 0,
  adjExposure: 0, adjGamma: 1, adjTemperature: 0, adjTint: 0,
  adjLevelsBlack: 0, adjLevelsWhite: 1, adjSharpen: 0,
};

for (const [id, fmt] of ADJ) {
  const el = document.getElementById(id);
  const out = document.getElementById(id + '_v');
  const upd = () => out.textContent = fmt(parseFloat(el.value));
  el.addEventListener('input', () => { upd(); processTexture(); });
  upd();
}

function resetAdjustments() {
  for (const [id, fmt] of ADJ) {
    const el = document.getElementById(id);
    el.value = String(ADJ_DEFAULTS[id]);
    document.getElementById(id + '_v').textContent = fmt(ADJ_DEFAULTS[id]);
  }
  processTexture();
}
els.adjReset.addEventListener('click', resetAdjustments);

async function bake() {
  const fd = new FormData();
  fd.append('low', els.fileLow.files[0]);
  fd.append('high', els.fileHigh.files[0]);
  if (els.fileTex.files.length) fd.append('texture', els.fileTex.files[0]);
  fd.append('cage_extrusion', els.cage.value);
  fd.append('max_ray_distance', els.ray.value);
  fd.append('margin', els.margin.value);
  fd.append('resolution', els.resolution.value);

  els.bake.disabled = true;
  els.log.textContent = '';
  els.status.textContent = 'Загрузка и бейк…';
  const t0 = Date.now();
  const timer = setInterval(() => {
    els.status.textContent = 'Печём… ' + ((Date.now() - t0) / 1000).toFixed(0) + ' с';
  }, 500);

  try {
    const r = await fetch('/bake', { method: 'POST', body: fd });
    const data = await r.json();
    clearInterval(timer);
    if (data.ok) {
      let meshCount = 0;
      try { meshCount = await loadModel(); } catch { /* ignore */ }
      await loadTexture();
      const info = data.info || {};
      els.status.textContent =
        'Готово за ' + data.seconds + ' с · мешей: ' + meshCount +
        (info.texture ? ' · текстура: ' + info.texture : '');
    } else {
      els.status.textContent = 'Ошибка бейка';
      els.log.textContent = data.log || data.error || '';
    }
  } catch (e) {
    clearInterval(timer);
    els.status.textContent = 'Ошибка запроса';
    els.log.textContent = String(e);
  } finally {
    updateBakeEnabled();
  }
}

els.bake.addEventListener('click', bake);

function exportBlob() {
  return new Promise((resolve) => {
    if (!sourceTex || !sourceTex.image) { resolve(null); return; }
    const ow = procW, oh = procH;
    previewCanvas.width = texW;
    previewCanvas.height = texH;
    previewRenderer.setSize(texW, texH, false);
    uniforms.uFlipY.value = 1.0;
    uniforms.uToLinear.value = 0.0;
    previewRenderer.render(procScene, procCamera);
    uniforms.uFlipY.value = 0.0;
    const finish = (blob) => {
      previewCanvas.width = ow;
      previewCanvas.height = oh;
      previewRenderer.setSize(ow, oh, false);
      processTexture();
      resolve(blob);
    };
    if (previewCanvas.toBlob) previewCanvas.toBlob(finish, 'image/png');
    else finish(null);
  });
}

els.adjSave.addEventListener('click', async () => {
  els.adjSave.disabled = true;
  els.status.textContent = 'Сохранение PNG…';
  try {
    const blob = await exportBlob();
    if (!blob) throw new Error('нет текстуры');
    const r = await fetch('/save-texture', { method: 'POST', body: blob });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await loadTexture();
    resetAdjustments();
    els.status.textContent = 'Base color сохранена на сервере, коррекция применена.';
  } catch (e) {
    els.status.textContent = 'Ошибка сохранения: ' + e;
  } finally {
    els.adjSave.disabled = false;
  }
});

els.adjDownload.addEventListener('click', async () => {
  els.adjDownload.disabled = true;
  try {
    const blob = await exportBlob();
    if (!blob) throw new Error('нет текстуры');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'basecolor.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    els.status.textContent = 'Ошибка скачивания: ' + e;
  } finally {
    els.adjDownload.disabled = false;
  }
});

const tip = document.getElementById('tooltip');
document.querySelectorAll('.ctrl[data-tip]').forEach((el) => {
  el.addEventListener('mouseenter', () => {
    tip.innerHTML = el.getAttribute('data-tip');
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left - tw - 12;
    if (left < 8) left = Math.min(r.right + 12, innerWidth - tw - 8);
    let top = r.top;
    if (top + th > innerHeight - 8) top = innerHeight - th - 8;
    if (top < 8) top = 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  });
  el.addEventListener('mouseleave', () => tip.classList.remove('show'));
});

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');

previewCanvas.addEventListener('click', () => {
  lightboxImg.src = previewCanvas.toDataURL('image/png');
  lightbox.classList.add('open');
});
lightbox.addEventListener('click', () => lightbox.classList.remove('open'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') lightbox.classList.remove('open');
});

const rigGroup = new THREE.Group();
rigGroup.visible = false;
scene.add(rigGroup);

const rigBoneMaterial = new THREE.MeshBasicMaterial({
  color: 0xa6b0ba,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const rigBoneLineMaterial = new THREE.LineBasicMaterial({
  color: 0x22262b,
  depthWrite: false,
});

let rigRoot = null;
const rigBoneObjs = [];
let rigSkelOn = true;
let rigInFront = true;

const elsRig = {
  file: document.getElementById('rigFile'),
  name: document.getElementById('rigName'),
  status: document.getElementById('rigStatus'),
  log: document.getElementById('rigLog'),
  skelToggle: document.getElementById('rigSkelToggle'),
  inFrontToggle: document.getElementById('rigInFrontToggle'),
  gridToggle: document.getElementById('rigGridToggle'),
};

function applyRigDepth() {
  rigBoneMaterial.depthTest = !rigInFront;
  rigBoneMaterial.needsUpdate = true;
  rigBoneLineMaterial.depthTest = !rigInFront;
  rigBoneLineMaterial.needsUpdate = true;
}

function setRigBonesVisible(v) {
  for (const o of rigBoneObjs) o.visible = v;
}

function setGridVisible(v) {
  sceneGridOn = v;
  sceneGrid.visible = v;
  els.gridToggle.checked = v;
  elsRig.gridToggle.checked = v;
}

function makeBoneGeometry(t) {
  const L = t.length();
  const d = t.clone().divideScalar(L);
  const tmp = Math.abs(d.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(tmp, d).normalize();
  const v = new THREE.Vector3().crossVectors(d, u).normalize();
  const r = L * 0.1;
  const gp = d.clone().multiplyScalar(L * 0.3);
  const verts = [
    0, 0, 0,
    t.x, t.y, t.z,
    gp.x + u.x * r, gp.y + u.y * r, gp.z + u.z * r,
    gp.x - u.x * r, gp.y - u.y * r, gp.z - u.z * r,
    gp.x + v.x * r, gp.y + v.y * r, gp.z + v.z * r,
    gp.x - v.x * r, gp.y - v.y * r, gp.z - v.z * r,
  ];
  const idx = [
    0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2,
    1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  return geo;
}

function buildRigSkeleton(root) {
  const boneSet = new Set();
  root.traverse((o) => { if (o.isBone) boneSet.add(o); });
  let segments = 0;
  for (const bone of boneSet) {
    const parent = bone.parent;
    if (!parent || !boneSet.has(parent)) continue;
    if (bone.position.length() < 1e-8) continue;
    const geo = makeBoneGeometry(bone.position);
    const mesh = new THREE.Mesh(geo, rigBoneMaterial);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), rigBoneLineMaterial);
    mesh.renderOrder = 1000;
    outline.renderOrder = 1000;
    mesh.visible = rigSkelOn;
    outline.visible = rigSkelOn;
    parent.add(mesh);
    parent.add(outline);
    rigBoneObjs.push(mesh, outline);
    segments++;
  }
  return { bones: boneSet.size, segments };
}

function clearRig() {
  teardownAnimations();
  for (const o of rigBoneObjs) {
    if (o.geometry) o.geometry.dispose();
    if (o.parent) o.parent.remove(o);
  }
  rigBoneObjs.length = 0;
  if (rigRoot) {
    rigRoot.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    rigGroup.remove(rigRoot);
    rigRoot = null;
  }
}

const SRGB_COLOR_MAPS = ['map', 'emissiveMap', 'specularMap'];

function fixTextureColorSpace(root) {
  root.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      let changed = false;
      for (const key of SRGB_COLOR_MAPS) {
        const tex = m[key];
        if (tex && tex.colorSpace !== THREE.SRGBColorSpace) {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          changed = true;
        }
      }
      if (changed) m.needsUpdate = true;
    }
  });
}

const elsAnim = {
  player: document.getElementById('rigPlayer'),
  play: document.getElementById('rigPlay'),
  frame: document.getElementById('rigFrame'),
  timeline: document.getElementById('rigTimeline'),
  clip: document.getElementById('rigClip'),
  fpsSel: document.getElementById('rigFpsSel'),
};

function animDuration() {
  return rigAction && rigAction.getClip ? rigAction.getClip().duration : 0;
}

function syncAnimUi() {
  if (!rigAction) return;
  const dur = animDuration() || 1;
  const t = rigAction.time % dur;
  const frame = Math.min(rigTotalFrames, Math.max(0, Math.round(t * rigFps)));
  elsAnim.frame.textContent = frame + ' / ' + rigTotalFrames;
  if (document.activeElement !== elsAnim.timeline) {
    elsAnim.timeline.value = String(frame);
  }
}

function setPlaying(v) {
  if (!rigAction) return;
  rigPlaying = v;
  rigAction.paused = !v;
  elsAnim.play.textContent = v ? '⏸' : '▶';
  if (v) {
    animClock.start();
    animClock.getDelta();
  } else {
    animClock.stop();
  }
}

function seekFrame(f) {
  if (!rigAction || !rigMixer) return;
  const dur = animDuration() || 1;
  let t = f / rigFps;
  if (t >= dur) t = Math.max(0, dur - 1 / rigFps);
  rigAction.time = t;
  rigMixer.update(0);
  syncAnimUi();
}

function setupAnimations(root, clips) {
  teardownAnimations();
  if (!clips || !clips.length) return;
  rigClips = clips;
  rigMixer = new THREE.AnimationMixer(root);
  rigActions = clips.map((c) => rigMixer.clipAction(c));
  elsAnim.clip.innerHTML = '';
  clips.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = c.name || ('Clip ' + (i + 1));
    elsAnim.clip.appendChild(opt);
  });
  elsAnim.clip.hidden = clips.length < 2;
  selectClip(0);
  elsAnim.player.hidden = currentRoom !== 'rig';
}

function selectClip(i) {
  if (!rigActions.length) return;
  setPlaying(false);
  if (rigAction) rigAction.stop();
  rigAction = rigActions[i] || rigActions[0];
  rigAction.reset();
  rigAction.play();
  rigAction.paused = true;
  const dur = animDuration() || 1;
  rigTotalFrames = Math.max(1, Math.round(dur * rigFps));
  elsAnim.timeline.min = '0';
  elsAnim.timeline.max = String(rigTotalFrames);
  elsAnim.timeline.value = '0';
  rigAction.time = 0;
  if (rigMixer) rigMixer.update(0);
  syncAnimUi();
}

function teardownAnimations() {
  setPlaying(false);
  if (rigMixer) {
    rigMixer.stopAllAction();
    if (rigMixer._root) rigMixer.uncacheRoot(rigMixer.getRoot());
    rigMixer = null;
  }
  rigActions = [];
  rigClips = [];
  rigAction = null;
  rigTotalFrames = 0;
  elsAnim.player.hidden = true;
  elsAnim.frame.textContent = '0 / 0';
  elsAnim.timeline.value = '0';
  elsAnim.timeline.max = '0';
}

elsAnim.play.addEventListener('click', () => setPlaying(!rigPlaying));

elsAnim.timeline.addEventListener('input', () => {
  seekFrame(parseInt(elsAnim.timeline.value, 10) || 0);
});

elsAnim.clip.addEventListener('change', () => {
  selectClip(parseInt(elsAnim.clip.value, 10) || 0);
});

elsAnim.fpsSel.addEventListener('change', () => {
  const oldFps = rigFps;
  rigFps = parseInt(elsAnim.fpsSel.value, 10) || 24;
  if (rigAction && oldFps > 0) {
    const t = rigAction.time;
    const dur = animDuration() || 1;
    rigTotalFrames = Math.max(1, Math.round(dur * rigFps));
    elsAnim.timeline.max = String(rigTotalFrames);
    seekFrame(Math.round(t * rigFps));
    if (t >= dur - 1e-6) rigAction.time = 0;
  }
});

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if (currentRoom !== 'rig' || !rigAction) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  e.preventDefault();
  setPlaying(!rigPlaying);
});

async function loadRigFile(file) {
  clearRig();
  elsRig.log.textContent = '';
  elsRig.status.textContent = 'Загрузка модели…';
  const url = URL.createObjectURL(file);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    let root;
    let clips = [];
    if (ext === 'fbx') {
      root = await new FBXLoader().loadAsync(url);
      clips = root.animations || [];
    } else {
      const gltf = await loader.loadAsync(url);
      root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      clips = gltf.animations || [];
    }
    if (!root) throw new Error('модель не найдена в файле');
    fixTextureColorSpace(root);
    rigRoot = root;
    rigGroup.add(root);
    let meshCount = 0;
    root.traverse((o) => { if (o.isMesh) meshCount++; });
    const skel = buildRigSkeleton(root);
    applyRigDepth();
    setupAnimations(root, clips);
    frameObject(root);
    let msg = 'Модель загружена · мешей: ' + meshCount;
    if (skel.bones > 0) msg += ' · костей: ' + skel.bones + ' · сегментов: ' + skel.segments;
    else msg += ' · скелет не найден';
    if (clips.length) msg += ' · анимаций: ' + clips.length;
    elsRig.status.textContent = msg;
  } catch (e) {
    clearRig();
    elsRig.status.textContent = 'Ошибка загрузки: ' + (e && e.message ? e.message : e);
    elsRig.log.textContent = String((e && e.stack) || e);
  } finally {
    URL.revokeObjectURL(url);
  }
}

bindFile(elsRig.file, elsRig.name, 'выбрать…');

elsRig.file.addEventListener('change', () => {
  const f = elsRig.file.files && elsRig.file.files[0];
  if (f) loadRigFile(f);
});

elsRig.skelToggle.addEventListener('change', () => {
  rigSkelOn = elsRig.skelToggle.checked;
  setRigBonesVisible(rigSkelOn);
});

elsRig.inFrontToggle.addEventListener('change', () => {
  rigInFront = elsRig.inFrontToggle.checked;
  applyRigDepth();
});

elsRig.gridToggle.addEventListener('change', () => {
  setGridVisible(elsRig.gridToggle.checked);
});

const tabs = document.querySelectorAll('.tab');
const bakePanelEl = document.getElementById('bakePanel');
const rigPanelEl = document.getElementById('rigPanel');

function switchRoom(name) {
  currentRoom = name;
  for (const t of tabs) t.classList.toggle('active', t.dataset.room === name);
  bakePanelEl.hidden = name !== 'bake';
  rigPanelEl.hidden = name !== 'rig';
  if (currentRoot) currentRoot.visible = name === 'bake';
  rigGroup.visible = name === 'rig';
  elsAnim.player.hidden = !(name === 'rig' && rigClips.length > 0);
  if (name !== 'rig' && rigPlaying) setPlaying(false);
  if (name === 'bake' && currentRoot) frameObject(currentRoot);
  if (name === 'rig') {
    elsRig.gridToggle.checked = sceneGrid.visible;
    if (rigRoot) frameObject(rigRoot);
  }
}

for (const t of tabs) t.addEventListener('click', () => switchRoom(t.dataset.room));

(function loop() {
  requestAnimationFrame(loop);
  const dt = animClock.getDelta();
  if (rigMixer && rigPlaying) {
    rigMixer.update(dt);
    syncAnimUi();
  }
  controls.update();
  renderer.render(scene, camera);
})();
