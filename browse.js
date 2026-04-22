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

const CORNER_RADIUS   = 0.04  ;
const FADE_DURATION   = 0.6;
const STAGGER_TOTAL   = 1.5;
const NOISE_FREQ      = 0.5;
const SCROLL_STIFF    = 80;   // raideur du ressort (1/s) — fort = snap rapide
const SCROLL_DAMPING  = 20;   // amortissement (1/s)
const WHEEL_THRESHOLD = 80;   // deltaY accumulé pour avancer d'un sprite

// ── Taille du sprite sélectionné ─────────────────────────────────────────────
let SELECTED_SCALE_BOOST = 0.38; // agrandissement du sprite central (0 = aucun)
let HOVER_SCALE_BOOST    = 1.09; // multiplicateur supplémentaire au survol

/** Modifie la taille du sprite sélectionné au centre.
 *  @param {number} centerBoost  ex: 0.18 → sprite 18 % plus grand que les autres
 *  @param {number} hoverBoost   ex: 1.06 → +6 % supplémentaires au survol
 */
function setSelectedSpriteScale(centerBoost, hoverBoost) {
  if (centerBoost !== undefined) SELECTED_SCALE_BOOST = centerBoost;
  if (hoverBoost  !== undefined) HOVER_SCALE_BOOST    = hoverBoost;
}

// Modulo toujours positif
const mod = (a, b) => ((a % b) + b) % b;

function loadRoundedTexture(path, onReady) {
  const size = 256;
  const r    = size * CORNER_RADIUS;
  const cvs  = document.createElement('canvas');
  cvs.width  = size;
  cvs.height = size;
  const ctx  = cvs.getContext('2d');
  const tex  = new THREE.CanvasTexture(cvs);
  const img  = new Image();
  img.onload = () => {
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.arcTo(size, 0,    size, r,        r);
    ctx.lineTo(size, size - r);
    ctx.arcTo(size, size, size - r, size, r);
    ctx.lineTo(r, size);
    ctx.arcTo(0, size,    0, size - r,    r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0,       r, 0,           r);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, size, size);
    ctx.restore();
    tex.needsUpdate = true;
    onReady?.();
  };
  img.src = path;
  return tex;
}


// ── Renderer ──────────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);

function createGradientTexture(colorTop, colorBottom) {
  const cvs = document.createElement('canvas');
  cvs.width  = 2;
  cvs.height = 256;
  const ctx  = cvs.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, colorTop);
  grad.addColorStop(1, colorBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  return new THREE.CanvasTexture(cvs);
}

const scene = new THREE.Scene();
// Pas de scene.background — le gradient est rendu par le body CSS

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
  setTimeout(() => {
    applyDark(isDark);
    overlay.style.opacity = '0';
  }, 250);
});

let camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);

const postStartTime = performance.now();
let renderPass = new RenderPass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(renderPass);
const grainPass = new ShaderPass(GrainShader);
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

const group = new THREE.Group();
scene.add(group);

// ── État scroll ───────────────────────────────────────────────────────────────

let scrollOffset  = 0;
let scrollTarget  = 0;
let scrollVel     = 0;

// ── État snap discret ─────────────────────────────────────────────────────────
// snapPositions[i] = valeur de scrollTarget pour que le sprite i soit au centre
// Rempli après le chargement du GLB.

let snapPositions = [];
let snapIndex     = 0;
let wheelAccum    = 0;
let sorted        = [];

// ── Utilitaires UI ────────────────────────────────────────────────────────────

const _typingTimers = new Map();

function typeText(el, text, interval = 18) {
  if (_typingTimers.has(el)) clearInterval(_typingTimers.get(el));
  el.textContent = '';
  const words = text.split(' ');
  let i = 0;
  const timer = setInterval(() => {
    el.textContent += (i === 0 ? '' : ' ') + words[i];
    i++;
    if (i >= words.length) { clearInterval(timer); _typingTimers.delete(el); }
  }, interval);
  _typingTimers.set(el, timer);
}

function updateToc() {
  const items = document.querySelectorAll('.toc-item');
  items.forEach((el, i) => el.classList.toggle('active', i === snapIndex));
}

