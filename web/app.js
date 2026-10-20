import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const view = document.getElementById('view');
const appVerEl = document.getElementById('appVer');
if (appVerEl) appVerEl.textContent = 'v20261019j';

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
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
controls.zoomSpeed = 2;
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

  if (currentRoot) {
    currentRoot.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material.map = procRT.texture;
        o.material.needsUpdate = true;
      }
    });
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

// Считает полигоны/вершины из сырого OBJ (строка "f" = полигон, n вершин → n-2 треугольника).
// GLB/FBX/STL не парсим — там loader отдаёт уже триангулированную геометрию.
// Стриминг: файл может быть 100+ МБ, целиком в память его не грузим.
async function countObjStats(file) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let tail = '', polys = 0, verts = 0, tris = 0;
  const handle = (line) => {
    if (line.startsWith('v ')) verts++;
    else if (line.startsWith('f ')) {
      const n = line.trim().split(/\s+/).length - 1;
      polys++;
      tris += Math.max(0, n - 2);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const text = tail + chunk;
    const lines = text.split('\n');
    tail = lines.pop() || '';
    for (const line of lines) handle(line);
  }
  if (tail) handle(tail);
  return { polys, tris, verts };
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

function updateMeshStats(root) {
  const el = document.getElementById('meshStats');
  if (!el) return;
  if (!root) { el.classList.remove('visible'); el.textContent = ''; return; }
  let verts = 0, tris = 0;
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      verts += o.geometry.attributes.position?.count || 0;
      const idx = o.geometry.index;
      if (idx) tris += idx.count / 3;
      else tris += (o.geometry.attributes.position?.count || 0) / 3;
    }
  });
  tris = Math.round(tris);
  // meshStats: {polys, tris, verts} из Blender или парсинга OBJ; GLB/STL триангулированы — polys = tris
  const s = root.userData?.meshStats;
  if (s) {
    if (s.verts != null) verts = s.verts;
    if (s.tris != null) tris = s.tris;
  }
  const polys = s?.polys ?? root.userData?.polyCount ?? tris;
  el.textContent = `Polys: ${polys} | Tris: ${tris} | Verts: ${verts}`;
  el.classList.add('visible');
}

function setViewportRoot(root, frame = true) {
  if (currentRoot) {
    scene.remove(currentRoot);
    wires.forEach((w) => w.geometry.dispose());
    wires = [];
    clearCage(currentRoot);
    currentRoot.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  }
  currentRoot = root;
  root.visible = currentRoom === 'bake' || currentRoom === 'decimate';
  scene.add(root);
  buildWires(root);
  if (cageOn) buildCage(root, cageExtrusion());
  if (frame) frameObject(root);
  updateMeshStats(root);
}

function loadModel() {
  return new Promise((resolve, reject) => {
    loader.load('./model.glb?v=' + (modelVersion++), (gltf) => {
      const root = gltf.scene;

      let meshCount = 0;
      root.traverse((o) => {
        if (o.isMesh) {
          meshCount++;
          // Each mesh gets its own material instance
          const mat = new THREE.MeshStandardMaterial({
            roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
          });
          if (procRT) mat.map = procRT.texture;
          o.material = mat;
        }
      });

      setViewportRoot(root);
      resolve(meshCount);
    }, undefined, reject);
  });
}

function loadMeshFile(file, userScale = 1) {
  console.log('[loadMeshFile] start', file.name, file.size, 'userScale:', userScale);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const ext = file.name.split('.').pop().toLowerCase();
    console.log('[loadMeshFile] ext', ext);
    let loaderInstance;
    if (ext === 'glb' || ext === 'gltf') {
      loaderInstance = loader;
    } else if (ext === 'fbx') {
      loaderInstance = new FBXLoader();
    } else if (ext === 'obj') {
      loaderInstance = new OBJLoader();
    } else if (ext === 'stl') {
      // STL not imported, fallback to GLTFLoader (won't work well)
      loaderInstance = loader;
    } else {
      loaderInstance = loader;
    }
    console.log('[loadMeshFile] loader', loaderInstance.constructor.name);
    loaderInstance.load(url, (gltf) => {
      console.log('[loadMeshFile] loaded', gltf);
      URL.revokeObjectURL(url);
      const root = gltf.scene || gltf; // FBXLoader returns Group directly

      // Apply FBX unit scale factor (FBX often uses cm, three.js uses meters)
      const autoScale = root.userData?.unitScaleFactor ?? 1;
      if (autoScale !== 1) {
        root.scale.setScalar(autoScale);
        console.log('[loadMeshFile] applied FBX unitScaleFactor:', autoScale);
      }
      // Apply user-specified scale (for FBX without proper UnitScaleFactor)
      if (userScale !== 1) {
        root.scale.setScalar(root.scale.x * userScale);
        console.log('[loadMeshFile] applied user scale:', userScale);
      }
      // Выровнять: низ bounding box ровно на y=0 (пивот FBX часто в центре модели),
      // геометрию центрировать по X/Z относительно сетки (иначе OBJ смещён от начала координат)
      root.updateMatrixWorld(true);
      const loadBox = new THREE.Box3().setFromObject(root);
      if (isFinite(loadBox.min.y)) {
        root.position.y -= loadBox.min.y;
        const cx = (loadBox.min.x + loadBox.max.x) / 2;
        const cz = (loadBox.min.z + loadBox.max.z) / 2;
        root.position.x -= cx;
        root.position.z -= cz;
        console.log('[loadMeshFile] aligned min.y to 0 (was', loadBox.min.y.toFixed(4), '), centered X/Z (was', cx.toFixed(4), cz.toFixed(4), ')');
      }
      let meshCount = 0;
      root.traverse((o) => {
        if (o.isMesh) {
          meshCount++;
          // Each mesh gets its own material instance
          const mat = new THREE.MeshStandardMaterial({
            roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
          });
          if (procRT) mat.map = procRT.texture;
          o.material = mat;
        }
      });
      console.log('[loadMeshFile] meshes', meshCount);
      setViewportRoot(root, false);
      if (ext === 'obj') {
        // Полигоны считаем из сырого текста (async), статистику дописываем после
        countObjStats(file).then((st) => {
          root.userData.meshStats = st;
          if (root === currentRoot) updateMeshStats(root);
        }).catch(() => {});
      }
      resolve(meshCount);
    }, undefined, (err) => {
      console.error('[loadMeshFile] error', err);
      URL.revokeObjectURL(url);
      reject(err);
    });
  });
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/shutdown');
});

