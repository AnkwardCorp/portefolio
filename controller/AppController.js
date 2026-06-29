import { Clock, Vector3 } from 'three';
import { SceneModel } from '../model/SceneModel.js';
import { GLBModel } from '../model/GLBModel.js';
import { SceneView } from '../view/SceneView.js';
import { GLBView } from '../view/GLBView.js';
import { UIView } from '../view/UIView.js';

const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches;

const PARAMS = {
  // Scroll – velocity-based
  wheelSensitivity:   1.18,                        // advance-units/s per wheel-delta pixel
  touchSensitivity:   IS_MOBILE ? 6.0 : 4.0,      // advance-units/s per screen-height/s
  maxScrollVel:       25.0,                        // advance-units/s cap
  scrollFriction:     0.3,                         // fraction of velocity remaining after 1 s
  rotationPerAdvance: 0.08,                        // torus rotation (rad) per advance-unit/s
  maxCameraAdvance:   14.0,
  // Torus
  stiffness:         0.06,
  cameraFollowSpeed: 4.0,
  damping:           0.05,
  torus2Factor:      1.5,
  // Parallax
  parallaxAmp:       0.1,
  parallaxLerp:      0.04,
  // UI
  textFadeDuration:       1.2,
  autoAdvanceSpeed:       2.5,   // desktop only
  mobileAdvanceDuration:  0.8,   // secondes pour atteindre la fin sur mobile
  letsGoThreshold:        0.70,
  textThreshold:          0.75,
};

