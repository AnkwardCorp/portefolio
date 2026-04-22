import * as THREE from 'three';

export class SceneView {
  constructor(canvas, sceneModel) {
    this.model = sceneModel;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    //this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    // Scene (pas de background — le gradient est rendu par le body CSS)
    this.scene = new THREE.Scene();

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
  }

  setCamera(glbCamera, maxDim) {
    if (glbCamera) {
      glbCamera.aspect = window.innerWidth / window.innerHeight;
      glbCamera.updateProjectionMatrix();
      this.camera = glbCamera;
    } else {
      const distance = maxDim * 2.5;
      this.camera.position.set(0, 0, distance);
      this.camera.near = distance * 0.01;
      this.camera.far = distance * 100;
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();
    }
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