// Heartbeat: ping server every 5s; server shuts down after 30s of silence
setInterval(() => {
  fetch('/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
}, 5000);

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
  clearLow: document.getElementById('clearLow'),
  clearHigh: document.getElementById('clearHigh'),
  clearTex: document.getElementById('clearTex'),
  fbxScaleRow: document.getElementById('fbxScaleRow'),
  fbxScale: document.getElementById('fbxScale'),
  fbxScale_v: document.getElementById('fbxScale_v'),
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
  exportBakedGlb: document.getElementById('exportBakedGlb'),
  exportBakedFbx: document.getElementById('exportBakedFbx'),
};

const elsD = {
  file: document.getElementById('decFile'),
  name: document.getElementById('decName'),
  mode: document.getElementById('decMode'),
  ratioRow: document.getElementById('decRatioRow'),
  iterRow: document.getElementById('decIterRow'),
  angleRow: document.getElementById('decAngleRow'),
  targetRow: document.getElementById('decTargetRow'),
  ratio: document.getElementById('decRatio'),
  ratio_v: document.getElementById('decRatio_v'),
  iter: document.getElementById('decIter'),
  iter_v: document.getElementById('decIter_v'),
  angle: document.getElementById('decAngle'),
  angle_v: document.getElementById('decAngle_v'),
  target: document.getElementById('decTarget'),
  target_v: document.getElementById('decTarget_v'),
  btn: document.getElementById('decimate'),
  exportGlb: document.getElementById('decExportGlb'),
  exportObj: document.getElementById('decExportObj'),
  status: document.getElementById('decStatus'),
  smoothAngle: document.getElementById('smoothAngle'),
  smoothAngle_v: document.getElementById('smoothAngle_v'),
  smoothWeighted: document.getElementById('smoothWeighted'),
  smoothFlat: document.getElementById('smoothFlat'),
  matFlatShading: document.getElementById('matFlatShading'),
  applySmooth: document.getElementById('applySmooth'),
  smoothStatus: document.getElementById('smoothStatus'),
};

function bindFile(input, label, emptyText, onChange) {
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
    if (onChange) onChange();
  });
}
bindFile(els.fileLow, els.lowName, 'РІС‹Р±СЂР°С‚СЊвЂ¦', () => {
  const f = els.fileLow.files && els.fileLow.files[0];
  const isFBX = f && f.name.toLowerCase().endsWith('.fbx');
  if (els.fbxScaleRow) els.fbxScaleRow.hidden = !isFBX;
  if (f && currentRoom === 'bake') {
    const scale = isFBX ? parseFloat(els.fbxScale?.value ?? '0.01') : 1;
    loadMeshFile(f, scale).catch(e => els.status.textContent = 'РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё low-poly: ' + e);
  }
});
bindFile(els.fileHigh, els.highName, 'РІС‹Р±СЂР°С‚СЊвЂ¦');
bindFile(els.fileTex, els.texName, 'Р°РІС‚Рѕ РёР· high');

function clearFile(input, label, clearViewport = true) {
  input.value = '';
  label.textContent = label.dataset.empty || 'выбрать…';
  label.classList.add('empty');
  updateBakeEnabled();
  if (clearViewport && currentRoot) {
    setViewportRoot(null);
  }
}

function applyFbxScaleToRoot(scale) {
  if (!currentRoot) return;
  // Find the original scale (remove previous user scale)
  const autoScale = currentRoot.userData?.unitScaleFactor ?? 1;
  currentRoot.scale.setScalar(autoScale * scale);
  console.log('[applyFbxScale] applied scale:', scale);
  renderer.render(scene, camera);
}

els.fbxScale?.addEventListener('change', () => {
  const scale = parseFloat(els.fbxScale.value);
  applyFbxScaleToRoot(scale);
});

els.clearLow?.addEventListener('click', () => clearFile(els.fileLow, els.lowName));
els.clearHigh?.addEventListener('click', () => clearFile(els.fileHigh, els.highName));
els.clearTex?.addEventListener('click', () => clearFile(els.fileTex, els.texName, false));
bindFile(elsD.file, elsD.name, 'выбрать…', () => {
  const f = elsD.file.files && elsD.file.files[0];
  elsD.btn.disabled = !f;
  if (f) {
    loadMeshFile(f).catch(e => elsD.status.textContent = 'Ошибка загрузки меша: ' + e);
  }
});

elsD.mode.addEventListener('change', () => {
  const mode = elsD.mode.value;
  elsD.ratioRow.hidden = mode !== 'COLLAPSE';
  elsD.iterRow.hidden = mode !== 'UNSUBDIV';
  elsD.angleRow.hidden = mode !== 'DISSOLVE';
  elsD.targetRow.hidden = mode !== 'TARGET';
});

bindDec('smoothAngle', (v) => v + 'В°');
elsD.smoothAngle.addEventListener('input', () => {
  elsD.smoothAngle_v.textContent = elsD.smoothAngle.value;
});

function updateSmoothUI() {
  const flat = elsD.smoothFlat.checked;
  elsD.smoothAngle.disabled = flat;
  elsD.smoothWeighted.disabled = flat;
}
elsD.smoothFlat.addEventListener('change', updateSmoothUI);
elsD.smoothWeighted.addEventListener('change', updateSmoothUI);
updateSmoothUI();

elsD.matFlatShading.addEventListener('change', () => {
  if (currentRoot) {
    currentRoot.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material.flatShading = elsD.matFlatShading.checked;
        o.material.needsUpdate = true;
      }
    });
    renderer.render(scene, camera);
  }
});
 
function applySmoothToRoot(root) {
  console.log('[applySmoothToRoot] start');
  if (!root) return;
  const angle = parseFloat(elsD.smoothAngle.value);
  const flat = elsD.smoothFlat.checked;
  const matFlat = elsD.matFlatShading?.checked ?? false;
  console.log('[applySmoothToRoot] angle:', angle, 'flat:', flat, 'matFlat:', matFlat);

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;

    if (flat || matFlat || angle >= 179) {
      // FLAT: use flat vertex normals + material.flatShading
      if (typeof geo.computeFlatVertexNormals === 'function') {
        geo.computeFlatVertexNormals();
      } else {
        geo.computeVertexNormals();
      }
      geo.normalsNeedUpdate = true;
      if (o.material) {
        o.material.flatShading = true;
        o.material.needsUpdate = true;
      }
      console.log('[applySmoothToRoot] FLAT done for', o.name);
      return;
    }

    // SMOOTH: standard vertex normals + material.flatShading = false
    geo.computeVertexNormals();
    geo.normalsNeedUpdate = true;
    if (o.material) {
      o.material.flatShading = false;
      o.material.needsUpdate = true;
    }
    console.log('[applySmoothToRoot] SMOOTH done for', o.name);
  });

  renderer.render(scene, camera);
  if (elsD.smoothStatus) elsD.smoothStatus.textContent = flat ? 'РџР»РѕСЃРєРѕРµ Р·Р°С‚РµРЅРµРЅРёРµ' : (matFlat ? 'РњР°С‚РµСЂРёР°Р»: flatShading' : ('РЎРіР»Р°Р¶РёРІР°РЅРёРµ (СѓРіРѕР» в‰¤' + angle + 'В°)'));
  console.log('[applySmoothToRoot] done');
}

