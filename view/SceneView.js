import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse:  { value: null },
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
    uniform float intensity;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - vec2(0.5);
      vec4 r = texture2D(tDiffuse, vUv + dir * intensity);
      vec4 g = texture2D(tDiffuse, vUv);
      vec4 b = texture2D(tDiffuse, vUv - dir * intensity);
      gl_FragColor = vec4(r.r, g.g, b.b, g.a);
    }
  `,
};

const GrainShader = {
  uniforms: {
    tDiffuse: { value: null },
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

export class SceneView {
  constructor(canvas, sceneModel) {
    this.model = sceneModel;
    this._startTime = performance.now();

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = createGradientTexture('#ffffff', '#B5B5B5'); 

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );
    this.camera.position.set(0, 0, 5);

    // Lights
    const ambient = new THREE.AmbientLight(
      this.model.ambientLightColor,
      this.model.ambientLightIntensity
    );
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(
      this.model.directionalLightColor,
      this.model.directionalLightIntensity
    );
    const { x, y, z } = this.model.directionalLightPosition;
    dirLight.position.set(x, y, z);
    this.scene.add(dirLight);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.chromaticPass = new ShaderPass(ChromaticAberrationShader);
    this.composer.addPass(this.chromaticPass);

    this.grainPass = new ShaderPass(GrainShader);
    this.composer.addPass(this.grainPass);
  }

  setCamera(glbCamera, maxDim) {
    if (glbCamera) {
      glbCamera.aspect = window.innerWidth / window.innerHeight;
      glbCamera.updateProjectionMatrix();
      this.camera = glbCamera;

      this.renderPass = new RenderPass(this.scene, this.camera);
      this.composer.passes[0] = this.renderPass;
    } else {
      const distance = maxDim * 2.5;
      this.camera.position.set(0, 0, distance);
      this.camera.near = distance * 0.01;
      this.camera.far = distance * 100;
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();
    }
  }

  setBackground(dark) {
    if (!dark) {
      this.scene.background = createGradientTexture('#ffffff', '#DADADA');
    } else {
      this.scene.background = createGradientTexture('#1E1E1E', '#000000');
    }
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  setScrollVelocity(_vel) {
    this.chromaticPass.uniforms.intensity.value = 0;
  }

  render() {
    this.grainPass.uniforms.time.value = (performance.now() - this._startTime) * 0.001;
    this.composer.render();
  }
}