export class AppController {
  constructor(canvas, uiOverlay) {
    this.targetRotationZ = 0;
    this.velZ  = 0;
    this.vel2Z = 0;
    this.clock = new Clock();

    this._scrollVel  = 0;   // advance-units / second

    this.targetCameraAdvance = 0;
    this.cameraAdvance = 0;
    this.prevCameraAdvance = 0;
    this.cameraAdvanceVel = 0;
    this.cameraScrollEnabled = false;

    this.mouseNormX = 0;
    this.mouseNormY = 0;
    this._mouseClientX = 0;
    this._mouseClientY = 0;
    this.cameraMouseX = 0;
    this.cameraMouseY = 0;

    // Tooltip sprite
    this._spriteNotes = [];
    const bubbleStyle = document.createElement('style');
    bubbleStyle.textContent = `
      .sprite-bubble {
        position: fixed;
        pointer-events: none;
        z-index: 100;
        background: rgba(255, 255, 255, 0.18);
        backdrop-filter: blur(14px) saturate(180%);
        -webkit-backdrop-filter: blur(14px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.45);
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.55);
        color: #111;
        padding: 8px 20px;
        border-radius: 50px;
        font-size: 13px;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.18s ease;
        font-family: Roboto, sans-serif;
      }
      body.dark .sprite-bubble {
        background: rgba(30, 30, 40, 0.40);
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.10);
        color: #eee;
      }
    `;
    document.head.appendChild(bubbleStyle);
    this._tooltipEl = document.createElement('div');
    this._tooltipEl.className = 'sprite-bubble';
    document.body.appendChild(this._tooltipEl);
    this._tooltipVisible = false;
    this._tooltipHideTimer = null;
    this._prevHoveredSprite = null;
    fetch('./User_note.json').then(r => r.json()).then(d => { this._spriteNotes = d.followerTexts || []; });

    this._gyroX = 0;
    this._gyroY = 0;
    this._gyroTargetX = 0;
    this._gyroTargetY = 0;

    // Models
    this.sceneModel = new SceneModel();
    this.glbModel = new GLBModel();

    // Views
    this.sceneView = new SceneView(canvas, this.sceneModel);
    this.glbView = new GLBView(this.sceneView.scene, this.glbModel, (glbCamera, maxDim) => {
      this.sceneView.setCamera(glbCamera, maxDim);
    }, () => {
      this.cameraScrollEnabled = true;
    });
    this.uiView = new UIView(uiOverlay);
    this.scrollTextEl = document.getElementById('scroll-text');
    this.bottomLinksEl = document.getElementById('bottom-links');
    this._centerAnchorEl = document.getElementById('center-anchor');
    this.scrollTextVisible = false;
    this._textFadeT = 0;
    this.headerTextChanged = false;
    this._autoAdvance = false;
    this._cameraMaxReached = false;
    this._letsGoBtn = document.getElementById('lets-go-btn');
    this._letsGoHidden = false;

    this._letsGoBtn.addEventListener('click', () => {
      if (!this.cameraScrollEnabled) return;
      this._hideLetsGo();
      this._autoAdvance = true;
    });

    // Scroll – velocity-based, device-agnostic
    window.addEventListener('wheel', (e) => {
      // Normaliser selon deltaMode pour un comportement cohérent indépendant de l'écran
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 40;   // lignes → pixels
      if (e.deltaMode === 2) d *= 800;  // pages → pixels (référence fixe, pas window.innerHeight)
      const kick = Math.sign(d) * Math.min(Math.abs(d), 300) * PARAMS.wheelSensitivity;
      this._scrollVel = Math.max(-PARAMS.maxScrollVel, Math.min(PARAMS.maxScrollVel, this._scrollVel + kick));
    });

    this._lastTouchY    = null;
    this._lastTouchTime = null;
    window.addEventListener('touchstart', (e) => {
      this._lastTouchY    = e.touches[0].clientY;
      this._lastTouchTime = performance.now();
      this._scrollVel    *= 0.25; // dampen inertia on re-grab
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (this._lastTouchY === null) return;
      if (IS_MOBILE) {
        // Mobile : tout scroll déclenche l'avance automatique directe
        if (!this._autoAdvance && this.cameraScrollEnabled) {
          this._hideLetsGo();
          this._autoAdvance = true;
        }
        this._lastTouchY    = e.touches[0].clientY;
        this._lastTouchTime = performance.now();
        return;
      }
      // Desktop : tracking de vélocité
      const now   = performance.now();
      const dtMs  = Math.max(now - this._lastTouchTime, 1);
      const dy    = this._lastTouchY - e.touches[0].clientY;
      const vel   = (dy / window.innerHeight) / (dtMs / 1000) * PARAMS.touchSensitivity;
      this._scrollVel = this._scrollVel * 0.25 + vel * 0.75;
      this._scrollVel = Math.max(-PARAMS.maxScrollVel, Math.min(PARAMS.maxScrollVel, this._scrollVel));
      this._lastTouchY    = e.touches[0].clientY;
      this._lastTouchTime = now;
    }, { passive: true });
    window.addEventListener('touchend', () => {
      this._lastTouchY    = null;
      this._lastTouchTime = null;
    }, { passive: true });

    // Dark mode
    this._isDark = localStorage.getItem('darkMode') === 'true';
    this._applyDark(this._isDark);
    document.getElementById('theme-toggle').addEventListener('click', () => {
      this._isDark = !this._isDark;
      localStorage.setItem('darkMode', this._isDark);
      const overlay = document.getElementById('theme-fade');
      overlay.style.background = this._isDark ? '#000' : '#fff';
      overlay.style.opacity = '1';
      setTimeout(() => {
        this._applyDark(this._isDark);
        overlay.style.opacity = '0';
      }, 250);
    });

    window.addEventListener('mousemove', (e) => {
      this.mouseNormX =  (e.clientX / window.innerWidth  - 0.5) * 2;
      this.mouseNormY = -(e.clientY / window.innerHeight - 0.5) * 2;
      this._mouseClientX = e.clientX;
      this._mouseClientY = e.clientY;
      this.glbView.setPointer(this.mouseNormX, this.mouseNormY);
    });

    // Gyroscope — parallax sprites sur mobile
    if (IS_MOBILE) {
      const startGyro = () => {
        window.addEventListener('deviceorientation', (e) => {
          if (e.gamma === null && e.beta === null) return;
          this._gyroTargetX = Math.max(-1, Math.min(1, -(e.gamma || 0) / 45));
          this._gyroTargetY = Math.max(-1, Math.min(1,  ((e.beta  || 0) - 45) / 45));
        });
      };

      // iOS 13+ : requestPermission() doit être appelé depuis un click handler sur un élément
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const btn = document.createElement('button');
        btn.id = 'gyro-permission-btn';
        btn.textContent = 'Activer le mouvement';
        document.body.appendChild(btn);
        btn.addEventListener('click', () => {
          DeviceOrientationEvent.requestPermission()
            .then(state => {
              if (state === 'granted') startGyro();
              btn.remove();
            })
            .catch(() => btn.remove());
        });
      } else {
        startGyro();
      }
    }

