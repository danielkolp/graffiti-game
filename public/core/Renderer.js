import * as THREE from '../vendor/three/build/three.module.js';
import { EffectComposer } from '../vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from '../vendor/three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from '../vendor/three/examples/jsm/shaders/FXAAShader.js';
import { UnrealBloomPass } from '../vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';

export class RendererSystem {
  constructor(options = {}) {
    this.options = {
      maxPixelRatio: 1.5,
      enableBloom: true,
      bloomStrength: 0.12,
      bloomRadius: 0.18,
      bloomThreshold: 0.92,
      ...options
    };

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance'
    });

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.physicallyCorrectLights = true;
    this.renderer.useLegacyLights = false;

    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = null;

    this.fxaaPass = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaaPass);

    this.bloomPass = null;
    if (this.options.enableBloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        this.options.bloomStrength,
        this.options.bloomRadius,
        this.options.bloomThreshold
      );
      this.composer.addPass(this.bloomPass);
    }

    this.resizeCallbacks = [];
    this._updateFxaaResolution();
  }

  getDomElement() {
    return this.renderer.domElement;
  }

  attachTo(container) {
    container.appendChild(this.renderer.domElement);
  }

  setSceneAndCamera(scene, camera) {
    if (this.renderPass) {
      this.composer.removePass(this.renderPass);
    }

    this.renderPass = new RenderPass(scene, camera);
    this.composer.insertPass(this.renderPass, 0);
  }

  onResize(callback) {
    this.resizeCallbacks.push(callback);
  }

  resize(width = window.innerWidth, height = window.innerHeight) {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this._updateFxaaResolution(width, height);

    if (this.bloomPass) {
      this.bloomPass.setSize(width, height);
    }

    for (const callback of this.resizeCallbacks) {
      callback(width, height, this.pixelRatio);
    }
  }

  render(deltaSeconds) {
    this.composer.render(deltaSeconds);
  }

  getInfo() {
    return this.renderer.info;
  }

  _updateFxaaResolution(width = window.innerWidth, height = window.innerHeight) {
    this.fxaaPass.material.uniforms.resolution.value.x = 1 / (width * this.pixelRatio);
    this.fxaaPass.material.uniforms.resolution.value.y = 1 / (height * this.pixelRatio);
  }
}
