import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PROFILE_PICS } from '../assets/textures/profile_pics_manifest.js';
import { IMPORTANT_PICS } from '../assets/textures/important_pics_manifest.js';

const SPRITE_SIZE = 0.14;
const CONNECTION_K       = 0;    // nombre de connexions aléatoires par sprite
const CONNECTION_MAX_DIST = 1.5; // distance max entre deux sprites reliés
const CONNECTION_OPACITY = 0.28; // opacité finale des traits

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
} //looat

const CORNER_RADIUS = 0.05; // Corner radius des sprites 0,5 = cercles

function loadRoundedTexture(path) {
  const size = 256;
  const r = size * CORNER_RADIUS;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);

  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.arcTo(size, 0, size, r, r);
    ctx.lineTo(size, size - r);
    ctx.arcTo(size, size, size - r, size, r);
    ctx.lineTo(r, size);
    ctx.arcTo(0, size, 0, size - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, size, size);
    tex.needsUpdate = true;
  };
  img.src = path;

  return tex;
}

const FADE_DURATION  = 0.2;
const STAGGER_TOTAL  = 3.0;
const NOISE_AMP      = 0.012;
const NOISE_FREQ     = 0.5; //noise sur le z index des sprites
const FOG_NEAR       = 2.0;  // distance où l'opacité commence à baisser
const FOG_FAR        = 7.0;  // distance où l'opacité atteint zéro

