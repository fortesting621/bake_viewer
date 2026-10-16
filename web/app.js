import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const view = document.getElementById('view');

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

const loader = new GLTFLoader();
let material = null;
let currentRoot = null;
let texVersion = Date.now();
let modelVersion = Date.now();

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
        currentRoot.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      }
      currentRoot = root;
      scene.add(root);
      buildWires(root);
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

(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
})();

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