elsD.applySmooth.addEventListener('click', () => {
  console.log('[applySmooth] clicked, currentRoot:', currentRoot);
  if (currentRoot) {
    currentRoot.traverse((o) => {
      if (o.isMesh) console.log('[applySmooth] mesh:', o.name, 'geo:', o.geometry, 'mat:', o.material);
    });
    applySmoothToRoot(currentRoot);
  }
});

function bindDec(id, fmt) {
  const el = document.getElementById(id);
  if (!el) return;
  const out = document.getElementById(id + '_v');
  if (!out) return;
  const upd = () => { out.textContent = fmt(parseFloat(el.value)); };
  el.addEventListener('input', upd);
  upd();
}
bindDec('decRatio', (v) => v.toFixed(2));
bindDec('decIter', (v) => String(v));
bindDec('decAngle', (v) => v.toFixed(1));
bindDec('fbxScale', (v) => {
    const opt = els.fbxScale?.querySelector(`option[value="${v}"]`);
    return opt ? opt.textContent : v;
  });

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
      ? 'РљРµР№РґР¶ РІРєР»СЋС‡С‘РЅ: ' + n + ' РѕР±РѕР»РѕС‡РµРє, extrusion ' + cageExtrusion()
      : 'РљРµР№РґР¶: РЅРµС‚ РјРµС€РµР№ РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ';
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

let adjDirty = false;

for (const [id, fmt] of ADJ) {
  const el = document.getElementById(id);
  const out = document.getElementById(id + '_v');
  const upd = () => out.textContent = fmt(parseFloat(el.value));
  el.addEventListener('input', () => { upd(); processTexture(); adjDirty = true; });
  upd();
}

function resetAdjustments() {
  for (const [id, fmt] of ADJ) {
    const el = document.getElementById(id);
    el.value = String(ADJ_DEFAULTS[id]);
    document.getElementById(id + '_v').textContent = fmt(ADJ_DEFAULTS[id]);
  }
  processTexture();
  adjDirty = false;
}
els.adjReset.addEventListener('click', resetAdjustments);

async function saveTexture() {
  els.adjSave.disabled = true;
  els.status.textContent = 'РЎРѕС…СЂР°РЅРµРЅРёРµ PNGвЂ¦';
  try {
    const blob = await exportBlob();
    if (!blob) throw new Error('РЅРµС‚ С‚РµРєСЃС‚СѓСЂС‹');
    const r = await fetch('/save-texture', { method: 'POST', body: blob });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await loadTexture();
    resetAdjustments();
    els.status.textContent = 'Base color СЃРѕС…СЂР°РЅРµРЅР° РЅР° СЃРµСЂРІРµСЂРµ, РєРѕСЂСЂРµРєС†РёСЏ РїСЂРёРјРµРЅРµРЅР°.';
  } catch (e) {
    els.status.textContent = 'РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ: ' + e;
  } finally {
    els.adjSave.disabled = false;
  }
}

els.adjSave.addEventListener('click', saveTexture);

els.adjDownload.addEventListener('click', async () => {
  els.adjDownload.disabled = true;
  try {
    const blob = await exportBlob();
    if (!blob) throw new Error('РЅРµС‚ С‚РµРєСЃС‚СѓСЂС‹');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'basecolor.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    adjDirty = false;
  } catch (e) {
    els.status.textContent = 'РћС€РёР±РєР° СЃРєР°С‡РёРІР°РЅРёСЏ: ' + e;
  } finally {
    els.adjDownload.disabled = false;
  }
});

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
  els.status.textContent = 'Р—Р°РіСЂСѓР·РєР° Рё Р±РµР№РєвЂ¦';
  const t0 = Date.now();
  const timer = setInterval(() => {
    els.status.textContent = 'РџРµС‡С‘РјвЂ¦ ' + ((Date.now() - t0) / 1000).toFixed(0) + ' СЃ';
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
      if (currentRoot && info.low_stats) {
        currentRoot.userData.meshStats = info.low_stats;
        updateMeshStats(currentRoot);
      }
      els.status.textContent =
        'Р“РѕС‚РѕРІРѕ Р·Р° ' + data.seconds + ' СЃ В· РјРµС€РµР№: ' + meshCount +
        (info.texture ? ' В· С‚РµРєСЃС‚СѓСЂР°: ' + info.texture : '');
      els.exportBakedGlb.disabled = false;
      els.exportBakedFbx.disabled = false;
    } else {
      els.status.textContent = 'РћС€РёР±РєР° Р±РµР№РєР°';
      els.log.textContent = data.log || data.error || '';
    }
  } catch (e) {
    clearInterval(timer);
    els.status.textContent = 'РћС€РёР±РєР° Р·Р°РїСЂРѕСЃР°';
    els.log.textContent = String(e);
  } finally {
    updateBakeEnabled();
  }
}

els.bake.addEventListener('click', bake);

els.exportBakedGlb?.addEventListener('click', exportBakedGlb);
els.exportBakedFbx?.addEventListener('click', exportBakedFbx);

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

async function exportBakedGlb() {
  if (!currentRoot) return;
  els.exportBakedGlb.disabled = true;
  els.status.textContent = 'Р­РєСЃРїРѕСЂС‚ GLBвЂ¦';
  try {
    const exporter = new GLTFExporter();
    const glb = await exporter.parseAsync(currentRoot, { binary: true });
    downloadBlob(new Blob([glb], { type: 'model/gltf-binary' }), 'baked_model.glb');
    els.status.textContent = 'GLB СЃРѕС…СЂР°РЅРµРЅ';
  } catch (e) {
    els.status.textContent = 'РћС€РёР±РєР° СЌРєСЃРїРѕСЂС‚Р° GLB: ' + e;
  } finally {
    els.exportBakedGlb.disabled = false;
  }
}

