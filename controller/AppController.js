import { Clock } from 'three';
import { Pane } from 'tweakpane';
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
  textFadeDuration:       0.5,
  autoAdvanceSpeed:       2.5,   // desktop only
  mobileAdvanceDuration:  0.8,   // secondes pour atteindre la fin sur mobile
  letsGoThreshold:        0.70,
  textThreshold:          0.80,
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
    this.cameraMouseX = 0;
    this.cameraMouseY = 0;

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
    this.scrollTextVisible = false;
    this._scrollTextNaturalH = 0;
    this._textFadeT = 0;
    this.headerSubtitleEl = document.getElementById('header-subtitle');
    this.headerTextChanged = false;
    this._autoAdvance = false;
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

    // Tweakpane
    // this._initPane();
  }

  _initPane() {
    const pane = new Pane({ title: `Params (${IS_MOBILE ? 'mobile' : 'desktop'})` });

    const fScroll = pane.addFolder({ title: 'Scroll' });
    fScroll.addBinding(PARAMS, 'wheelSensitivity',  { min: 0,   max: 0.3,  step: 0.001, label: 'wheel sens.' });
    fScroll.addBinding(PARAMS, 'touchSensitivity',  { min: 0,   max: 20,   step: 0.1,   label: 'touch sens.' });
    fScroll.addBinding(PARAMS, 'maxScrollVel',      { min: 1,   max: 60,   step: 0.5,   label: 'max vel.' });
    fScroll.addBinding(PARAMS, 'scrollFriction',    { min: 0,   max: 0.5,  step: 0.001, label: 'friction' });
    fScroll.addBinding(PARAMS, 'rotationPerAdvance',{ min: 0,   max: 0.5,  step: 0.001, label: 'rotation/adv.' });
    fScroll.addBinding(PARAMS, 'maxCameraAdvance',  { min: 1,   max: 30,   step: 0.1,   label: 'max advance' });

    const fTorus = pane.addFolder({ title: 'Torus' });
    fTorus.addBinding(PARAMS, 'stiffness',    { min: 0, max: 0.3,  step: 0.001, label: 'stiffness' });
    fTorus.addBinding(PARAMS, 'cameraFollowSpeed', { min: 0.1, max: 20, step: 0.1, label: 'cam follow speed' });
    fTorus.addBinding(PARAMS, 'damping',      { min: 0, max: 0.3,  step: 0.001, label: 'damping' });
    fTorus.addBinding(PARAMS, 'torus2Factor', { min: 0, max: 5,    step: 0.01,  label: 'torus2 factor' });

    const fParallax = pane.addFolder({ title: 'Parallax' });
    fParallax.addBinding(PARAMS, 'parallaxAmp',  { min: 0, max: 1,    step: 0.01,  label: 'amplitude' });
    fParallax.addBinding(PARAMS, 'parallaxLerp', { min: 0, max: 0.2,  step: 0.001, label: 'lerp' });

    const fUI = pane.addFolder({ title: 'UI' });
    fUI.addBinding(PARAMS, 'textFadeDuration',      { min: 0.1, max: 2,  step: 0.05,  label: 'text fade dur.' });
    fUI.addBinding(PARAMS, 'autoAdvanceSpeed',      { min: 0.5, max: 10, step: 0.1,   label: 'lets go speed (desktop)' });
    fUI.addBinding(PARAMS, 'mobileAdvanceDuration', { min: 0.2, max: 3,  step: 0.05,  label: 'mobile advance dur. (s)' });
    fUI.addBinding(PARAMS, 'letsGoThreshold',       { min: 0,   max: 1,  step: 0.01,  label: 'lets go hide %' });
    fUI.addBinding(PARAMS, 'textThreshold',         { min: 0,   max: 1,  step: 0.01,  label: 'text appear %' });
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
      if (this.cameraAdvance >= PARAMS.maxCameraAdvance) this._autoAdvance = false;
    } else {
      // Spring exponentiel pour le scroll manuel
      this.cameraAdvance += (this.targetCameraAdvance - this.cameraAdvance) * camAlpha;
    }
    this.cameraAdvanceVel = (this.cameraAdvance - this.prevCameraAdvance) / Math.max(rawDelta, 1e-4);
    this.sceneView.camera.position.z -= (this.cameraAdvance - this.prevCameraAdvance);
    this.prevCameraAdvance = this.cameraAdvance;

    if (this.cameraAdvance >= PARAMS.maxCameraAdvance * PARAMS.letsGoThreshold) this._hideLetsGo();
    else if (!this._autoAdvance) this._showLetsGo();

    this.sceneView.setScrollVelocity(this.cameraAdvanceVel);

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
    if (!this._scrollTextNaturalH && opacity > 0) {
      this.scrollTextEl.style.height = 'auto';
      this._scrollTextNaturalH = this.scrollTextEl.offsetHeight;
      this.scrollTextEl.style.height = '0';
    }
    this.scrollTextEl.style.height    = `${opacity * this._scrollTextNaturalH}px`;
    this.scrollTextEl.style.marginTop = `${opacity * 20}px`;
    this.scrollTextEl.style.opacity   = opacity;
    this.bottomLinksEl.style.opacity  = opacity;

    if (!this.headerTextChanged && this._textFadeT > 0) {
      this.headerTextChanged = true;
      this.headerSubtitleEl.style.transition = 'opacity 0.4s ease';
      this.headerSubtitleEl.style.opacity = '0';
      setTimeout(() => {
        this.headerSubtitleEl.textContent = 'Work with creatives';
        this.headerSubtitleEl.style.opacity = '1';
      }, 400);
    } else if (this.headerTextChanged && this._textFadeT === 0) {
      this.headerTextChanged = false;
      this.headerSubtitleEl.style.transition = 'opacity 0.4s ease';
      this.headerSubtitleEl.style.opacity = '0';
      setTimeout(() => {
        this.headerSubtitleEl.textContent = 'Followed by creatives';
        this.headerSubtitleEl.style.opacity = '1';
      }, 400);
    }

    this.sceneView.render();
  }

  _hideLetsGo() {
    if (this._letsGoHidden) return;
    this._letsGoHidden = true;
    this._letsGoBtn.style.pointerEvents = 'none';
    this._letsGoBtn.style.opacity = '0';
    clearTimeout(this._letsGoTimer);
    this._letsGoTimer = setTimeout(() => {
      if (!this._letsGoHidden) return;
      this._letsGoBtn.style.height = '0';
      this._letsGoBtn.style.marginTop = '0';
      this._letsGoBtn.style.overflow = 'hidden';
    }, 400);
  }

  _showLetsGo() {
    if (!this._letsGoHidden) return;
    this._letsGoHidden = false;
    clearTimeout(this._letsGoTimer);
    this._letsGoBtn.style.height = '';
    this._letsGoBtn.style.marginTop = '';
    this._letsGoBtn.style.overflow = '';
    this._letsGoBtn.style.opacity = '1';
    this._letsGoBtn.style.pointerEvents = 'auto';
  }

  _applyDark(dark) {
    document.body.classList.toggle('dark', dark);
    this.sceneView.setBackground(dark);
    this.glbView.setLineColor(dark ? 0xffffff : 0x999999);
    document.getElementById('theme-toggle').textContent = dark ? '☀' : '☽';
  }
}