function updateUI() {
  if (sorted.length === 0) return;
  const project = sorted[snapIndex].project;
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

function advanceSnap(steps) {
  if (snapPositions.length === 0) return;
  const n = snapPositions.length;
  snapIndex = ((snapIndex + steps) % n + n) % n;
  const raw  = snapPositions[snapIndex];
  let   diff = mod(raw - mod(scrollTarget, lineLength), lineLength);
  if (diff > lineLength * 0.5) diff -= lineLength;
  scrollTarget += diff;
  updateUI();
}

window.addEventListener('wheel', (e) => {
  if (snapPositions.length === 0) return;

  wheelAccum += e.deltaY;
  if (Math.abs(wheelAccum) < WHEEL_THRESHOLD) return;

  advanceSnap(Math.sign(wheelAccum));
  wheelAccum = 0;

}, { passive: true });

document.getElementById('btn-prev').addEventListener('click', () => advanceSnap(-1));
document.getElementById('btn-next').addEventListener('click', () => advanceSnap(1));

// ── Touch scroll (mobile) ──────────────────────────────────────────────────────

const TOUCH_THRESHOLD = 40; // pixels pour avancer d'un sprite
let lastTouchY  = 0;
let touchAccum  = 0;

window.addEventListener('touchstart', (e) => {
  lastTouchY = e.touches[0].clientY;
  touchAccum = 0;
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (snapPositions.length === 0) return;
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

// ── État scène ────────────────────────────────────────────────────────────────

let fadeList   = [];
let noiseList  = [];
let lineEntries = [];
let hoverScale = 1.0;
let elapsed    = 0;
let noiseAmp      = 0;
let spriteSize    = 1;
let scrollDir     = new THREE.Vector3();
let lineLength    = 1;
let minProj       = 0;
let arcElevation  = 0;

// ── Chargement ────────────────────────────────────────────────────────────────

fetch('./data.json')
  .then(r => r.json())
  .then(projects => {
    new GLTFLoader().load(
      './assets/models/browse.glb',
      (gltf) => init(gltf, projects),
      undefined,
      (err) => console.error('[browse] Erreur GLB:', err)
    );
  })
  .catch(err => console.error('[browse] Erreur data.json:', err));

function init(gltf, projects) {

  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);

  // Caméra du GLB
  if (gltf.cameras.length > 0) {
    const glbCam = gltf.cameras[0];
    glbCam.updateMatrixWorld(true);
    // Sur mobile (portrait), le FOV vertical natif est trop proche — on le réduit
    if (window.matchMedia('(pointer: coarse)').matches && glbCam.isPerspectiveCamera) {
      glbCam.zoom = 0.42;
      glbCam.updateProjectionMatrix();
    }
    camera = glbCam;
    resizeCamera(camera);
    renderPass = new RenderPass(scene, camera);
    composer.passes[0] = renderPass;
  }

  // Masquer toute la géométrie du GLB
  root.traverse((c) => {
    if (c.isMesh || c.isLine || c.isLineSegments || c.isLineLoop) c.visible = false;
  });

  // Trouver browse_line
  let browseLine = null;
  root.traverse((c) => { if (c.name.toLowerCase() === 'browse_line') browseLine = c; });
  if (!browseLine) {
    console.warn('[browse] "browse_line" introuvable.');
    root.traverse((c) => console.log(' -', c.name, c.type));
    return;
  }

  browseLine.updateWorldMatrix(true, true);

  // Collecter les vertices en ordre
  const vertices = [];
  browseLine.traverse((child) => {
    const attr = child.geometry?.attributes?.position;
    if (!attr) return;
    if (child.isLineSegments) {
      // Une position par segment (milieu de chaque paire de vertices)
      for (let i = 0; i + 1 < attr.count; i += 2) {
        const a = new THREE.Vector3().fromBufferAttribute(attr, i);
        const b = new THREE.Vector3().fromBufferAttribute(attr, i + 1);
        child.localToWorld(a);
        child.localToWorld(b);
        vertices.push(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
      }
    } else {
      for (let i = 0; i < attr.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(attr, i);
        child.localToWorld(v);
        vertices.push(v);
      }
    }
  });

  // Dédupliquer en préservant l'ordre
  const seen = new Set();
  const pts  = vertices.filter((p) => {
    const key = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[browse] ${pts.length} vertices`);
  if (pts.length === 0) return;

  // Direction de scroll = axe principal de la ligne (premier → dernier vertex)
  scrollDir.subVectors(pts[pts.length - 1], pts[0]).normalize();
  const projections = pts.map((p) => p.dot(scrollDir));
  minProj    = Math.min(...projections);
  lineLength = Math.max(...projections) - minProj;

  // Taille sprites
  const box    = new THREE.Box3();
  pts.forEach((v) => box.expandByPoint(v));
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  spriteSize   = maxDim * 0.35;                        //Taille des sprites dans browse
  noiseAmp     = maxDim * 0.003;
  arcElevation = maxDim * 0.18;

  // Rotation depuis Sprite_reference
  let spriteRef = null;
  root.traverse((c) => { if (c.name === 'Sprite_reference') spriteRef = c; });
  const refQuat = new THREE.Quaternion();
  if (spriteRef) {
    spriteRef.updateWorldMatrix(true, false);
    spriteRef.getWorldQuaternion(refQuat);
  }

  const planeGeo  = new THREE.PlaneGeometry(1, 1);
  const initElapsed = elapsed; // référence temporelle pour le stagger

  // Trier par projection et espacement uniforme : garantit qu'un seul sprite
  // arrive au centre (norm=0.5) à la fois, même si les vertices du GLB sont irréguliers
  const N = pts.length;
  const ptsOrdered = pts.slice().sort((a, b) => a.dot(scrollDir) - b.dot(scrollDir));

  // Stagger gauche→droite basé sur la position X monde
  const minX = Math.min(...ptsOrdered.map(p => p.x));
  const maxX = Math.max(...ptsOrdered.map(p => p.x));
  const xRange = (maxX - minX) || 1;

  ptsOrdered.forEach((p, i) => {
    const mat  = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(planeGeo, mat);
    mesh.position.copy(p);
    mesh.scale.setScalar(spriteSize);
    mesh.quaternion.copy(refQuat);
    // Compenser la conversion Blender Z-up → Y-up qui couche les plans
    mesh.rotateX(-Math.PI / 2);
    group.add(mesh);

    // Projection uniformément répartie sur [minProj, minProj+lineLength[
    // i/N (et non i/(N-1)) pour que premier et dernier ne se superposent pas après wrap
    const origProj = p.dot(scrollDir);
    const proj     = minProj + (i / N) * lineLength;
    const perp     = p.clone().sub(scrollDir.clone().multiplyScalar(origProj));

    const project = projects[i % projects.length];
    const entry = {
      sprite: mesh,
      mat,
      perp,
      proj,
      loadAlpha: 0,
      phaseX: Math.random() * Math.PI * 2,
      phaseY: Math.random() * Math.PI * 2,
      project,
    };
    noiseList.push(entry);

    // Charger la texture — le fade commence seulement quand l'image est prête
    const xNorm = (p.x - minX) / xRange; // 0 = gauche, 1 = droite
    const staggerDelay = initElapsed + xNorm * STAGGER_TOTAL;
    mat.map = loadRoundedTexture(project.image, () => {
      mat.needsUpdate = true;
      fadeList.push({ entry, delay: Math.max(staggerDelay, elapsed) });
    });
  });

  // ── Lignes de connexion entre sprites ──────────────────────────────────────
  lineEntries = [];
  const N2 = noiseList.length;
  for (let i = 0; i < N2; i++) {
    const matLine = new THREE.LineBasicMaterial({
      color: 0x888888,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const positions = new Float32Array(6); // 2 points × 3 coords
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const line = new THREE.Line(geo, matLine);
    line.frustumCulled = false;
    group.add(line);
    lineEntries.push({
      line,
      matLine,
      entryA: noiseList[i],
      entryB: noiseList[(i + 1) % N2],
    });
  }

  // ── Positions de snap ──────────────────────────────────────────────────────
  // Trier par proj pour avoir l'ordre naturel sur la ligne
  sorted = [...noiseList].sort((a, b) => a.proj - b.proj);
  // Pour chaque sprite i, scrollTarget tel que i est au centre (norm = 0.5)
  snapPositions = sorted.map((e) => lineLength * 0.5 - (e.proj - minProj));

  // ── Sommaire ────────────────────────────────────────────────────────────────
  const tocEl = document.getElementById('toc');
  tocEl.innerHTML = '';
  sorted.forEach((entry, i) => {
    const item = document.createElement('div');
    item.className = 'toc-item';
    item.textContent = `${i + 1} — ${entry.project.name}`;
    item.addEventListener('click', () => {
      const n = snapPositions.length;
      const steps = ((i - snapIndex) % n + n) % n;
      const stepsBack = ((snapIndex - i) % n + n) % n;
      advanceSnap(steps <= stepsBack ? steps : -stepsBack);
    });
    tocEl.appendChild(item);
  });
  updateToc();

  // Démarrer sur le premier projet (index 0 dans data.json)
  snapIndex   = 0;
  scrollTarget = snapPositions[0];
  updateUI();
}

// ── Clic sur le sprite sélectionné ───────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  if (sorted.length === 0) return;
  const selected = sorted[snapIndex];
  if (!selected?.project?.link) return;

  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(selected.sprite, false);
  if (hits.length > 0) window.open(selected.project.link, '_blank', 'noopener');
});

let isHoveringSelected = false;

canvas.addEventListener('mousemove', (e) => {
  if (sorted.length === 0) return;
  const selected = sorted[snapIndex];
  if (!selected?.project?.link) { canvas.style.cursor = ''; isHoveringSelected = false; return; }

  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(selected.sprite, false);
  isHoveringSelected  = hits.length > 0;
  canvas.style.cursor = isHoveringSelected ? 'pointer' : '';
});

canvas.addEventListener('mouseleave', () => { isHoveringSelected = false; });

// ── Boucle ────────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

(function loop() {
  requestAnimationFrame(loop);

  const rawDelta = clock.getDelta();
  elapsed += rawDelta;

  // Spring scroll — substeps pour stabilité numérique quelle que soit la fréquence
  const PHYSICS_STEP = 1 / 60;
  const numSteps = Math.max(1, Math.ceil(rawDelta / PHYSICS_STEP));
  const dt = rawDelta / numSteps;
  for (let s = 0; s < numSteps; s++) {
    const springForce = (scrollTarget - scrollOffset) * SCROLL_STIFF;
    scrollVel        += (springForce - scrollVel * SCROLL_DAMPING) * dt;
    scrollOffset     += scrollVel * dt;
  }

  // Hard-clamp : verrouillage total une fois stabilisé
  if (Math.abs(scrollTarget - scrollOffset) < lineLength * 0.0002 && Math.abs(scrollVel) < 0.002) {
    scrollOffset = scrollTarget;
    scrollVel    = 0;
  }

  // Fade-in au chargement — met à jour loadAlpha
  fadeList = fadeList.filter(({ entry, delay }) => {
    const t = Math.min((elapsed - delay) / FADE_DURATION, 1);
    if (t <= 0) return true;
    entry.loadAlpha = t * t * (3 - 2 * t);
    return t < 1;
  });

  // Déplacement + wrap infini + fade aux extrémités
  const FADE_ZONE = 0.20;
  const t = elapsed * NOISE_FREQ;

  // Direction forward de la caméra (en espace monde) — pour le tri en profondeur
  const camForward = new THREE.Vector3();
  camera.getWorldDirection(camForward);

  for (const { sprite, mat, perp, proj, loadAlpha, phaseX, phaseY } of noiseList) {
    const newProj = mod(proj - minProj + scrollOffset, lineLength) + minProj;

    const norm = (newProj - minProj) / lineLength; // 0..1

    sprite.position
      .copy(perp)
      .add(scrollDir.clone().multiplyScalar(newProj));

    // Tri depth : calculé ICI, sur la position de base (avant élévation arc)
    // L'élévation Y ne doit pas influencer l'ordre de rendu
    const depth = sprite.position.clone().sub(camera.position).dot(camForward);
    sprite.renderOrder = -depth;

    // Arc : le sprite au centre de la ligne est surélevé
    const centerFactor = Math.exp(-180 * Math.pow(norm - 0.5, 2));
    sprite.position.y += arcElevation * centerFactor;

    // Scale : le sprite central grandit légèrement + hover
    const isSelected = sorted.length > 0 && sorted[snapIndex]?.sprite === sprite;
    const hoverBoost = isSelected ? hoverScale : 1.0;
    sprite.scale.setScalar(spriteSize * (1 + SELECTED_SCALE_BOOST * centerFactor) * hoverBoost);

    // Bruit nul au centre (même gaussienne que l'arc) — le sprite verrouillé ne bouge plus
    const noiseFactor = 1 - centerFactor;
    sprite.position.x += Math.sin(t + phaseX) * noiseAmp * noiseFactor;
    sprite.position.y += Math.sin(t + phaseY) * noiseAmp * noiseFactor;

    // Fade positionnel aux extrémités
    const pa       = Math.min(norm / FADE_ZONE, 1, (1 - norm) / FADE_ZONE);
    const posAlpha = pa * pa * (3 - 2 * pa); // smoothstep

    mat.opacity = loadAlpha * posAlpha;
  }

  // Mise à jour des lignes de connexion
  for (const { line, matLine, entryA, entryB } of lineEntries) {
    const pA = entryA.sprite.position;
    const pB = entryB.sprite.position;
    const arr = line.geometry.attributes.position.array;
    arr[0] = pA.x; arr[1] = pA.y; arr[2] = pA.z;
    arr[3] = pB.x; arr[4] = pB.y; arr[5] = pB.z;
    line.geometry.attributes.position.needsUpdate = true;
    matLine.opacity = Math.min(entryA.mat.opacity, entryB.mat.opacity);
    line.renderOrder = Math.min(entryA.sprite.renderOrder, entryB.sprite.renderOrder) - 1;
  }

  // Hover scale — lerp vers la cible
  const hoverTarget = isHoveringSelected ? HOVER_SCALE_BOOST : 1.0;
  hoverScale += (hoverTarget - hoverScale) * Math.min(1, rawDelta * 10);

  grainPass.uniforms.time.value = ((performance.now() - postStartTime) * 0.001) % 100.0;
  composer.render();
}());