async function exportBakedFbx() {
  if (!currentRoot) return;
  els.exportBakedFbx.disabled = true;
  els.status.textContent = 'Р­РєСЃРїРѕСЂС‚ FBX (Blender)вЂ¦';
  try {
    const exporter = new GLTFExporter();
    const glb = await exporter.parseAsync(currentRoot, { binary: true });
    const r = await fetch('/export-fbx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: glb,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    downloadBlob(blob, 'baked_model.fbx');
    els.status.textContent = 'FBX СЃРѕС…СЂР°РЅРµРЅ';
  } catch (e) {
    els.status.textContent = 'РћС€РёР±РєР° СЌРєСЃРїРѕСЂС‚Р° FBX: ' + e;
  } finally {
    els.exportBakedFbx.disabled = false;
  }
}

let confirmResolve = null;
const elsC = {
  root: document.getElementById('confirm'),
  text: document.getElementById('confirmText'),
  save: document.getElementById('confirmSave'),
  skip: document.getElementById('confirmSkip'),
  cancel: document.getElementById('confirmCancel'),
};
function openConfirm(dirty) {
  if (dirty) {
    elsC.save.hidden = false;
    elsC.text.textContent = 'Р’С‹ РїРµСЂРµС…РѕРґРёС‚Рµ Рє СЃР»РµРґСѓСЋС‰РµРјСѓ РґРµР№СЃС‚РІРёСЋ (РґРµС†РёРјР°С†РёСЏ). Р’ СЃС†РµРЅРµ РµСЃС‚СЊ РЅРµСЃРѕС…СЂР°РЅС‘РЅРЅС‹Рµ РёР·РјРµРЅРµРЅРёСЏ С†РІРµС‚РѕРєРѕСЂСЂРµРєС†РёРё base color. РЎРѕС…СЂР°РЅРёС‚СЊ РїРµСЂРµРґ РїСЂРѕРґРѕР»Р¶РµРЅРёРµРј?';
  } else {
    elsC.save.hidden = true;
    elsC.text.textContent = 'Р’С‹ РїРµСЂРµС…РѕРґРёС‚Рµ Рє СЃР»РµРґСѓСЋС‰РµРјСѓ РґРµР№СЃС‚РІРёСЋ. РўРµРєСѓС‰РёР№ РјРµС€ РІРѕ РІСЊСЋРїРѕСЂС‚Рµ Р±СѓРґРµС‚ Р·Р°РјРµРЅС‘РЅ СЂРµР·СѓР»СЊС‚Р°С‚РѕРј РґРµС†РёРјР°С†РёРё.';
  }
  elsC.root.classList.add('open');
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(v) {
  elsC.root.classList.remove('open');
  if (confirmResolve) { confirmResolve(v); confirmResolve = null; }
}
elsC.save.addEventListener('click', () => closeConfirm('save'));
elsC.skip.addEventListener('click', () => closeConfirm('skip'));
elsC.cancel.addEventListener('click', () => closeConfirm('cancel'));

let decimatedBlob = null;

async function doDecimate() {
  const f = elsD.file.files && elsD.file.files[0];
  console.log('[doDecimate] file', f);
  if (!f) { elsD.status.textContent = 'РІС‹Р±РµСЂРёС‚Рµ С„Р°Р№Р» РјРµС€Р°'; return; }

  const ans = await openConfirm(adjDirty);
  if (ans === 'cancel') return;
  if (ans === 'save') { await saveTexture(); }

  const fd = new FormData();
  fd.append('mesh', f);
  fd.append('mode', elsD.mode.value);
  fd.append('ratio', elsD.ratio.value);
  fd.append('iterations', elsD.iter.value);
  fd.append('angle', elsD.angle.value);
  fd.append('target', elsD.target.value);

  elsD.btn.disabled = true;
  elsD.exportGlb.disabled = true;
  elsD.exportObj.disabled = true;
  const t0 = Date.now();
  elsD.status.textContent = 'Р”РµС†РёРјР°С†РёСЏвЂ¦ 0 СЃ';
  const timer = setInterval(() => {
    elsD.status.textContent = 'Р”РµС†РёРјР°С†РёСЏвЂ¦ ' + ((Date.now() - t0) / 1000).toFixed(0) + ' СЃ';
  }, 500);

  try {
    const r = await fetch('/decimate', { method: 'POST', body: fd });
    clearInterval(timer);
    if (!r.ok) {
      let msg = r.status;
      try { const j = await r.json(); msg = j.error || msg; if (j.log) elsD.status.textContent = msg + '\n' + j.log; } catch {}
      elsD.status.textContent = 'РћС€РёР±РєР° РґРµС†РёРјР°С†РёРё: ' + msg;
      return;
    }
    const info = JSON.parse(r.headers.get('X-Decimate-Info') || '{}');
    const blob = await r.blob();
    decimatedBlob = blob;
    const url = URL.createObjectURL(blob);
    try {
      const gltf = await loader.loadAsync(url);
      const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      if (root) {
        fixTextureColorSpace(root);
        ensureDefaultMaterial(root);
        normalizeImportedMaterials(root);
        if (info.polys_after != null) {
          root.userData.meshStats = { polys: info.polys_after, tris: info.tris_after, verts: info.verts_after };
        }
        setViewportRoot(root, false);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
    elsD.exportGlb.disabled = !decimatedBlob;
    elsD.exportObj.disabled = false;
    adjDirty = false;
    elsD.status.textContent =
      'Р“РѕС‚РѕРІРѕ Р·Р° ' + (info.seconds ?? '?') + ' СЃ В· ' +
      (info.polys_before != null
        ? 'РїРѕР»РёРіРѕРЅРѕРІ: ' + info.polys_before + ' в†’ ' + info.polys_after + ' В· ' : '') +
      'РІРµСЂС€РёРЅ: ' + info.verts_before + ' в†’ ' + info.verts_after + ' В· ' +
      'С‚СЂРµСѓРі.: ' + info.tris_before + ' в†’ ' + info.tris_after;
  } catch (e) {
    clearInterval(timer);
    elsD.status.textContent = 'РћС€РёР±РєР° РґРµС†РёРјР°С†РёРё: ' + e;
  } finally {
    clearInterval(timer);
    elsD.btn.disabled = false;
  }
}

elsD.btn.addEventListener('click', doDecimate);
elsD.exportGlb.addEventListener('click', () => { if (decimatedBlob) downloadBlob(decimatedBlob, 'decimated.glb'); });
elsD.exportObj.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/decimated.obj?t=' + Date.now();
  a.download = 'decimated.obj';
  document.body.appendChild(a); a.click(); a.remove();
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
  depthTest: false,
});
const rigBoneLineMaterial = new THREE.LineBasicMaterial({
  color: 0x22262b,
  depthWrite: false,
  depthTest: false,
});

let rigRoot = null;
const rigBoneObjs = [];
let rigSkelOn = true;
let rigStatic = false;
let rigBindPose = [];

const elsRig = {
  file: document.getElementById('rigFile'),
  name: document.getElementById('rigName'),
  status: document.getElementById('rigStatus'),
  log: document.getElementById('rigLog'),
  skelToggle: document.getElementById('rigSkelToggle'),
  staticToggle: document.getElementById('rigStaticToggle'),
  gridToggle: document.getElementById('rigGridToggle'),
};

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
  resetWeightState();
  rigBindPose = [];
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

function ensureDefaultMaterial(root) {
  const DEFAULT_COLOR = new THREE.Color(0x888888);
  const isDark = (c) => c && (c.r + c.g + c.b) / 3 < 0.15; // luminance < 0.15
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.material) {
      o.material = new THREE.MeshStandardMaterial({
        color: DEFAULT_COLOR, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
      });
      return;
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (isDark(m.color)) m.color.copy(DEFAULT_COLOR);
      if (m.isMeshPhongMaterial) {
        m.specular.setHex(0x111111);
        m.shininess = 30;
      }
      if (m.emissive && isDark(m.emissive)) {
        m.emissive.setHex(0x000000);
      }
      m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
  });
}

