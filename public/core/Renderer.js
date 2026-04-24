import * as THREE from '../vendor/three/build/three.module.js';
import { EffectComposer } from '../vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { RenderPixelatedPass } from '../vendor/three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { ShaderPass } from '../vendor/three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from '../vendor/three/examples/jsm/shaders/FXAAShader.js';
import { UnrealBloomPass } from '../vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';

const StylizePosterizeShader = {
  uniforms: {
    tDiffuse: { value: null },
    levels: { value: 20.0 },
    amount: { value: 0.36 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float levels;
    uniform float amount;
    varying vec2 vUv;

    void main() {
      vec4 source = texture2D(tDiffuse, vUv);
      float safeLevels = max(2.0, levels);
      vec3 poster = floor(source.rgb * (safeLevels - 1.0) + 0.5) / (safeLevels - 1.0);
      vec3 color = mix(source.rgb, poster, clamp(amount, 0.0, 1.0));
      gl_FragColor = vec4(color, source.a);
    }
  `
};

const STYLIZE_PRESETS = {
  off: { enabled: false, levels: 24, amount: 0.0 },
  soft: { enabled: true, levels: 20, amount: 0.36 },
  medium: { enabled: true, levels: 14, amount: 0.5 }
};

export class RendererSystem {
  constructor(options = {}) {
    this.options = {
      maxPixelRatio: 2,
      enableBloom: true,
      bloomStrength: 0.12,
      bloomRadius: 0.18,
      bloomThreshold: 0.92,
      enablePixelation: true,
      pixelationStrength: 0.4,
      pixelationCellSize: 0.7,
      stylizePreset: 'soft',
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

    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = null;
    this.pixelationPass = null;

    this.fxaaPass = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaaPass);

    this.stylizePass = new ShaderPass(StylizePosterizeShader);
    this.composer.addPass(this.stylizePass);

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
    this.setStylizePreset(this.options.stylizePreset);
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

    if (this.pixelationPass) {
      this.composer.removePass(this.pixelationPass);
    }

    this.renderPass = new RenderPass(scene, camera);
    this.composer.insertPass(this.renderPass, 0);

    this.pixelationPass = new RenderPixelatedPass(this._pixelSizeFromStrength(this.options.pixelationStrength), scene, camera, {
      normalEdgeStrength: 0,
      depthEdgeStrength: 0
    });
    this.pixelationPass.enabled = this.options.enablePixelation === true;
    this.composer.addPass(this.pixelationPass);

    this.setPixelationStrength(this.options.pixelationStrength);
    this.setPixelationCellSize(this.options.pixelationCellSize);
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

  setPixelationEnabled(enabled) {
    this.options.enablePixelation = enabled === true;
    if (this.pixelationPass) {
      this.pixelationPass.enabled = this.options.enablePixelation;
    }
  }

  setPixelationStrength(amount) {
    const safeAmount = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0.2;
    this.options.pixelationStrength = safeAmount;
    if (this.pixelationPass) {
      const combinedPixelSize = THREE.MathUtils.clamp(
        this._pixelSizeFromStrength(safeAmount) * this.options.pixelationCellSize,
        1,
        16
      );
      this.pixelationPass.setPixelSize(combinedPixelSize);
      console.info(
        '[PostFX] pixelation updated strength=%s cellSize=%s pixelSize=%s',
        safeAmount.toFixed(2),
        this.options.pixelationCellSize.toFixed(2),
        combinedPixelSize.toFixed(2)
      );
    }
  }

  setPixelationCellSize(cellSize) {
    const safeCellSize = Number.isFinite(cellSize) ? THREE.MathUtils.clamp(cellSize, 0.5, 6) : 1;
    this.options.pixelationCellSize = safeCellSize;
    if (this.pixelationPass) {
      this.pixelationPass.normalEdgeStrength = 0;
      this.pixelationPass.depthEdgeStrength = 0;
      this.setPixelationStrength(this.options.pixelationStrength);
    }
  }

  setStylizePreset(presetName) {
    const nextPreset = STYLIZE_PRESETS[presetName] || STYLIZE_PRESETS.soft;

    this.stylizePass.enabled = nextPreset.enabled;
    this.stylizePass.uniforms.levels.value = nextPreset.levels;
    this.stylizePass.uniforms.amount.value = nextPreset.amount;
    this.stylizePreset = presetName in STYLIZE_PRESETS ? presetName : 'soft';
  }

  cycleStylizePreset() {
    const order = ['off', 'soft', 'medium'];
    const currentIndex = Math.max(0, order.indexOf(this.stylizePreset || 'soft'));
    const nextPreset = order[(currentIndex + 1) % order.length];
    this.setStylizePreset(nextPreset);
    return nextPreset;
  }

  getInfo() {
    return this.renderer.info;
  }

  _updateFxaaResolution(width = window.innerWidth, height = window.innerHeight) {
    this.fxaaPass.material.uniforms.resolution.value.x = 1 / (width * this.pixelRatio);
    this.fxaaPass.material.uniforms.resolution.value.y = 1 / (height * this.pixelRatio);
  }

  _pixelSizeFromStrength(strength = 0.2) {
    // Strength 0 -> 1 maps to pixel sizes 2 -> 8 for a stronger stylized look.
    return THREE.MathUtils.clamp(2 + Math.round(THREE.MathUtils.clamp(strength, 0, 1) * 6), 2, 8);
  }
}