function buildConnectionLines(noiseList, group) {
  const n = noiseList.length;
  if (n < 2) return null;

  // Connexions aléatoires dans un rayon max — effet réseau tech
  const edges = [];
  const added = new Set();
  const connectionsPerSprite = new Int32Array(n);

  // Candidats éligibles par sprite (dans le rayon max)
  const candidates = noiseList.map((a, i) =>
    noiseList
      .map((b, j) => ({ j, d: a.base.distanceTo(b.base) }))
      .filter(({ j, d }) => j !== i && d <= CONNECTION_MAX_DIST)
  );

  for (let i = 0; i < n; i++) {
    const pool = candidates[i].filter(({ j }) => connectionsPerSprite[j] < CONNECTION_K);
    // Mélange aléatoire du pool de candidats
    for (let k = pool.length - 1; k > 0; k--) {
      const r = Math.floor(Math.random() * (k + 1));
      [pool[k], pool[r]] = [pool[r], pool[k]];
    }
    for (const { j } of pool) {
      if (connectionsPerSprite[i] >= CONNECTION_K) break;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!added.has(key)) {
        added.add(key);
        edges.push([i, j]);
        connectionsPerSprite[i]++;
        connectionsPerSprite[j]++;
      }
    }
  }

  // Un objet Line par segment pour permettre une opacité individuelle
  const lineObjs = edges.map(([i, j]) => {
    const mat = new THREE.LineBasicMaterial({
      color: 0x999999,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const positions = new Float32Array(6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    group.add(line);
    return { line, mat, i, j };
  });

  return { lineObjs, loadAlpha: 0 };
}

function updateConnectionLines(lineData, noiseList) {
  if (!lineData) return;
  for (const { line, i, j } of lineData.lineObjs) {
    const pi = noiseList[i].sprite.position;
    const pj = noiseList[j].sprite.position;
    const arr = line.geometry.attributes.position.array;
    arr[0] = pi.x; arr[1] = pi.y; arr[2] = pi.z;
    arr[3] = pj.x; arr[4] = pj.y; arr[5] = pj.z;
    line.geometry.attributes.position.needsUpdate = true;
  }
}

const HOVER_SCALE  = 1.12; // multiplicateur de taille au survol
const HOVER_LERP   = 10;   // vitesse du lerp (unités/s)

export class GLBView {
  constructor(scene, glbModel, onLoad, onAllSpritesVisible) {
    this.group = new THREE.Group();
    this.group2 = new THREE.Group();
    this.mixer = null;
    this._fadeList = [];
    this._noiseList1 = [];
    this._noiseList2 = [];
    this._lines1 = null;
    this._lines2 = null;
    this._elapsed = 0;
    this._onAllSpritesVisible = onAllSpritesVisible;
    this._spritesReady = false;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2(9999, 9999);
    scene.add(this.group);
    scene.add(this.group2);

    const loader = new GLTFLoader();
    loader.load(
      glbModel.path,
      (gltf) => {
        const root = gltf.scene;

        const box = new THREE.Box3().setFromObject(root);
        const center = box.getCenter(new THREE.Vector3());
        root.position.sub(center);
        root.updateMatrixWorld(true);
        scene.add(root);

        // 1er pass : collecter les positions uniques, séparées par mesh
        const seen = new Set();
        const torus1Vertices = [];
        const torus2Vertices = [];
        const vertex = new THREE.Vector3();

        root.traverse((child) => {
          if (!child.isMesh) return;
          child.visible = false;

          const isTorus2 = child.name === 'Torus2';
          const positions = child.geometry.attributes.position;
          for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            vertex.applyMatrix4(child.matrixWorld);

            const key = `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)},${vertex.z.toFixed(4)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            (isTorus2 ? torus2Vertices : torus1Vertices).push(vertex.clone());
          }
        });

        const randomProfilePics = shuffled(PROFILE_PICS).slice(0, torus1Vertices.length);
        const randomImportantPics = shuffled(IMPORTANT_PICS);

        const total = torus1Vertices.length + torus2Vertices.length;
        let globalIdx = 0;

        torus1Vertices.forEach((pos, i) => {
          const tex = loadRoundedTexture(randomProfilePics[i % randomProfilePics.length]);
          const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false });
          const sprite = new THREE.Sprite(mat);
          sprite.position.copy(pos);
          sprite.scale.setScalar(SPRITE_SIZE);
          this.group.add(sprite);
          const entry = { sprite, mat, base: pos.clone(), loadAlpha: 0, hoverScale: 1.0, phaseX: Math.random() * Math.PI * 2, phaseY: Math.random() * Math.PI * 2 };
          this._fadeList.push({ entry, delay: (globalIdx / total) * STAGGER_TOTAL });
          this._noiseList1.push(entry);
          globalIdx++;
        });

        torus2Vertices.forEach((pos, i) => {
          const tex = loadRoundedTexture(randomImportantPics[i % randomImportantPics.length]);
          const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false });
          const sprite = new THREE.Sprite(mat);
          sprite.position.copy(pos);
          sprite.scale.setScalar(SPRITE_SIZE);
          this.group2.add(sprite);
          const entry = { sprite, mat, base: pos.clone(), loadAlpha: 0, hoverScale: 1.0, phaseX: Math.random() * Math.PI * 2, phaseY: Math.random() * Math.PI * 2 };
          this._fadeList.push({ entry, delay: (globalIdx / total) * STAGGER_TOTAL });
          this._noiseList2.push(entry);
          globalIdx++;
        });

        // Construction des lignes de connexion entre sprites voisins
        this._lines1 = buildConnectionLines(this._noiseList1, this.group);
        this._lines2 = buildConnectionLines(this._noiseList2, this.group2);

        // Fade-in des lignes après l'apparition des sprites
        if (this._lines1) this._fadeList.push({ lineData: this._lines1, delay: STAGGER_TOTAL });
        if (this._lines2) this._fadeList.push({ lineData: this._lines2, delay: STAGGER_TOTAL });

        // Animation de la caméra — lecture unique
        if (gltf.animations.length > 0) {
          this.mixer = new THREE.AnimationMixer(root);
          gltf.animations.forEach((clip) => {
            const action = this.mixer.clipAction(clip);
            action.loop = THREE.LoopOnce;
            action.clampWhenFinished = true;
            action.play();
          });
        }

        if (onLoad) {
          const glbCamera = gltf.cameras.length > 0 ? gltf.cameras[0] : null;
          const size = box.getSize(new THREE.Vector3());
          onLoad(glbCamera, Math.max(size.x, size.y, size.z));
        }
      },
      undefined,
      (error) => console.error('GLTFLoader error:', error)
    );
  }

  update(delta, camera) {
    this._elapsed += delta;

    if (this._fadeList.length > 0) {
      this._fadeList = this._fadeList.filter(({ entry, mat, lineData, delay, targetOpacity = 1 }) => {
        const t = Math.min((this._elapsed - delay) / FADE_DURATION, 1);
        if (t <= 0) return true;
        const smooth = t * t * (3 - 2 * t);
        if (lineData) {
          lineData.loadAlpha = smooth;
        } else if (entry) {
          entry.loadAlpha = smooth * targetOpacity;
        } else {
          mat.opacity = smooth * targetOpacity;
        }
        return t < 1;
      });
      if (this._fadeList.length === 0 && !this._spritesReady) {
        this._spritesReady = true;
        if (this._onAllSpritesVisible) this._onAllSpritesVisible();
      }
    }

    const t = this._elapsed * NOISE_FREQ;
    for (const entry of this._noiseList1) {
      entry.sprite.position.x = entry.base.x + Math.sin(t + entry.phaseX) * NOISE_AMP;
      entry.sprite.position.y = entry.base.y + Math.sin(t + entry.phaseY) * NOISE_AMP;
    }
    for (const entry of this._noiseList2) {
      entry.sprite.position.x = entry.base.x + Math.sin(t + entry.phaseX) * NOISE_AMP;
      entry.sprite.position.y = entry.base.y + Math.sin(t + entry.phaseY) * NOISE_AMP;
    }

    // Opacité basée sur la distance caméra (remplace le fog)
    if (camera) {
      const range = FOG_FAR - FOG_NEAR;
      for (const e of this._noiseList1) {
        const dist = e.sprite.position.distanceTo(camera.position);
        e.distAlpha = 1 - Math.max(0, Math.min(1, (dist - FOG_NEAR) / range));
        e.mat.opacity = e.loadAlpha * e.distAlpha;
      }
      if (this._lines1) {
        for (const { mat, i, j } of this._lines1.lineObjs) {
          const da = Math.min(this._noiseList1[i].distAlpha, this._noiseList1[j].distAlpha);
          mat.opacity = this._lines1.loadAlpha * CONNECTION_OPACITY * da;
        }
      }
      for (const e of this._noiseList2) {
        const dist = e.sprite.position.distanceTo(camera.position);
        e.distAlpha = 1 - Math.max(0, Math.min(1, (dist - FOG_NEAR) / range));
        e.mat.opacity = e.loadAlpha * e.distAlpha;
      }
      if (this._lines2) {
        for (const { mat, i, j } of this._lines2.lineObjs) {
          const da = Math.min(this._noiseList2[i].distAlpha, this._noiseList2[j].distAlpha);
          mat.opacity = this._lines2.loadAlpha * CONNECTION_OPACITY * da;
        }
      }
    }

    // Hover scale — raycasting + lerp fluide
    if (camera) {
      this._raycaster.setFromCamera(this._pointer, camera);
      const allSprites = [
        ...this._noiseList1.map(e => e.sprite),
        ...this._noiseList2.map(e => e.sprite),
      ];
      const hit = new Set(this._raycaster.intersectObjects(allSprites, false).map(h => h.object));
      const lerpFactor = Math.min(1, delta * HOVER_LERP);
      for (const e of this._noiseList1) {
        e.hoverScale += ((hit.has(e.sprite) ? HOVER_SCALE : 1.0) - e.hoverScale) * lerpFactor;
        e.sprite.scale.setScalar(SPRITE_SIZE * e.hoverScale);
      }
      for (const e of this._noiseList2) {
        e.hoverScale += ((hit.has(e.sprite) ? HOVER_SCALE : 1.0) - e.hoverScale) * lerpFactor;
        e.sprite.scale.setScalar(SPRITE_SIZE * e.hoverScale);
      }
    }

    // Mise à jour des traits de connexion selon les positions actuelles des sprites
    updateConnectionLines(this._lines1, this._noiseList1);
    updateConnectionLines(this._lines2, this._noiseList2);
  }

  setPointer(x, y) {
    this._pointer.set(x, y);
  }

  setLineColor(hexColor) {
    if (this._lines1) for (const { mat } of this._lines1.lineObjs) mat.color.set(hexColor);
    if (this._lines2) for (const { mat } of this._lines2.lineObjs) mat.color.set(hexColor);
  }
}
