import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { Octree } from '../vendor/three/examples/jsm/math/Octree.js';

const CITY_MODEL_CANDIDATES = [
  '../City.glb',
  '../../City.glb',
  '/City.glb'
];
const CITY_LOAD_TIMEOUT_MS = 15000;

function toStandardMaterial(material, roughnessSeed) {
  if (!material) {
    return null;
  }

  const preserveCutout = !!material.alphaMap;
  const transparent = preserveCutout;
  const alphaTest = preserveCutout ? 0.25 : 0;

  if (material.isMeshStandardMaterial) {
    material.roughness = THREE.MathUtils.clamp(0.5 + roughnessSeed * 0.3, 0.2, 1.0);
    material.metalness = THREE.MathUtils.clamp(0.03 + roughnessSeed * 0.08, 0.0, 0.2);
    material.side = THREE.FrontSide;
    material.transparent = transparent;
    material.opacity = 1;
    material.depthWrite = true;
    material.alphaTest = alphaTest;
    material.envMapIntensity = 0.18;
    material.needsUpdate = true;
    return material;
  }

  const converted = new THREE.MeshStandardMaterial({
    color: material.color ? material.color.clone() : new THREE.Color(0xffffff),
    map: material.map || null,
    normalMap: material.normalMap || null,
    roughnessMap: material.roughnessMap || null,
    metalnessMap: material.metalnessMap || null,
    aoMap: material.aoMap || null,
    emissiveMap: material.emissiveMap || null,
    emissive: material.emissive ? material.emissive.clone() : new THREE.Color(0x000000),
    alphaMap: material.alphaMap || null,
    transparent,
    opacity: 1,
    depthWrite: true,
    alphaTest,
    roughness: THREE.MathUtils.clamp(0.5 + roughnessSeed * 0.3, 0.2, 1),
    metalness: THREE.MathUtils.clamp(0.03 + roughnessSeed * 0.08, 0.0, 0.2),
    envMapIntensity: 0.18
  });

  converted.side = THREE.FrontSide;
  return converted;
}