function normalizeImportedMaterials(root) {
  root.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.isMeshPhongMaterial) {
        m.specular.setHex(0x111111);
        m.shininess = 30;
      }
      if (m.emissive && !m.emissiveMap && !(m.emissiveIntensity > 0)) {
        m.emissive.setHex(0x000000);
      }
      m.needsUpdate = true;
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

function captureBindPose(root) {
  rigBindPose = [];
  root.traverse((o) => {
    if (o.isBone) {
      rigBindPose.push({
        bone: o,
        pos: o.position.clone(),
        quat: o.quaternion.clone(),
        scale: o.scale.clone(),
      });
    }
  });
}

function restoreBindPose() {
  for (const b of rigBindPose) {
    b.bone.position.copy(b.pos);
    b.bone.quaternion.copy(b.quat);
    b.bone.scale.copy(b.scale);
  }
}

function updateAnimControls() {
  const dis = rigStatic || weightMode;
  elsAnim.play.disabled = dis;
  elsAnim.timeline.disabled = dis;
  elsAnim.clip.disabled = dis;
}

function setStaticMode(v) {
  rigStatic = v;
  updateAnimControls();
  if (v) {
    setPlaying(false);
    if (rigMixer) rigMixer.stopAllAction();
    restoreBindPose();
  } else if (rigAction) {
    rigAction.reset();
    rigAction.play();
    rigAction.paused = true;
    rigAction.time = 0;
    if (rigMixer) rigMixer.update(0);
    syncAnimUi();
  }
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
  if (v && (rigStatic || weightMode)) return;
  rigPlaying = v;
  rigAction.paused = !v;
  elsAnim.play.textContent = v ? 'вЏё' : 'в–¶';
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

const weightMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

const brushRingGeo = new THREE.BufferGeometry();
{
  const pts = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push(Math.cos(a), Math.sin(a), 0);
  }
  brushRingGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
}
const brushCursor = new THREE.LineLoop(
  brushRingGeo,
  new THREE.LineBasicMaterial({ color: 0xffe14d, depthTest: false, depthWrite: false })
);
brushCursor.renderOrder = 1001;
brushCursor.visible = false;
rigGroup.add(brushCursor);

let weightMode = false;
let weightBoneName = '';
let rigFileBase = 'model';
let rigDiag = 1;
let brushRadiusFrac = 0.06;
let brushStrength = 0.15;
let brushMode = 'add';
let painting = false;
let exportingNow = false;
const weightOrigMats = new Map();
const weightOrigColors = new Map();
const weightColorAttrs = new Map();

const elsW = {
  mode: document.getElementById('rigWeightMode'),
  bone: document.getElementById('rigWeightBone'),
  radius: document.getElementById('rigBrushRadius'),
  radiusLabel: document.getElementById('rigBrushRadius_v'),
  strength: document.getElementById('rigBrushStrength'),
  strengthLabel: document.getElementById('rigBrushStrength_v'),
  brushMode: document.getElementById('rigBrushMode'),
  saveWeights: document.getElementById('rigWeightSave'),
  info: document.getElementById('rigWeightInfo'),
  exportGlb: document.getElementById('rigExportGlb'),
  exportFbx: document.getElementById('rigExportFbx'),
  exportStatus: document.getElementById('rigExportStatus'),
};

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const tmpPos = new THREE.Vector3();
const tmpNor = new THREE.Vector3();
const tmpNor2 = new THREE.Vector3();
const tmpMat3 = new THREE.Matrix3();
const tmpColor = new THREE.Color();
const zAxis = new THREE.Vector3(0, 0, 1);

function skinnedMeshes() {
  const out = [];
  if (rigRoot) {
    rigRoot.traverse((o) => {
      if (o.isSkinnedMesh && o.geometry && o.geometry.attributes.skinIndex && o.geometry.attributes.skinWeight) {
        out.push(o);
      }
    });
  }
  return out;
}

function boneIndexFor(mesh) {
  if (!mesh.skeleton || !mesh.skeleton.bones) return -1;
  return mesh.skeleton.bones.findIndex((b) => b.name === weightBoneName);
}

function weightColor(w, out) {
  const t = w < 0 ? 0 : (w > 1 ? 1 : w);
  out.setHSL(((1 - t) * 240) / 360, 1, 0.5);
  return out;
}

function weightOfSlot(mesh, vi, bi) {
  const geo = mesh.geometry;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  let w = 0;
  for (let k = 0; k < 4; k++) {
    if (Math.round(si.getComponent(vi, k)) === bi) w += sw.getComponent(vi, k);
  }
  return w;
}

function brushRadiusWorld() {
  return Math.max(rigDiag * brushRadiusFrac, 1e-6);
}

function updateWeightColors() {
  if (!weightMode) return;
  const c = new THREE.Color();
  for (const m of skinnedMeshes()) {
    const geo = m.geometry;
    const si = geo.attributes.skinIndex;
    const sw = geo.attributes.skinWeight;
    const count = geo.attributes.position.count;
    let col = weightColorAttrs.get(m);
    if (!col || col.count !== count) {
      col = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      weightColorAttrs.set(m, col);
    }
    const bi = boneIndexFor(m);
    for (let i = 0; i < count; i++) {
      let w = 0;
      if (bi >= 0) {
        for (let k = 0; k < 4; k++) {
          if (Math.round(si.getComponent(i, k)) === bi) w += sw.getComponent(i, k);
        }
      }
      weightColor(w, c);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    geo.setAttribute('color', col);
  }
}

function positionBrushCursor(center, normal, radius) {
  tmpPos.copy(center);
  rigGroup.worldToLocal(tmpPos);
  brushCursor.position.copy(tmpPos);
  brushCursor.quaternion.setFromUnitVectors(zAxis, normal);
  brushCursor.scale.setScalar(radius);
  brushCursor.visible = true;
}

function applyBrush(center, normal, radius) {
  const r2 = radius * radius;
  const invRadius = 1 / radius;
  let painted = 0;
  for (const mesh of skinnedMeshes()) {
    const bi = boneIndexFor(mesh);
    if (bi < 0) continue;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const col = weightColorAttrs.get(mesh);
    tmpMat3.getNormalMatrix(mesh.matrixWorld);
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      tmpPos.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const dist2 = tmpPos.distanceToSquared(center);
      if (dist2 > r2) continue;
      if (nor) {
        tmpNor2.fromBufferAttribute(nor, i).applyMatrix3(tmpMat3).normalize();
        if (tmpNor2.dot(normal) < 0) continue;
      }
      const t = 1 - Math.sqrt(dist2) * invRadius;
      const fall = t * t * (3 - 2 * t);
      const old = weightOfSlot(mesh, i, bi);
      const delta = brushStrength * fall;
      let nw = brushMode === 'sub' ? old - delta : old + delta;
      nw = nw < 0 ? 0 : (nw > 1 ? 1 : nw);
      if (setVertexWeight(mesh, i, bi, nw)) {
        if (col) {
          weightColor(weightOfSlot(mesh, i, bi), tmpColor);
          col.setXYZ(i, tmpColor.r, tmpColor.g, tmpColor.b);
        }
        touched = true;
        painted++;
      }
    }
    if (touched && col) col.needsUpdate = true;
  }
  return painted;
}

function paintAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(skinnedMeshes(), false);
  if (!hits.length) {
    brushCursor.visible = false;
    return;
  }
  const hit = hits[0];
  tmpNor.set(0, 0, 1);
  if (hit.face) tmpNor.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
  const radius = brushRadiusWorld();
  positionBrushCursor(hit.point, tmpNor, radius);
  if (!painting) return;
  if (applyBrush(hit.point, tmpNor, radius) > 0) updateWeightInfo();
}

function setVertexWeight(mesh, vi, bi, w) {
  const geo = mesh.geometry;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  if (!si || !sw || bi < 0) return false;
  const idx = [si.getComponent(vi, 0), si.getComponent(vi, 1), si.getComponent(vi, 2), si.getComponent(vi, 3)];
  const wts = [sw.getComponent(vi, 0), sw.getComponent(vi, 1), sw.getComponent(vi, 2), sw.getComponent(vi, 3)];
  let slot = idx.findIndex((n) => Math.round(n) === bi);
  let inserted = false;
  if (slot < 0) {
    if (w <= 0) return false;
    slot = wts.findIndex((x) => x < 1e-5);
    if (slot < 0) {
      slot = 0;
      for (let k = 1; k < 4; k++) if (wts[k] < wts[slot]) slot = k;
    }
    idx[slot] = bi;
    inserted = true;
  }
  wts[slot] = w;
  let otherSum = 0;
  for (let k = 0; k < 4; k++) if (k !== slot) otherSum += wts[k];
  if (otherSum > 1e-6) {
    const rest = (1 - w) / otherSum;
    for (let k = 0; k < 4; k++) if (k !== slot) wts[k] *= rest;
  }
  const sum = wts[0] + wts[1] + wts[2] + wts[3];
  if (sum > 1e-6) {
    for (let k = 0; k < 4; k++) wts[k] /= sum;
  }
  if (inserted) {
    for (let k = 0; k < 4; k++) si.setComponent(vi, k, idx[k]);
    si.needsUpdate = true;
  }
  for (let k = 0; k < 4; k++) sw.setComponent(vi, k, wts[k]);
  sw.needsUpdate = true;
  return true;
}

function normalizeAllWeights() {
  let changed = 0;
  for (const m of skinnedMeshes()) {
    const sw = m.geometry.attributes.skinWeight;
    if (!sw) continue;
    const count = m.geometry.attributes.position.count;
    for (let i = 0; i < count; i++) {
      const w0 = sw.getComponent(i, 0);
      const w1 = sw.getComponent(i, 1);
      const w2 = sw.getComponent(i, 2);
      const w3 = sw.getComponent(i, 3);
      const sum = w0 + w1 + w2 + w3;
      if (sum > 1e-6 && Math.abs(sum - 1) > 1e-4) {
        sw.setComponent(i, 0, w0 / sum);
        sw.setComponent(i, 1, w1 / sum);
        sw.setComponent(i, 2, w2 / sum);
        sw.setComponent(i, 3, w3 / sum);
        changed++;
      }
    }
    sw.needsUpdate = true;
  }
  updateWeightColors();
  return changed;
}

function applyWeightVisuals(on) {
  const sm = skinnedMeshes();
  if (on) {
    for (const m of sm) {
      if (!weightOrigMats.has(m)) weightOrigMats.set(m, m.material);
      if (!weightOrigColors.has(m)) weightOrigColors.set(m, m.geometry.attributes.color || null);
      m.material = weightMat;
    }
  } else {
    for (const [m, mat] of weightOrigMats) {
      m.material = mat;
      const orig = weightOrigColors.get(m);
      if (orig) m.geometry.setAttribute('color', orig);
      else m.geometry.deleteAttribute('color');
    }
    weightOrigMats.clear();
    weightOrigColors.clear();
  }
}

function populateBoneSelect() {
  const names = [];
  for (const m of skinnedMeshes()) {
    if (!m.skeleton) continue;
    for (const b of m.skeleton.bones) {
      if (b.name && !names.includes(b.name)) names.push(b.name);
    }
  }
  const prev = weightBoneName;
  weightBoneName = names.includes(prev) ? prev : (names[0] || '');
  elsW.bone.innerHTML = '';
  const list = names.length ? names : ['вЂ”'];
  for (const n of list) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    elsW.bone.appendChild(opt);
  }
  if (names.length) elsW.bone.value = weightBoneName;
}

function updateWeightInfo() {
  let text = '';
  if (!weightMode) {
    text = 'РІРєР»СЋС‡РёС‚Рµ СЂРµР¶РёРј РІРµСЃРѕРІ Рё РІС‹Р±РµСЂРёС‚Рµ РєРѕСЃС‚СЊ вЂ” Р·Р°С‚РµРј РІРµРґРёС‚Рµ РїРѕ РјРѕРґРµР»Рё СЃ Р·Р°Р¶Р°С‚РѕР№ Р›РљРњ';
  } else if (!rigRoot) {
    text = 'РјРѕРґРµР»СЊ РЅРµ Р·Р°РіСЂСѓР¶РµРЅР°';
  } else if (!skinnedMeshes().length) {
    text = 'РІ РјРѕРґРµР»Рё РЅРµС‚ SkinnedMesh вЂ” РІРµСЃР° РЅРµРґРѕСЃС‚СѓРїРЅС‹';
  } else {
    text = 'РєРѕСЃС‚СЊ: ' + (weightBoneName || 'вЂ”') +
      ' В· РєРёСЃС‚СЊ: СЂР°Рґ. ' + Math.round(brushRadiusFrac * 100) + ' %' +
      ' В· СЃРёР»Р° ' + Math.round(brushStrength * 100) + ' %' +
      ' В· СЂРµР¶РёРј: ' + (brushMode === 'sub' ? 'РІС‹С‡РµСЃС‚СЊ' : 'РґРѕР±Р°РІРёС‚СЊ');
  }
  elsW.info.textContent = text;
}

