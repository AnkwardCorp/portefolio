import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

if (window.matchMedia('(pointer: coarse)').matches) {
  document.getElementById('toc').style.display = 'none';
}

const GrainShader = {
  uniforms: {
    tDiffuse:  { value: null },
    time:      { value: 0.0 },
    intensity: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float intensity;
    varying vec2 vUv;
    float random(vec2 co) {
      return fract(sin(dot(co + time, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float grain = (random(vUv) - 0.5) * intensity;
      gl_FragColor = vec4(color.rgb + grain, color.a);
    }
  `,
};

// ── Constantes ────────────────────────────────────────────────────────────────

const CORNER_RADIUS        = 0.04;
const FADE_DURATION        = 0.6;
const STAGGER_TOTAL        = 1.5;
const NOISE_FREQ           = 0.4;
const SLERP_SPEED          = 2.5;  // vitesse de rotation sphère vers la cible
const WHEEL_THRESHOLD      = 80;
const TOUCH_THRESHOLD      = 40;
const SELECTED_SCALE_BOOST = 0.80;
const HOVER_SCALE_BOOST    = 1.09;

const INTRO_LINE_DURATION  = 0.07;
const INTRO_SPRITE_FADE    = 0.08;

// ── Utilitaire texture arrondie ───────────────────────────────────────────────

function loadRoundedTexture(path, onReady) {
  const img = new Image();
  img.onload = () => {
    const aspect = img.naturalWidth / img.naturalHeight;
    const h   = 256;
    const w   = Math.round(h * aspect);
    const r   = h * CORNER_RADIUS;
    const cvs = document.createElement('canvas');
    cvs.width  = w;
    cvs.height = h;
    const ctx = cvs.getContext('2d');
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.arcTo(w, 0,   w, r,       r);
    ctx.lineTo(w, h - r);
    ctx.arcTo(w, h,   w - r, h,   r);
    ctx.lineTo(r, h);
    ctx.arcTo(0, h,   0, h - r,   r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0,   r, 0,       r);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, w, h);
    ctx.restore();
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    onReady?.(tex, aspect);
  };
  img.onerror = () => onReady?.(null, 1);
  img.src = path;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

// ── Dark mode ─────────────────────────────────────────────────────────────────

let isDark = localStorage.getItem('darkMode') === 'true';
function applyDark(dark) {
  document.body.classList.toggle('dark', dark);
  document.getElementById('theme-toggle').textContent = dark ? '☀' : '☽';
}
applyDark(isDark);
document.getElementById('theme-toggle').addEventListener('click', () => {
  isDark = !isDark;
  localStorage.setItem('darkMode', isDark);
  const overlay = document.getElementById('theme-fade');
  overlay.style.background = isDark ? '#000' : '#fff';
  overlay.style.opacity = '1';
  setTimeout(() => { applyDark(isDark); overlay.style.opacity = '0'; }, 250);
});

// ── Caméra & composer ─────────────────────────────────────────────────────────

let camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);

let renderPass = new RenderPass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(renderPass);
const grainPass = new ShaderPass(GrainShader);
grainPass.enabled = false;
composer.addPass(grainPass);

function resizeCamera(cam) {
  const aspect = window.innerWidth / window.innerHeight;
  if (cam.isPerspectiveCamera) {
    cam.aspect = aspect;
  } else if (cam.isOrthographicCamera) {
    const halfH = (cam.top - cam.bottom) / 2;
    cam.left  = -halfH * aspect;
    cam.right =  halfH * aspect;
  }
  cam.updateProjectionMatrix();
}

window.addEventListener('resize', () => {
  resizeCamera(camera);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ── Groupe sphère ─────────────────────────────────────────────────────────────

const group = new THREE.Group();
scene.add(group);

// ── État ──────────────────────────────────────────────────────────────────────

let entries           = [];
let lineEntries       = [];
let introLineDuration = INTRO_LINE_DURATION;
let introLinesEndTime = Infinity;
let sorted      = [];

// ── Hand tracking ──────────────────────────────────────────────────────────────
let handLandmarker  = null;
let handVideoEl     = null;
let handPreviewEl   = null;
let handCanvasEl    = null;
let handSkelCtx     = null;
let prevHandX       = null;
let prevHandY       = null;
let smoothHandX     = null;
let smoothHandY     = null;
let handVelX        = 0;
let handVelY        = 0;
let handDetected    = false;
let lastHandDetectTime = 0;
const HAND_DETECT_INTERVAL = 1000 / 20; // 20 fps
let previewDragging   = false;
let _previewMouseMove = null;
let _previewMouseUp   = null;
let previewResizing   = false;
let _resizeMouseMove  = null;
let _resizeMouseUp    = null;


// Détection de la pince : pouce (4) et index (8) proches l'un de l'autre, normalisé par la taille de la main
function isPinch(landmarks) {
  const thumbTip  = landmarks[4];
  const indexTip  = landmarks[8];
  const wrist     = landmarks[0];
  const middleMcp = landmarks[9];
  const handSize  = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
  const dist      = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
  return handSize > 0.01 && dist / handSize < 0.4;
}

async function initHandTracking() {
  // Prévisualisation webcam (coin bas-droit, miroir, noir et blanc)
  handPreviewEl = document.createElement('div');
  handPreviewEl.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:20;border-radius:10px;overflow:hidden;width:200px;opacity:0.85;box-shadow:0 2px 16px rgba(0,0,0,0.5);background:#111;';
  handVideoEl = document.createElement('video');
  handVideoEl.style.cssText = 'width:200px;display:block;transform:scaleX(-1);filter:grayscale(1);visibility:hidden;';
  handVideoEl.autoplay = true;
  handVideoEl.playsInline = true;
  handPreviewEl.appendChild(handVideoEl);

  // Canvas squelette (pas de transform CSS — on miroir les x dans le dessin)
  handCanvasEl = document.createElement('canvas');
  handCanvasEl.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  handCanvasEl.width  = 200;
  handCanvasEl.height = 150;
  handPreviewEl.appendChild(handCanvasEl);
  handSkelCtx = handCanvasEl.getContext('2d');
  handVideoEl.addEventListener('loadedmetadata', () => {
    const h = Math.round(200 * handVideoEl.videoHeight / handVideoEl.videoWidth);
    handCanvasEl.width  = 200;
    handCanvasEl.height = h;
    handCanvasEl.style.width  = '200px';
    handCanvasEl.style.height = h + 'px';
  });

  // Indicateur "main détectée"
  const dot = document.createElement('div');
  dot.id = 'hand-dot';
  dot.style.cssText = 'position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#888;transition:background 0.2s;';
  handPreviewEl.appendChild(dot);

  // Bouton bascule vidéo/squelette (vidéo visible par défaut)
  let videoVisible = true;
  handVideoEl.style.visibility  = 'visible';
  handPreviewEl.style.background = 'transparent';
  const vidToggleBtn = document.createElement('button');
  vidToggleBtn.style.cssText = 'position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;font-size:10px;padding:2px 6px;cursor:pointer;z-index:2;line-height:1.4;';
  vidToggleBtn.textContent = '◎ squelette';
  vidToggleBtn.title = 'Afficher/masquer la vidéo';
  vidToggleBtn.addEventListener('click', () => {
    videoVisible = !videoVisible;
    handVideoEl.style.visibility  = videoVisible ? 'visible' : 'hidden';
    handPreviewEl.style.background = videoVisible ? 'transparent' : '#111';
    vidToggleBtn.textContent = videoVisible ? '◎ squelette' : '◉ vidéo';
  });
  handPreviewEl.appendChild(vidToggleBtn);

  document.body.appendChild(handPreviewEl);

  // Drag-and-drop sur la fenêtre prévisualisation
  let previewDragOffX = 0, previewDragOffY = 0;
  handPreviewEl.style.cursor = 'grab';

  handPreviewEl.addEventListener('mousedown', (e) => {
    if (e.target === vidToggleBtn) return;
    previewDragging = true;
    const rect = handPreviewEl.getBoundingClientRect();
    previewDragOffX = e.clientX - rect.left;
    previewDragOffY = e.clientY - rect.top;
    handPreviewEl.style.bottom = '';
    handPreviewEl.style.right  = '';
    handPreviewEl.style.top    = rect.top  + 'px';
    handPreviewEl.style.left   = rect.left + 'px';
    handPreviewEl.style.cursor = 'grabbing';
    e.stopPropagation();
  });

  _previewMouseMove = (e) => {
    if (!previewDragging) return;
    const x = Math.max(0, Math.min(window.innerWidth  - 200, e.clientX - previewDragOffX));
    const y = Math.max(0, Math.min(window.innerHeight -  60, e.clientY - previewDragOffY));
    handPreviewEl.style.left = x + 'px';
    handPreviewEl.style.top  = y + 'px';
  };

  _previewMouseUp = () => {
    if (!previewDragging) return;
    previewDragging = false;
    handPreviewEl.style.cursor = 'grab';
  };

  window.addEventListener('mousemove', _previewMouseMove);
  window.addEventListener('mouseup',   _previewMouseUp);

  // Redimensionnement de la fenêtre prévisualisation
  const MIN_PREVIEW_W = 120, MAX_PREVIEW_W = 480;
  let resizeStartX = 0, resizeStartW = 200;

  function applyPreviewWidth(w) {
    w = Math.max(MIN_PREVIEW_W, Math.min(MAX_PREVIEW_W, w));
    const ratio = handVideoEl.videoWidth > 0 ? handVideoEl.videoHeight / handVideoEl.videoWidth : 0.75;
    const h = Math.round(w * ratio);
    handPreviewEl.style.width = w + 'px';
    handVideoEl.style.width   = w + 'px';
    handCanvasEl.width        = w;
    handCanvasEl.height       = h;
    handCanvasEl.style.width  = w + 'px';
    handCanvasEl.style.height = h + 'px';
  }

  const resizeHandle = document.createElement('div');
  resizeHandle.style.cssText = 'position:absolute;bottom:0;right:0;width:20px;height:20px;cursor:nwse-resize;z-index:3;display:flex;align-items:flex-end;justify-content:flex-end;padding:4px;box-sizing:border-box;';
  resizeHandle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 9L9 2M5 9L9 5" stroke="rgba(255,255,255,0.45)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  handPreviewEl.appendChild(resizeHandle);

  resizeHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    previewResizing = true;
    resizeStartX = e.clientX;
    resizeStartW = handPreviewEl.getBoundingClientRect().width;
    handPreviewEl.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
  });

  _resizeMouseMove = (e) => {
    if (!previewResizing) return;
    applyPreviewWidth(resizeStartW + (e.clientX - resizeStartX));
  };

  _resizeMouseUp = () => {
    if (!previewResizing) return;
    previewResizing = false;
    handPreviewEl.style.cursor = 'grab';
    document.body.style.userSelect = '';
  };

  window.addEventListener('mousemove', _resizeMouseMove);
  window.addEventListener('mouseup',   _resizeMouseUp);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 24, max: 24 } } });
    handVideoEl.srcObject = stream;
  } catch (e) {
    console.warn('[hand_vision] Caméra non disponible:', e);
    return;
  }

  const { HandLandmarker, FilesetResolver } = await import(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
  );
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 1,
  });
}

let handTrackingActive = false;

function stopHandTracking() {
  if (handVideoEl?.srcObject) {
    handVideoEl.srcObject.getTracks().forEach(t => t.stop());
    handVideoEl.srcObject = null;
  }
  handLandmarker = null;
  handPreviewEl?.remove();
  handPreviewEl = null;
  handVideoEl   = null;
  handCanvasEl  = null;
  handSkelCtx   = null;
  prevHandX = prevHandY = smoothHandX = smoothHandY = null;
  handVelX = handVelY = 0;
  handDetected = false;
  if (_previewMouseMove) { window.removeEventListener('mousemove', _previewMouseMove); _previewMouseMove = null; }
  if (_previewMouseUp)   { window.removeEventListener('mouseup',   _previewMouseUp);   _previewMouseUp   = null; }
  if (_resizeMouseMove)  { window.removeEventListener('mousemove', _resizeMouseMove);  _resizeMouseMove  = null; }
  if (_resizeMouseUp)    { window.removeEventListener('mouseup',   _resizeMouseUp);    _resizeMouseUp    = null; }
  previewDragging = false;
  previewResizing = false;
  document.body.style.userSelect = '';
}

const camToggleBtn = document.getElementById('cam-toggle');
camToggleBtn.addEventListener('click', async () => {
  if (!handTrackingActive) {
    handTrackingActive = true;
    camToggleBtn.textContent = '⦿ hand tracking';
    camToggleBtn.classList.add('cam-on');
    try {
      await initHandTracking();
    } catch (err) {
      console.warn('[hand_vision] Hand tracking init failed:', err);
      handTrackingActive = false;
      camToggleBtn.textContent = '○ hand tracking';
      camToggleBtn.classList.remove('cam-on');
    }
  } else {
    stopHandTracking();
    handTrackingActive = false;
    camToggleBtn.textContent = '○ hand tracking';
    camToggleBtn.classList.remove('cam-on');
  }
});
let fadeList          = [];
let switchFadeOutList = [];
let switchFadeOutCallback = null;
let snapIndex   = 0;
let spriteSize  = 1;
let noiseAmp    = 0.01;
let cameraDir   = new THREE.Vector3(0, 0, 1);
let targetGroupQuat = new THREE.Quaternion();
let elapsed     = 0;
let hoverScale  = 1.0;
let isHoveringSelected = false;
let wheelAccum  = 0;
let isDragging   = false;
let dragMoved    = false;
let lastDragX    = 0;
let lastDragY    = 0;
let dragVelX     = 0;   // rad/s autour de X monde (pendant/après drag)
let dragVelY     = 0;   // rad/s autour de Y monde
let lastMoveTime = 0;
let isCoasting   = false;

const DRAG_SENSITIVITY   = 0.004; // rad/px
const INERTIA_DAMPING    = 5;     // décroissance exponentielle (plus haut = stop plus vite)
const SNAP_VEL_THRESHOLD = 0.06;  // rad/s en dessous duquel on snape
const MAX_DRAG_VEL       = 12;    // rad/s max pour éviter les rotations folles

const HAND_SMOOTH        = 0.15;  // EMA alpha : 0 = figé, 1 = brut (plus bas = plus smooth)
const HAND_SENSITIVITY   = 4;     // amplification de la rotation par mouvement de main
const HAND_MAX_DELTA     = 0.03;  // déplacement normalisé max accepté par frame (anti-saut)
const HAND_BRAKE_SPEED   = 18;    // vitesse de freinage au poing (plus haut = stop plus vite)

// ── Utilitaires UI ────────────────────────────────────────────────────────────

const _typingTimers = new Map();

function typeText(el, text, interval = 18) {
  if (_typingTimers.has(el)) clearInterval(_typingTimers.get(el));
  el.textContent = '';
  const words = text.split(' ');
  let i = 0;
  const timer = setInterval(() => {
    el.textContent += (i === 0 ? '' : ' ') + words[i++];
    if (i >= words.length) { clearInterval(timer); _typingTimers.delete(el); }
  }, interval);
  _typingTimers.set(el, timer);
}

function updateToc() {
  document.querySelectorAll('.toc-item').forEach((el, i) => el.classList.toggle('active', i === snapIndex));
}

function updateUI() {
  if (sorted.length === 0) return;
  const { project } = sorted[snapIndex];
  document.getElementById('sprite-name').textContent = project.name;
  typeText(document.querySelector('#info-right .desc-body'), project.description);
  typeText(document.getElementById('info-client'), project.client || '//');
  typeText(document.getElementById('info-owner'),  project.owner  || '—');
  typeText(document.getElementById('info-tech'),   project.tech   || '—');
  const linkEl = document.getElementById('project-link');
  linkEl.href        = project.link || '#';
  linkEl.style.display = project.link ? 'inline' : 'none';
  updateToc();
}

// ── Navigation snap ───────────────────────────────────────────────────────────


function advanceSnap(steps) {
  const n = sorted.length;
  if (n === 0) return;
  isCoasting = false;
  snapIndex = ((snapIndex + steps) % n + n) % n;
  // Rotation : amener le vertex sélectionné face à la caméra
  targetGroupQuat.setFromUnitVectors(sorted[snapIndex].localDir, cameraDir);
  updateUI();
}



// ── Changement de dataset (gallery menu) ──────────────────────────────────────

async function switchDataset(url) {
  if (entries.length === 0) return;
  const projects = await fetch(url).then(r => r.json()).catch(() => []);
  if (!projects.length) return;

  entries.forEach((entry, i) => {
    const project = projects[i % projects.length];
    entry.project = project;
    entry.loadAlpha = 0;
    if (entry.mat.map) { entry.mat.map.dispose(); entry.mat.map = null; }
    loadRoundedTexture(project.image, (tex, aspect) => {
      entry.aspect = aspect;
      if (tex) { entry.mat.map = tex; entry.mat.needsUpdate = true; }
    });
    fadeList.push({ entry, delay: elapsed });
  });

  snapIndex = 0;
  if (sorted.length > 0) {
    targetGroupQuat.setFromUnitVectors(sorted[0].localDir, cameraDir);
  }

  const tocEl = document.getElementById('toc');
  tocEl.innerHTML = '';
  sorted.forEach((entry, i) => {
    const item = document.createElement('div');
    item.className = 'toc-item';
    item.textContent = `${i + 1} — ${entry.project.name}`;
    item.addEventListener('click', () => {
      const n = sorted.length;
      const fwd  = ((i - snapIndex) % n + n) % n;
      const back = ((snapIndex - i) % n + n) % n;
      advanceSnap(fwd <= back ? fwd : -back);
    });
    tocEl.appendChild(item);
  });

  updateUI();
}

function fadeOutThenSwitch(url) {
  const FADE_OUT = 0.35;
  fadeList = fadeList.filter(f => !entries.includes(f.entry));
  switchFadeOutList = entries.map(entry => ({
    entry,
    startAlpha: entry.loadAlpha,
    startTime: elapsed,
    duration: FADE_OUT,
  }));
  switchFadeOutCallback = () => switchDataset(url);
}

document.querySelectorAll('.gallery-item').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.gallery-item').forEach(g => g.classList.remove('active'));
    el.classList.add('active');
    fadeOutThenSwitch(el.dataset.src);
  });
});

let lastTouchY = 0, touchAccum = 0;
window.addEventListener('touchstart', (e) => {
  lastTouchY = e.touches[0].clientY;
  touchAccum = 0;
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (sorted.length === 0) return;
  const dy = lastTouchY - e.touches[0].clientY;
  lastTouchY = e.touches[0].clientY;
  touchAccum += dy;
  const steps = Math.trunc(touchAccum / TOUCH_THRESHOLD);
  if (steps === 0) return;
  touchAccum -= steps * TOUCH_THRESHOLD;
  advanceSnap(steps);
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft')  advanceSnap(-1);
  if (e.key === 'ArrowRight') advanceSnap(1);
});

// ── Chargement ────────────────────────────────────────────────────────────────

fetch('./data.json')
  .then(r => r.json())
  .then(projects => {
    new GLTFLoader().load(
      './assets/models/icosphere.glb',
      (gltf) => init(gltf, projects),
      undefined,
      (err) => console.error('[ideas] Erreur GLB:', err)
    );
  })
  .catch(err => console.error('[ideas] Erreur data.json:', err));

function init(gltf, projects) {
  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);

  // Caméra du GLB
  if (gltf.cameras.length > 0) {
    const glbCam = gltf.cameras[0];
    glbCam.updateMatrixWorld(true);
    if (window.matchMedia('(pointer: coarse)').matches && glbCam.isPerspectiveCamera) {
      glbCam.zoom = 0.42;
      glbCam.updateProjectionMatrix();
    }
    camera = glbCam;
    resizeCamera(camera);
    composer.passes[0] = new RenderPass(scene, camera);
  }

  // Masquer toute la géométrie
  root.traverse((c) => {
    if (c.isMesh || c.isLine || c.isLineSegments || c.isLineLoop) c.visible = false;
  });

  // Trouver le mesh icosphère
  let icoMesh = null;
  root.traverse((c) => { if (c.isMesh && !icoMesh) icoMesh = c; });
  if (!icoMesh) {
    console.warn('[ideas] Aucun mesh trouvé dans icosphere.glb');
    root.traverse((c) => console.log(' -', c.name, c.type));
    return;
  }

  icoMesh.updateWorldMatrix(true, true);

  // Extraire les vertices uniques en espace monde
  const attr = icoMesh.geometry.attributes.position;
  const seen = new Set();
  const worldVerts = [];
  for (let i = 0; i < attr.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(attr, i);
    icoMesh.localToWorld(v);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    worldVerts.push(v);
  }
  console.log(`[ideas] ${worldVerts.length} vertices`);
  if (worldVerts.length === 0) return;

  // Centre de la sphère
  const box = new THREE.Box3();
  worldVerts.forEach(v => box.expandByPoint(v));
  const sphereCenter = box.getCenter(new THREE.Vector3());
  group.position.copy(sphereCenter);

  // Direction caméra → centre sphère (espace monde)
  const camWorldPos = new THREE.Vector3();
  camera.getWorldPosition(camWorldPos);
  cameraDir = camWorldPos.clone().sub(sphereCenter).normalize();

  // Rayon moyen → taille sprites
  const radius = worldVerts.reduce((s, v) => s + v.distanceTo(sphereCenter), 0) / worldVerts.length;
  spriteSize = radius * 0.30;
  noiseAmp   = radius * 0.006;

  // Durée par ligne : animation totale ~1s quelle que soit la densité
  introLineDuration = Math.min(INTRO_LINE_DURATION, 1.0 / worldVerts.length);

  // Créer les sprites THREE.Sprite (toujours face caméra, compatible rotation groupe)
  worldVerts.forEach((v, i) => {
    const localPos = v.clone().sub(sphereCenter);
    const localDir = localPos.clone().normalize();

    const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(localPos);
    sprite.scale.setScalar(spriteSize);
    group.add(sprite);

    const project = projects[i % projects.length];
    const entry = {
      sprite, mat, localDir, localPos: localPos.clone(),
      loadAlpha: 0,
      introAlpha: 0,
      introUnlockTime: elapsed + i * introLineDuration,
      phaseX: Math.random() * Math.PI * 2,
      phaseY: Math.random() * Math.PI * 2,
      currentBoost: 1,
      aspect: 1,
      project,
    };
    entries.push(entry);

    loadRoundedTexture(project.image, (tex, aspect) => {
      entry.aspect = aspect;
      if (tex) { mat.map = tex; mat.needsUpdate = true; }
      fadeList.push({ entry, delay: elapsed });
    });
  });

  // Lignes de connexion entre vertices consécutifs (intro animée)
  const N = entries.length;
  for (let i = 0; i < N; i++) {
    const matLine = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0, depthWrite: false });
    const positions = new Float32Array(6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const line = new THREE.Line(geo, matLine);
    line.frustumCulled = false;
    line.renderOrder = -1;
    group.add(line);
    lineEntries.push({ line, matLine, entryA: entries[i], entryB: entries[(i + 1) % N], introDraw: 0, introDelay: elapsed + i * introLineDuration });
  }

  introLinesEndTime = elapsed + N * introLineDuration + INTRO_SPRITE_FADE;

  // sorted = ordre naturel des vertices
  sorted = [...entries];

  // Sommaire
  const tocEl = document.getElementById('toc');
  tocEl.innerHTML = '';
  sorted.forEach((entry, i) => {
    const item = document.createElement('div');
    item.className = 'toc-item';
    item.textContent = `${i + 1} — ${entry.project.name}`;
    item.addEventListener('click', () => {
      const n = sorted.length;
      const fwd  = ((i - snapIndex) % n + n) % n;
      const back = ((snapIndex - i) % n + n) % n;
      advanceSnap(fwd <= back ? fwd : -back);
    });
    tocEl.appendChild(item);
  });

  // Position initiale : vertex 0 face caméra
  snapIndex = 0;
  targetGroupQuat.setFromUnitVectors(sorted[0].localDir, cameraDir);
  group.quaternion.copy(targetGroupQuat);
  updateUI();
}

// ── Raycasting ────────────────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

// ── Drag rotation ─────────────────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  isDragging   = true;
  isCoasting   = false;
  dragMoved    = false;
  dragVelX     = 0;
  dragVelY     = 0;
  lastDragX    = e.clientX;
  lastDragY    = e.clientY;
  lastMoveTime = performance.now();
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    isCoasting = true;
  }
  canvas.style.cursor = '';
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.clientX - lastDragX;
  const dy = e.clientY - lastDragY;
  lastDragX = e.clientX;
  lastDragY = e.clientY;
  if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;

  const now = performance.now();
  const dt  = Math.max(8, now - lastMoveTime) / 1000; // secondes
  lastMoveTime = now;

  // Mémoriser la vélocité pour l'inertie
  dragVelY = Math.max(-MAX_DRAG_VEL, Math.min(MAX_DRAG_VEL, dx * DRAG_SENSITIVITY / dt));
  dragVelX = Math.max(-MAX_DRAG_VEL, Math.min(MAX_DRAG_VEL, dy * DRAG_SENSITIVITY / dt));

  const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * DRAG_SENSITIVITY);
  const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * DRAG_SENSITIVITY);
  group.quaternion.premultiply(qY).premultiply(qX);
  targetGroupQuat.copy(group.quaternion);
});

// ── Raycasting hover / click ──────────────────────────────────────────────────

canvas.addEventListener('click', (e) => {
  if (dragMoved || sorted.length === 0) return;
  const selected = sorted[snapIndex];
  if (!selected?.project?.link) return;
  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.intersectObject(selected.sprite).length > 0)
    window.open(selected.project.link, '_blank', 'noopener');
});

canvas.addEventListener('mousemove', (e) => {
  if (isDragging || sorted.length === 0) return;
  const selected = sorted[snapIndex];
  if (!selected?.project?.link) { canvas.style.cursor = ''; isHoveringSelected = false; return; }
  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  isHoveringSelected  = raycaster.intersectObject(selected.sprite).length > 0;
  canvas.style.cursor = isHoveringSelected ? 'pointer' : 'grab';
});

canvas.addEventListener('mouseleave', () => {
  isHoveringSelected = false;
  if (isDragging) { isDragging = false; isCoasting = true; }
});

// ── Boucle ────────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

(function loop() {
  requestAnimationFrame(loop);
  const rawDelta = clock.getDelta();
  elapsed += rawDelta;

  // Inertie + aimant : la sphère continue sur sa lancée tout en étant attirée vers le vertex le plus proche
  if (isCoasting && entries.length > 0) {
    dragVelX *= Math.exp(-INERTIA_DAMPING * rawDelta);
    dragVelY *= Math.exp(-INERTIA_DAMPING * rawDelta);
    const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dragVelY * rawDelta);
    const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dragVelX * rawDelta);
    group.quaternion.premultiply(qY).premultiply(qX);

    // Vertex le plus face à la caméra → cible magnétique en temps réel
    let bestIdx = 0, bestDot = -Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const worldDir = sorted[i].localDir.clone().applyQuaternion(group.quaternion);
      const dot = worldDir.dot(cameraDir);
      if (dot > bestDot) { bestDot = dot; bestIdx = i; }
    }
    if (bestIdx !== snapIndex) { snapIndex = bestIdx; updateUI(); }
    targetGroupQuat.setFromUnitVectors(sorted[snapIndex].localDir, cameraDir);

    if (Math.abs(dragVelX) + Math.abs(dragVelY) < SNAP_VEL_THRESHOLD) isCoasting = false;
  }

  // Rotation fluide vers la cible (aimant plus fort pendant le coasting)
  if (entries.length > 0) {
    const speed = isCoasting ? SLERP_SPEED * 1.2 : SLERP_SPEED;
    group.quaternion.slerp(targetGroupQuat, 1 - Math.exp(-speed * rawDelta));
  }

  // Fade-out avant changement de dataset
  if (switchFadeOutList.length > 0) {
    let allDone = true;
    for (const { entry, startAlpha, startTime, duration } of switchFadeOutList) {
      const t = Math.min((elapsed - startTime) / duration, 1);
      entry.loadAlpha = startAlpha * (1 - t * t * (3 - 2 * t));
      if (t < 1) allDone = false;
    }
    if (allDone) {
      switchFadeOutList = [];
      switchFadeOutCallback?.();
      switchFadeOutCallback = null;
    }
  }

  // Fade-in au chargement
  fadeList = fadeList.filter(({ entry, delay }) => {
    const t = Math.min((elapsed - delay) / FADE_DURATION, 1);
    if (t <= 0) return true;
    entry.loadAlpha = t * t * (3 - 2 * t);
    return t < 1;
  });

  // Animation d'intro — tracé progressif des lignes
  for (const le of lineEntries) {
    const tl = (elapsed - le.introDelay) / introLineDuration;
    le.introDraw = Math.min(1, Math.max(0, tl));
  }

  // Animation d'intro — apparition des sprites
  for (const entry of entries) {
    const ti = Math.min(1, Math.max(0, (elapsed - entry.introUnlockTime) / INTRO_SPRITE_FADE));
    entry.introAlpha = ti * ti * (3 - 2 * ti);
  }

  const nt = elapsed * NOISE_FREQ;

  for (const entry of entries) {
    const isSelected = sorted[snapIndex]?.sprite === entry.sprite;

    // Scale : lerp vers la cible pour un agrandissement smooth
    const targetBoost = isSelected ? (1 + SELECTED_SCALE_BOOST) * (isHoveringSelected ? hoverScale : 1) : 1;
    entry.currentBoost += (targetBoost - entry.currentBoost) * Math.min(1, rawDelta * 6);
    entry.sprite.scale.set(spriteSize * entry.aspect * entry.currentBoost, spriteSize * entry.currentBoost, 1);

    // Bruit de position (dans l'espace local du groupe)
    entry.sprite.position.x = entry.localPos.x + Math.sin(nt + entry.phaseX) * noiseAmp;
    entry.sprite.position.y = entry.localPos.y + Math.sin(nt + entry.phaseY) * noiseAmp;
    entry.sprite.position.z = entry.localPos.z;

    // Opacité : fondu selon l'orientation du vertex par rapport à la caméra
    // dot > 0 = face caméra, dot < 0 = dos caméra
    const worldDir = entry.localDir.clone().applyQuaternion(group.quaternion);
    const dot      = worldDir.dot(cameraDir);
    const visAlpha = isSelected ? 1 : Math.max(0, (dot + 0.15) / 1.15);
    entry.mat.opacity = Math.min(entry.loadAlpha, entry.introAlpha) * visAlpha;
  }

  // Fondu de sortie global des lignes
  const LINE_FADE_OUT = 0.15;
  const lineOut = Math.min(1, Math.max(0, (elapsed - introLinesEndTime) / LINE_FADE_OUT));
  const lineGlobalAlpha = 1 - lineOut;

  for (const le of lineEntries) {
    const pA = le.entryA.sprite.position;
    const pB = le.entryB.sprite.position;
    const arr = le.line.geometry.attributes.position.array;
    arr[0] = pA.x; arr[1] = pA.y; arr[2] = pA.z;
    if (le.introDraw < 1) {
      const drawEnd = new THREE.Vector3().lerpVectors(pA, pB, le.introDraw);
      arr[3] = drawEnd.x; arr[4] = drawEnd.y; arr[5] = drawEnd.z;
      le.matLine.opacity = le.introDraw * lineGlobalAlpha;
    } else {
      arr[3] = pB.x; arr[4] = pB.y; arr[5] = pB.z;
      const normalOp = le.entryB.introAlpha < 1 ? le.entryA.mat.opacity : Math.min(le.entryA.mat.opacity, le.entryB.mat.opacity);
      le.matLine.opacity = normalOp * lineGlobalAlpha;
    }
    le.line.geometry.attributes.position.needsUpdate = true;
  }

  // ── Hand tracking — pince = attraper, relâcher = lancer ─────────────────────
  const handNow = performance.now();
  if (handLandmarker && handVideoEl && handVideoEl.readyState >= 2 &&
      handNow - lastHandDetectTime >= HAND_DETECT_INTERVAL) {
    lastHandDetectTime = handNow;
    const results = handLandmarker.detectForVideo(handVideoEl, handNow);
    handDetected = results.landmarks?.length > 0;

    const dot = document.getElementById('hand-dot');

    // Effacer le canvas squelette
    if (handSkelCtx) handSkelCtx.clearRect(0, 0, handCanvasEl.width, handCanvasEl.height);

    if (handDetected) {
      const landmarks = results.landmarks[0];
      const pinching  = isPinch(landmarks);
      if (dot) dot.style.background = pinching ? '#4caf50' : '#888';

      // Squelette (x miroir pour aligner avec la vidéo flippée par CSS)
      if (handSkelCtx) {
        const cw = handCanvasEl.width;
        const ch = handCanvasEl.height;
        const mx = (x) => (1 - x) * cw;
        const my = (y) => y * ch;
        const connections = [
          [0,1],[1,2],[2,3],[3,4],
          [0,5],[5,6],[6,7],[7,8],
          [5,9],[9,10],[10,11],[11,12],
          [9,13],[13,14],[14,15],[15,16],
          [13,17],[17,18],[18,19],[19,20],
          [0,17],
        ];
        handSkelCtx.lineWidth   = 1.5;
        handSkelCtx.strokeStyle = pinching ? '#4caf50' : '#ffffff';
        handSkelCtx.globalAlpha = 0.8;
        for (const [a, b] of connections) {
          handSkelCtx.beginPath();
          handSkelCtx.moveTo(mx(landmarks[a].x), my(landmarks[a].y));
          handSkelCtx.lineTo(mx(landmarks[b].x), my(landmarks[b].y));
          handSkelCtx.stroke();
        }
        handSkelCtx.fillStyle   = '#ffffff';
        handSkelCtx.globalAlpha = 0.95;
        for (const pt of landmarks) {
          handSkelCtx.beginPath();
          handSkelCtx.arc(mx(pt.x), my(pt.y), 2.5, 0, Math.PI * 2);
          handSkelCtx.fill();
        }
        handSkelCtx.fillStyle   = pinching ? '#4caf50' : '#cccccc';
        handSkelCtx.globalAlpha = 1;
        for (const idx of [4, 8]) {
          handSkelCtx.beginPath();
          handSkelCtx.arc(mx(landmarks[idx].x), my(landmarks[idx].y), 5, 0, Math.PI * 2);
          handSkelCtx.fill();
        }
      }

      if (pinching) {
        // Pince fermée : suivre le point milieu pouce-index et injecter la vélocité
        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const hx = 1 - (thumbTip.x + indexTip.x) / 2; // miroir horizontal
        const hy =     (thumbTip.y + indexTip.y) / 2;

        if (smoothHandX === null) {
          smoothHandX = hx;
          smoothHandY = hy;
        } else {
          smoothHandX += (hx - smoothHandX) * HAND_SMOOTH;
          smoothHandY += (hy - smoothHandY) * HAND_SMOOTH;
        }

        if (prevHandX !== null) {
          const dx = Math.max(-HAND_MAX_DELTA, Math.min(HAND_MAX_DELTA, smoothHandX - prevHandX));
          const dy = Math.max(-HAND_MAX_DELTA, Math.min(HAND_MAX_DELTA, smoothHandY - prevHandY));

          const dt = Math.max(rawDelta, 0.008);
          const targetVelY = Math.max(-MAX_DRAG_VEL, Math.min(MAX_DRAG_VEL, dx * HAND_SENSITIVITY / dt));
          const targetVelX = Math.max(-MAX_DRAG_VEL, Math.min(MAX_DRAG_VEL, dy * HAND_SENSITIVITY / dt));

          handVelX += (targetVelX - handVelX) * 0.35;
          handVelY += (targetVelY - handVelY) * 0.35;

          if (Math.abs(dx) + Math.abs(dy) > 0.0005) {
            // La sphère suit la pince en temps réel
            dragVelX = handVelX;
            dragVelY = handVelY;
            isCoasting = true;
          }
        }
        prevHandX = smoothHandX;
        prevHandY = smoothHandY;
      } else {
        // Main ouverte : relâchement — l'inertie accumulée prend le relais (effet lancé)
        prevHandX   = null; prevHandY   = null;
        smoothHandX = null; smoothHandY = null;
        handVelX    = 0;    handVelY    = 0;
      }
    } else {
      // Aucune main détectée
      if (dot) dot.style.background = '#888';
      prevHandX   = null; prevHandY   = null;
      smoothHandX = null; smoothHandY = null;
      handVelX    = 0;    handVelY    = 0;
    }
  }

  // Hover scale — lerp
  hoverScale += ((isHoveringSelected ? HOVER_SCALE_BOOST : 1.0) - hoverScale) * Math.min(1, rawDelta * 10);

  composer.render();
}());