export class SceneManager {
  constructor(onProgress = () => {}) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x7b94b4, 75, 290);
    this.scene.background = new THREE.Color(0x8baed0);
    this.scene.environment = null;

    this.worldOctree = new Octree();
    this.collidableMeshes = [];
    this.cityRoot = null;

    this.backgroundDay = new THREE.Color(0x8bb9ea);
    this.fogDay = new THREE.Color(0x8ca8ca);

    this.sunLight = null;
    this.moonLight = null;
    this.hemiLight = null;
    this.ambientLight = null;

    this.loadingManager = new THREE.LoadingManager();
    this.loadingManager.onProgress = (url, itemsLoaded, itemsTotal) => {
      const progress = itemsTotal > 0 ? itemsLoaded / itemsTotal : 0;
      onProgress(progress, `Loading ${itemsLoaded}/${itemsTotal}`);
    };

    this.loadingManager.onError = (url) => {
      console.error(`Failed to load asset: ${url}`);
    };

    this.gltfLoader = new GLTFLoader(this.loadingManager);
  }

  getScene() {
    return this.scene;
  }

  getCollidableMeshes() {
    return this.collidableMeshes;
  }

  getWorldOctree() {
    return this.worldOctree;
  }

  async initialize() {
    this._setupLights();
    this._setupGround();

    const results = await Promise.allSettled([
      this._loadEnvironment(),
      this._loadCity()
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('Scene initialization step failed:', result.reason);
      }
    }
  }

  update(deltaSeconds, renderer = null) {
    if (!this.sunLight || !this.moonLight || !this.hemiLight || !this.ambientLight) {
      return;
    }

    this.sunLight.position.set(82, 118, 46);
    this.moonLight.position.set(-82, -118, -46);

    this.sunLight.intensity = 2.35;
    this.sunLight.color.setHex(0xfff1d6);

    this.moonLight.intensity = 0.04;
    this.moonLight.color.setHex(0x8ea9ff);

    this.hemiLight.intensity = 0.46;
    this.ambientLight.intensity = 0.14;

    this.scene.background.copy(this.backgroundDay);
    this.scene.fog.color.copy(this.fogDay);

    if (renderer) {
      renderer.toneMappingExposure = 1.04;
    }
  }

  async _loadEnvironment() {
    this.scene.environment = null;
  }

  async _loadCity() {
    let gltf = null;
    try {
      gltf = await this._loadCityModelWithCandidates();
    } catch (error) {
      console.warn('City model failed to load, using fallback city:', error);
      this._createFallbackCity();
      return;
    }

    const city = gltf.scene;
    city.scale.setScalar(40);
    city.position.set(0, 0, 0);

    let meshCount = 0;
    city.traverse((node) => {
      if (!node.isMesh || !node.geometry) {
        return;
      }

      meshCount += 1;
      node.castShadow = false;
      node.receiveShadow = true;
      node.frustumCulled = true;

      const roughnessSeed = (meshCount % 11) / 11;
      if (Array.isArray(node.material)) {
        node.material = node.material.map((material) => toStandardMaterial(material, roughnessSeed));
      } else {
        node.material = toStandardMaterial(node.material, roughnessSeed);
      }

      if (!node.geometry.attributes.normal) {
        node.geometry.computeVertexNormals();
      }

      this.collidableMeshes.push(node);
    });

    this.cityRoot = city;
    this.scene.add(city);

    this.worldOctree.fromGraphNode(city);
  }

  async _loadCityModelWithCandidates() {
    const errors = [];

    for (const candidateUrl of CITY_MODEL_CANDIDATES) {
      try {
        return await this._withTimeout(
          this.gltfLoader.loadAsync(candidateUrl),
          CITY_LOAD_TIMEOUT_MS
        );
      } catch (error) {
        errors.push(`${candidateUrl}: ${error.message || String(error)}`);
      }
    }

    throw new Error(`All city model URLs failed. ${errors.join(' | ')}`);
  }

  _createFallbackCity() {
    const fallbackGroup = new THREE.Group();
    fallbackGroup.name = 'FallbackCity';

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x5d6770,
      roughness: 0.86,
      metalness: 0.05,
      envMapIntensity: 0.15
    });

    const boxGeometry = new THREE.BoxGeometry(12, 8, 12);
    const count = 12;
    for (let i = 0; i < count; i += 1) {
      const mesh = new THREE.Mesh(boxGeometry, wallMaterial.clone());
      const angle = (i / count) * Math.PI * 2;
      const radius = 28 + ((i % 3) * 8);
      mesh.position.set(Math.cos(angle) * radius, 4, Math.sin(angle) * radius);
      mesh.rotation.y = angle * 0.5;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      fallbackGroup.add(mesh);
      this.collidableMeshes.push(mesh);
    }

    const corridorWallGeometry = new THREE.BoxGeometry(3, 6, 40);
    const leftWall = new THREE.Mesh(corridorWallGeometry, wallMaterial.clone());
    leftWall.position.set(-8, 3, 0);
    const rightWall = new THREE.Mesh(corridorWallGeometry, wallMaterial.clone());
    rightWall.position.set(8, 3, 0);
    fallbackGroup.add(leftWall, rightWall);
    this.collidableMeshes.push(leftWall, rightWall);

    this.cityRoot = fallbackGroup;
    this.scene.add(fallbackGroup);
    this.worldOctree.fromGraphNode(fallbackGroup);
  }

  _setupLights() {
    this.ambientLight = new THREE.AmbientLight(0x94b9ff, 0.08);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(0x8cb3ff, 0x2d332c, 0.3);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff1d6, 2.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 260;
    this.sunLight.shadow.camera.left = -95;
    this.sunLight.shadow.camera.right = 95;
    this.sunLight.shadow.camera.top = 95;
    this.sunLight.shadow.camera.bottom = -95;
    this.sunLight.shadow.bias = -0.00008;
    this.scene.add(this.sunLight);

    this.moonLight = new THREE.DirectionalLight(0x8ea9ff, 0.3);
    this.moonLight.castShadow = false;
    this.scene.add(this.moonLight);
  }

  _setupGround() {
    const groundGeometry = new THREE.PlaneGeometry(1200, 1200);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x4f5750,
      roughness: 0.95,
      metalness: 0.01,
      envMapIntensity: 0.08
    });

    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.position.y = -0.45;
    ground.name = 'GroundPlane';
    this.scene.add(ground);
  }

  _withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