function refreshWeightUi() {
  const sm = rigRoot ? skinnedMeshes() : [];
  const dis = !weightMode || sm.length === 0;
  elsW.bone.disabled = dis;
  elsW.radius.disabled = dis;
  elsW.strength.disabled = dis;
  elsW.brushMode.disabled = dis;
  elsW.saveWeights.disabled = dis;
  updateWeightInfo();
}

function resetWeightState() {
  weightBoneName = '';
  painting = false;
  brushCursor.visible = false;
  weightOrigMats.clear();
  weightOrigColors.clear();
  weightColorAttrs.clear();
  elsW.bone.innerHTML = '';
  const opt = document.createElement('option');
  opt.textContent = 'вЂ”';
  elsW.bone.appendChild(opt);
  elsW.bone.disabled = true;
  elsW.radius.disabled = true;
  elsW.strength.disabled = true;
  elsW.brushMode.disabled = true;
  elsW.saveWeights.disabled = true;
  elsW.exportGlb.disabled = true;
  elsW.exportFbx.disabled = true;
  elsW.exportStatus.textContent = '';
  updateWeightInfo();
}

function setBrushControls(on) {
  if (on) {
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  } else {
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
  }
}

function setWeightMode(v) {
  if (v === weightMode) return;
  weightMode = v;
  elsW.mode.checked = v;
  setBrushControls(v);
  if (v) {
    setPlaying(false);
    if (rigMixer) rigMixer.stopAllAction();
    restoreBindPose();
    elsRig.staticToggle.disabled = true;
    applyWeightVisuals(true);
    populateBoneSelect();
    updateWeightColors();
    elsW.exportStatus.textContent = '';
  } else {
    applyWeightVisuals(false);
    painting = false;
    brushCursor.visible = false;
    elsRig.staticToggle.disabled = false;
    if (!rigStatic) setStaticMode(false);
  }
  updateAnimControls();
  refreshWeightUi();
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!weightMode || currentRoom !== 'rig' || e.button !== 0) return;
  painting = true;
  paintAt(e);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!weightMode || currentRoom !== 'rig') return;
  paintAt(e);
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  painting = false;
});

renderer.domElement.addEventListener('pointerleave', () => {
  painting = false;
  brushCursor.visible = false;
});

elsW.mode.addEventListener('change', () => setWeightMode(elsW.mode.checked));

elsW.bone.addEventListener('change', () => {
  weightBoneName = elsW.bone.value;
  updateWeightColors();
  updateWeightInfo();
});

elsW.radius.addEventListener('input', () => {
  brushRadiusFrac = (parseFloat(elsW.radius.value) || 1) / 100;
  elsW.radiusLabel.textContent = elsW.radius.value + ' %';
  updateWeightInfo();
});

elsW.strength.addEventListener('input', () => {
  brushStrength = (parseFloat(elsW.strength.value) || 1) / 100;
  elsW.strengthLabel.textContent = elsW.strength.value + ' %';
  updateWeightInfo();
});

elsW.brushMode.addEventListener('change', () => {
  brushMode = elsW.brushMode.value;
  updateWeightInfo();
});

elsW.saveWeights?.addEventListener('click', async () => {
  if (!rigRoot) return;
  const wasDisabled = elsW.saveWeights.disabled;
  elsW.saveWeights.disabled = true;
  elsW.info.textContent = 'Применение весов (GLB)...';
  try {
    // Автонормализация весов перед применением (кнопка «Нормализовать всё» удалена)
    const normChanged = normalizeAllWeights();
    const buf = await buildGlbBuffer();
    const name = (rigFileBase || 'rig') + '_weights.glb';
    downloadBlob(new Blob([buf], { type: 'model/gltf-binary' }), name);
    elsW.info.textContent = 'Веса применены: ' + name +
      (normChanged > 0 ? ' · нормализовано вершин: ' + normChanged : '');
  } catch (e) {
    elsW.info.textContent = 'Ошибка применения весов: ' + (e && e.message ? e.message : e);
  } finally {
    elsW.saveWeights.disabled = wasDisabled;
  }
});

function detachBoneVisuals() {
  const out = [];
  for (const o of rigBoneObjs) {
    if (o.parent) {
      out.push([o, o.parent]);
      o.parent.remove(o);
    }
  }
  return out;
}

function reattachBoneVisuals(list) {
  for (const item of list) item[1].add(item[0]);
}