    window.addEventListener('resize', () => this.sceneView.onResize());
  }

  start() {
    this.uiView.showLoading();
    setTimeout(() => this.uiView.hideLoading(), 1000);
    this._loop();
  }

  _loop() {
    requestAnimationFrame(() => this._loop());

    const rawDelta = this.clock.getDelta();

    if (this.glbView.mixer) this.glbView.mixer.update(rawDelta);
    this.glbView.update(rawDelta, this.sceneView.camera);

    // ── Targets — tous frame-rate independent via rawDelta ────────────────────


    // Scroll velocity → targets (decay exponentiel = frame-rate independent)
    this._scrollVel *= Math.pow(PARAMS.scrollFriction, rawDelta);
    if (Math.abs(this._scrollVel) > 1e-4) {
      this.targetRotationZ += this._scrollVel * rawDelta * PARAMS.rotationPerAdvance;
      if (this.cameraScrollEnabled) {
        this.targetCameraAdvance = Math.max(0, Math.min(PARAMS.maxCameraAdvance,
          this.targetCameraAdvance + this._scrollVel * rawDelta));
        if (this.targetCameraAdvance <= 0)                       this._scrollVel = Math.max(0, this._scrollVel);
        if (this.targetCameraAdvance >= PARAMS.maxCameraAdvance) this._scrollVel = Math.min(0, this._scrollVel);
      }
    }

    // ── Rotation torus — substeps pour stabilité Euler à bas FPS ─────────────
    const PHYS_STEP = 1 / 60;
    const numSteps  = Math.max(1, Math.ceil(rawDelta / PHYS_STEP));
    for (let s = 0; s < numSteps; s++) {
      this.velZ  = (this.velZ  + (this.targetRotationZ - this.glbView.group.rotation.z)  * PARAMS.stiffness) * PARAMS.damping;
      this.vel2Z = (this.vel2Z + (this.targetRotationZ * PARAMS.torus2Factor - this.glbView.group2.rotation.z) * PARAMS.stiffness) * PARAMS.damping;
      this.glbView.group.rotation.z  += this.velZ;
      this.glbView.group2.rotation.z += this.vel2Z;
    }

    // ── Avance caméra — lerp exponentiel (analytiquement frame-rate independent)
    const camAlpha = 1 - Math.exp(-PARAMS.cameraFollowSpeed * rawDelta);

    if (this._autoAdvance) {
      // Avance directe à vitesse constante (mobile ET desktop) — frame-rate independent
      const speed = PARAMS.maxCameraAdvance / PARAMS.mobileAdvanceDuration;
      this.cameraAdvance = Math.min(this.cameraAdvance + speed * rawDelta, PARAMS.maxCameraAdvance);
      this.targetCameraAdvance = this.cameraAdvance;
      if (this.cameraAdvance >= PARAMS.maxCameraAdvance) {
        this._autoAdvance = false;
        if (!this._cameraMaxReached) {
          this._cameraMaxReached = true;
          window.dispatchEvent(new CustomEvent('cameraAtMax'));
        }
      }
    } else {
      // Spring exponentiel pour le scroll manuel
      this.cameraAdvance += (this.targetCameraAdvance - this.cameraAdvance) * camAlpha;
    }
    this.cameraAdvanceVel = (this.cameraAdvance - this.prevCameraAdvance) / Math.max(rawDelta, 1e-4);
    this.sceneView.camera.position.z -= (this.cameraAdvance - this.prevCameraAdvance);
    this.prevCameraAdvance = this.cameraAdvance;

    if (this.cameraAdvance >= PARAMS.maxCameraAdvance * PARAMS.letsGoThreshold) this._hideLetsGo();
    else if (!this._autoAdvance) this._showLetsGo();

    // Gyroscope mobile — lissage et alimentation du parallax
    if (IS_MOBILE) {
      const gyroAlpha = 1 - Math.exp(-5 * rawDelta);
      this._gyroX += (this._gyroTargetX - this._gyroX) * gyroAlpha;
      this._gyroY += (this._gyroTargetY - this._gyroY) * gyroAlpha;
      // Réutilise le système parallax caméra existant
      this.mouseNormX = this._gyroX;
      this.mouseNormY = this._gyroY;
      // Décalage direct des groupes de sprites pour un effet de profondeur
      const gAmp = 0.25;
      this.glbView.group.position.x  = this._gyroX * gAmp;
      this.glbView.group.position.y  = this._gyroY * gAmp;
      this.glbView.group2.position.x = this._gyroX * gAmp * PARAMS.torus2Factor;
      this.glbView.group2.position.y = this._gyroY * gAmp * PARAMS.torus2Factor;
    }

    // Parallax souris — exponentiel pour indépendance au framerate
    const parallaxAlpha = 1 - Math.exp(-PARAMS.parallaxLerp * 60 * rawDelta);
    this.cameraMouseX += (this.mouseNormX * PARAMS.parallaxAmp - this.cameraMouseX) * parallaxAlpha;
    this.cameraMouseY += (this.mouseNormY * PARAMS.parallaxAmp - this.cameraMouseY) * parallaxAlpha;
    this.sceneView.camera.position.x = this.cameraMouseX;
    this.sceneView.camera.position.y = this.cameraMouseY;

    // Fade texte
    if (this.cameraAdvance >= PARAMS.maxCameraAdvance * PARAMS.textThreshold) {
      this._textFadeT = Math.min(1, this._textFadeT + rawDelta / PARAMS.textFadeDuration);
    } else {
      this._textFadeT = Math.max(0, this._textFadeT - rawDelta / PARAMS.textFadeDuration);
    }
    const opacity = this._textFadeT * this._textFadeT * (3 - 2 * this._textFadeT);
    if (opacity > 0.01 && !this.scrollTextVisible) {
      this.scrollTextEl.classList.add('visible');
      this.bottomLinksEl.classList.add('visible');
      this.scrollTextVisible = true;
    } else if (opacity <= 0.01 && this.scrollTextVisible) {
      this.scrollTextEl.classList.remove('visible');
      this.bottomLinksEl.classList.remove('visible');
      this.scrollTextVisible = false;
    }
    this._centerAnchorEl.style.transform = `translateY(${-opacity * 120}px)`;
    this.scrollTextEl.style.opacity = opacity;
    this.scrollTextEl.style.transform = `translateX(-50%) translateY(${(1 - opacity) * 12}px)`;
    this.bottomLinksEl.style.opacity = opacity;

    // Tooltip sprite — positionné sur le sprite en espace écran
    const hovered = this.glbView.hoveredSprite;
    if (hovered && this._spriteNotes.length > 0) {
      if (hovered !== this._prevHoveredSprite) {
        // Nouveau sprite : cacher immédiatement et attendre 1s avant d'afficher
        clearTimeout(this._tooltipHideTimer);
        this._tooltipEl.style.opacity = '0';
        this._tooltipVisible = false;
        const text = this._spriteNotes[Math.floor(Math.random() * this._spriteNotes.length)];
        this._tooltipHideTimer = setTimeout(() => {
          if (this.glbView.hoveredSprite === hovered) {
            this._tooltipEl.textContent = text;
            this._tooltipEl.style.opacity = '1';
            this._tooltipVisible = true;
          }
        }, 200);
      }
      // Mettre à jour la position chaque frame
      const worldPos = hovered.getWorldPosition(new Vector3());
      worldPos.project(this.sceneView.camera);
      const sx = ( worldPos.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-worldPos.y * 0.5 + 0.5) * window.innerHeight;
      const hw = this._tooltipEl.offsetWidth / 2;
      this._tooltipEl.style.left = `${sx - hw}px`;
      this._tooltipEl.style.top  = `${sy + 28}px`;
    } else if (this._tooltipVisible) {
      clearTimeout(this._tooltipHideTimer);
      this._tooltipEl.style.opacity = '0';
      this._tooltipVisible = false;
    }
    this._prevHoveredSprite = hovered;

    this.sceneView.render();
  }

  _hideLetsGo() {
    if (this._letsGoHidden) return;
    this._letsGoHidden = true;
    this._letsGoBtn.style.pointerEvents = 'none';
    this._letsGoBtn.style.opacity = '0';
  }

  _showLetsGo() {
    if (!this._letsGoHidden) return;
    this._letsGoHidden = false;
    this._letsGoBtn.style.opacity = '1';
    this._letsGoBtn.style.pointerEvents = 'auto';
  }

  _applyDark(dark) {
    document.body.classList.toggle('dark', dark);
    this.glbView.setLineColor(dark ? 0xffffff : 0x999999);
    document.getElementById('theme-toggle').textContent = dark ? '🌞' : '🌙';
  }
}
