import * as THREE from '../vendor/three/build/three.module.js';
import { dampVector3 } from '../utils/math.js';
import { clamp } from '../utils/math.js';

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function dampAngle(current, target, lambda, dt) {
  const delta = normalizeAngle(target - current);
  return normalizeAngle(current + (delta * (1 - Math.exp(-lambda * dt))));
}

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.enabled = true;
    this.targetObject = null;
    this.domElement = null;

    this.lookOffset = new THREE.Vector3(0, 1.35, 0);
    this.followTarget = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.tempOffset = new THREE.Vector3();

    this.chaseDistance = 6.4;
    this.minChaseDistance = 2.4;
    this.maxChaseDistance = 12.5;
    this.zoomSensitivity = 0.01;
    this.chaseHeight = 2.2;
    this.followDamping = 11.5;

    this.currentYaw = 0;
    this.yawInitialized = false;
    this.isMoving = false;
    this.currentPitch = 0.34;
    this.minPitch = -0.15;
    this.maxPitch = 0.95;
    this.orbitSensitivity = 0.0042;

    this.tempForward = new THREE.Vector3();
    this.tempRight = new THREE.Vector3();

    this.leftMouseDown = false;
    this.rightMouseDown = false;
    this.mouseForward = false;
    this.lastPointerX = 0;
    this.lastPointerY = 0;
    this._inputBound = false;
  }

  setTarget(object3D) {
    this.targetObject = object3D;
    this.yawInitialized = false;
    if (!object3D) {
      return;
    }

    this.followTarget.copy(object3D.position).add(this.lookOffset);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!this.enabled) {
      this.leftMouseDown = false;
      this.rightMouseDown = false;
      this.mouseForward = false;
    }
  }

  setMovementState(movementState) {
    const speed = Number.isFinite(movementState?.speed) ? movementState.speed : 0;
    this.isMoving = movementState?.moving === true || speed > 0.25;
  }

  bindInput(domElement) {
    if (!domElement || this._inputBound) {
      return;
    }

    this.domElement = domElement;
    this.domElement.style.touchAction = 'none';
    this.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    this.domElement.addEventListener('wheel', (event) => {
      if (!this.enabled) {
        return;
      }
      event.preventDefault();
      this.chaseDistance = clamp(
        this.chaseDistance + (event.deltaY * this.zoomSensitivity),
        this.minChaseDistance,
        this.maxChaseDistance
      );
    }, { passive: false });

    this.domElement.addEventListener('pointerdown', (event) => {
      if (!this.enabled) {
        return;
      }
      if (event.button === 0) this.leftMouseDown = true;
      if (event.button === 2) this.rightMouseDown = true;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      this.mouseForward = this.leftMouseDown && this.rightMouseDown;

      if (event.button === 0 || event.button === 2) {
        event.preventDefault();
      }
    });

    window.addEventListener('pointerup', (event) => {
      if (event.button === 0) this.leftMouseDown = false;
      if (event.button === 2) this.rightMouseDown = false;
      this.mouseForward = this.leftMouseDown && this.rightMouseDown;
    });

    window.addEventListener('pointermove', (event) => {
      if (!this.enabled || (!this.leftMouseDown && !this.rightMouseDown)) {
        this.lastPointerX = event.clientX;
        this.lastPointerY = event.clientY;
        return;
      }

      const dx = event.clientX - this.lastPointerX;
      const dy = event.clientY - this.lastPointerY;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;

      this.currentYaw += dx * this.orbitSensitivity;
      this.currentPitch = clamp(
        this.currentPitch + (dy * this.orbitSensitivity * 0.65),
        this.minPitch,
        this.maxPitch
      );

      if (this.rightMouseDown && this.targetObject) {
        this.targetObject.rotation.y = this.currentYaw;
      }
    });

    window.addEventListener('blur', () => {
      this.leftMouseDown = false;
      this.rightMouseDown = false;
      this.mouseForward = false;
    });

    this._inputBound = true;
  }

  getControlState() {
    return {
      leftMouseDown: this.enabled && this.leftMouseDown,
      rightMouseDown: this.enabled && this.rightMouseDown,
      mouseForward: this.enabled && this.mouseForward
    };
  }

  getMovementBasis() {
    this.camera.getWorldDirection(this.tempForward);
    this.tempForward.y = 0;

    if (this.tempForward.lengthSq() < 0.0001) {
      if (this.targetObject) {
        const yaw = this.targetObject.rotation.y || 0;
        this.tempForward.set(Math.sin(yaw), 0, Math.cos(yaw));
      } else {
        this.tempForward.set(0, 0, 1);
      }
    }

    this.tempForward.normalize();
    this.tempRight.set(-this.tempForward.z, 0, this.tempForward.x);
    if (this.tempRight.lengthSq() < 0.0001) {
      this.tempRight.set(1, 0, 0);
    } else {
      this.tempRight.normalize();
    }

    return {
      forward: this.tempForward,
      right: this.tempRight
    };
  }

  update(deltaSeconds) {
    if (!this.targetObject || !this.enabled) {
      return;
    }

    this.followTarget.copy(this.targetObject.position).add(this.lookOffset);

    if (!this.yawInitialized) {
      this.tempOffset.copy(this.camera.position).sub(this.followTarget);
      const yOffset = this.tempOffset.y - this.chaseHeight;
      this.tempOffset.y = 0;
      const planarDistance = this.tempOffset.length();

      if ((planarDistance * planarDistance) > 0.0001) {
        this.currentYaw = Math.atan2(-this.tempOffset.x, -this.tempOffset.z);
      } else {
        this.currentYaw = this.targetObject.rotation.y || 0;
      }
      if (this.chaseDistance > 0.01) {
        this.currentPitch = clamp(
          Math.atan2(yOffset, planarDistance || this.chaseDistance),
          this.minPitch,
          this.maxPitch
        );
      }
      this.yawInitialized = true;
    }

    if (this.mouseForward) {
      this.currentYaw = dampAngle(this.currentYaw, this.targetObject.rotation.y || this.currentYaw, 18, deltaSeconds);
      this.targetObject.rotation.y = this.currentYaw;
    } else if (this.rightMouseDown) {
      this.targetObject.rotation.y = this.currentYaw;
    }

    const sinYaw = Math.sin(this.currentYaw);
    const cosYaw = Math.cos(this.currentYaw);
    const cosPitch = Math.cos(this.currentPitch);
    const sinPitch = Math.sin(this.currentPitch);
    this.desiredPosition.set(
      this.followTarget.x - (sinYaw * this.chaseDistance * cosPitch),
      this.followTarget.y + this.chaseHeight + (sinPitch * this.chaseDistance),
      this.followTarget.z - (cosYaw * this.chaseDistance * cosPitch)
    );

    dampVector3(this.camera.position, this.desiredPosition, this.followDamping, deltaSeconds);
    this.camera.lookAt(this.followTarget);
  }
}
