export class SceneModel {
  constructor() {
    this.backgroundColor = 0xffffff;
    this.ambientLightColor = 0xffffff;
    this.ambientLightIntensity = 0.4;
    this.directionalLightColor = 0xffffff;
    this.directionalLightIntensity = 1.2;
    this.directionalLightPosition = { x: 5, y: 5, z: 5 };
  }
}