function buildGlbBuffer() {
  const detached = detachBoneVisuals();
  const wasWeight = weightMode;
  if (wasWeight) applyWeightVisuals(false);
  const exporter = new GLTFExporter();
  const opts = { binary: true };
  if (rigClips && rigClips.length) opts.animations = rigClips;
  return exporter.parseAsync(rigRoot, opts).finally(() => {
    if (wasWeight) {
      applyWeightVisuals(true);
      updateWeightColors();
    }
    reattachBoneVisuals(detached);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function doExportGlb() {
  if (!rigRoot || exportingNow) return;
  exportingNow = true;
  elsW.exportGlb.disabled = true;
  elsW.exportFbx.disabled = true;
  elsW.exportStatus.textContent = 'Р­РєСЃРїРѕСЂС‚ GLBвЂ¦';
  try {
    const buf = await buildGlbBuffer();
    downloadBlob(new Blob([buf], { type: 'model/gltf-binary' }), rigFileBase + '.glb');
    elsW.exportStatus.textContent = 'GLB СЃРѕС…СЂР°РЅС‘РЅ: ' + rigFileBase + '.glb';
  } catch (e) {
    elsW.exportStatus.textContent = 'РћС€РёР±РєР° СЌРєСЃРїРѕСЂС‚Р° GLB: ' + (e && e.message ? e.message : e);
  } finally {
    exportingNow = false;
    elsW.exportGlb.disabled = !rigRoot;
    elsW.exportFbx.disabled = !rigRoot;
  }
}

async function doExportFbx() {
  if (!rigRoot || exportingNow) return;
  exportingNow = true;
  elsW.exportGlb.disabled = true;
  elsW.exportFbx.disabled = true;
  elsW.exportStatus.textContent = 'Р­РєСЃРїРѕСЂС‚ GLBвЂ¦';
  try {
    const buf = await buildGlbBuffer();
    elsW.exportStatus.textContent = 'РљРѕРЅРІРµСЂС‚Р°С†РёСЏ РІ FBX (Blender)вЂ¦';
    const r = await fetch('/export-fbx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    const blob = await r.blob();
    downloadBlob(blob, rigFileBase + '.fbx');
    elsW.exportStatus.textContent = 'FBX СЃРѕС…СЂР°РЅС‘РЅ: ' + rigFileBase + '.fbx';
  } catch (e) {
    elsW.exportStatus.textContent = 'РћС€РёР±РєР° СЌРєСЃРїРѕСЂС‚Р° FBX: ' + (e && e.message ? e.message : e);
  } finally {
    exportingNow = false;
    elsW.exportGlb.disabled = !rigRoot;
    elsW.exportFbx.disabled = !rigRoot;
  }
}

elsW.exportGlb.addEventListener('click', doExportGlb);
elsW.exportFbx.addEventListener('click', doExportFbx);

function onRigLoaded(file) {
  const base = (file && file.name ? file.name : '').replace(/\.[^.]+$/, '');
  rigFileBase = base || 'model';
  const box = new THREE.Box3().setFromObject(rigRoot);
  const size = box.getSize(new THREE.Vector3());
  rigDiag = Math.max(size.x, size.y, size.z) || 1;
  elsW.exportGlb.disabled = false;
  elsW.exportFbx.disabled = false;
  elsW.exportStatus.textContent = '';
  if (weightMode) {
    elsW.mode.checked = true;
    if (rigMixer) rigMixer.stopAllAction();
    restoreBindPose();
    applyWeightVisuals(true);
    populateBoneSelect();
    updateWeightColors();
  }
  refreshWeightUi();
}

async function loadRigFile(file) {
  clearRig();
  elsRig.log.textContent = '';
  elsRig.status.textContent = 'Р—Р°РіСЂСѓР·РєР° РјРѕРґРµР»РёвЂ¦';
  const url = URL.createObjectURL(file);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    let root;
    let clips = [];
    if (ext === 'fbx') {
      root = await new FBXLoader().loadAsync(url);
      // Apply FBX unit scale factor
      const scale = root.userData?.unitScaleFactor ?? 1;
      if (scale !== 1) {
        root.scale.setScalar(scale);
        console.log('[loadRigFile] applied FBX unitScaleFactor:', scale);
      }
      clips = root.animations || [];
    } else {
      const gltf = await loader.loadAsync(url);
      root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      clips = gltf.animations || [];
    }
    if (!root) throw new Error('РјРѕРґРµР»СЊ РЅРµ РЅР°Р№РґРµРЅР° РІ С„Р°Р№Р»Рµ');
fixTextureColorSpace(root);
    ensureDefaultMaterial(root);
    // Replace all materials with proper MeshStandardMaterial for consistent lighting
    console.log('[loadRigFile] replacing materials, procRT:', !!procRT);
    root.traverse((o) => {
      if (o.isMesh) {
        console.log('[loadRigFile] replacing material for:', o.name, 'old:', o.material?.type);
        const mat = new THREE.MeshStandardMaterial({
          color: 0x888888, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
        });
        o.material = mat;
        console.log('[loadRigFile] new material:', o.material.type, 'color:', o.material.color.getHexString());
      }
    });
normalizeImportedMaterials(root);
    rigRoot = root;
    rigGroup.add(root);
    let meshCount = 0;
    root.traverse((o) => { if (o.isMesh) meshCount++; });
    console.log('[loadRigFile] rigGroup children:', rigGroup.children.length, 'root children:', root.children.length);
    root.traverse((o) => { if (o.isMesh) console.log('[loadRigFile] mesh:', o.name, 'material:', o.material?.type, 'color:', o.material?.color?.getHexString(), 'visible:', o.visible); });
    const skel = buildRigSkeleton(root);
    captureBindPose(root);
    setupAnimations(root, clips);
    if (rigStatic) setStaticMode(true);
    frameObject(root);
    updateMeshStats(root);
    console.log('[loadRigFile] after frameObject, camera:', camera.position.clone(), 'target:', controls.target.clone(), 'root pos:', root.position.clone());
    let msg = 'РњРѕРґРµР»СЊ Р·Р°РіСЂСѓР¶РµРЅР° В· РјРµС€РµР№: ' + meshCount;
    if (skel.bones > 0) msg += ' В· РєРѕСЃС‚РµР№: ' + skel.bones + ' В· СЃРµРіРјРµРЅС‚РѕРІ: ' + skel.segments;
    else msg += ' В· СЃРєРµР»РµС‚ РЅРµ РЅР°Р№РґРµРЅ';
    if (clips.length) msg += ' В· Р°РЅРёРјР°С†РёР№: ' + clips.length;
    elsRig.status.textContent = msg;
    onRigLoaded(file);
  } catch (e) {
    clearRig();
    elsRig.status.textContent = 'РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё: ' + (e && e.message ? e.message : e);
    elsRig.log.textContent = String((e && e.stack) || e);
  } finally {
    URL.revokeObjectURL(url);
  }
}

bindFile(elsRig.file, elsRig.name, 'РІС‹Р±СЂР°С‚СЊвЂ¦');

elsRig.file.addEventListener('change', () => {
  const f = elsRig.file.files && elsRig.file.files[0];
  if (f) loadRigFile(f);
});

elsRig.skelToggle.addEventListener('change', () => {
  rigSkelOn = elsRig.skelToggle.checked;
  setRigBonesVisible(rigSkelOn);
});

elsRig.staticToggle.addEventListener('change', () => {
  setStaticMode(elsRig.staticToggle.checked);
});

elsRig.gridToggle.addEventListener('change', () => {
  setGridVisible(elsRig.gridToggle.checked);
});

const tabs = document.querySelectorAll('.tab');
const bakePanelEl = document.getElementById('bakePanel');
const decPanelEl = document.getElementById('decPanel');
const rigPanelEl = document.getElementById('rigPanel');

function switchRoom(name) {
  currentRoom = name;
  for (const t of tabs) t.classList.toggle('active', t.dataset.room === name);
  bakePanelEl.hidden = name !== 'bake';
  decPanelEl.hidden = name !== 'decimate';
  rigPanelEl.hidden = name !== 'rig';
  if (currentRoot) currentRoot.visible = name === 'bake' || name === 'decimate';
  rigGroup.visible = name === 'rig';
  if (name !== 'rig') {
    painting = false;
    brushCursor.visible = false;
  }
  elsAnim.player.hidden = !(name === 'rig' && rigClips.length > 0);
  if (name !== 'rig' && rigPlaying) setPlaying(false);
  if (name === 'bake' && currentRoot) frameObject(currentRoot);
  if (name === 'decimate' && currentRoot) frameObject(currentRoot);
  if (name === 'rig') {
    elsRig.gridToggle.checked = sceneGrid.visible;
    if (rigRoot) frameObject(rigRoot);
  }
  updateMeshStats(name === 'rig' ? rigRoot : currentRoot);
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

