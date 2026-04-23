import * as THREE from '../vendor/three/build/three.module.js';
import { Capsule } from '../vendor/three/examples/jsm/math/Capsule.js';
import { clamp, damp } from '../utils/math.js';

export class MovementSystem {
  constructor(worldOctree) {
    this.worldOctree = worldOctree;

    this.input = {
      forward: false,
      back: false,
      left: false,
      right: false,
      run: false,
      jumpQueued: false
    };

    this.horizontalVelocity = new THREE.Vector3();
    this.verticalVelocity = 0;

    this.walkSpeed = 4.2;
    this.runSpeed = 7.4;
    this.acceleration = 16;
    this.deceleration = 12;
    this.gravity = 24;
    this.jumpSpeed = 8.2;

    this.playerCollider = new Capsule(
      new THREE.Vector3(0, 0.35, 0),
      new THREE.Vector3(0, 1.65, 0),
      0.35
    );

    this.playerHeightOffset = new THREE.Vector3(0, 1.65, 0);
    this.tempMove = new THREE.Vector3();
    this.tempDirection = new THREE.Vector3();
    this.tempTargetVelocity = new THREE.Vector3();

    this.enabled = true;
    this.onGround = false;
    this.airborneTime = 0;
    this.jumpGraceSeconds = 0.12;

    this._bindInput();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.resetInputs();
      this.ahorizontalVelocity.set(0, 0, 0);
      this.airborneTime = 0;
    }
  }

  resetInputs() {
    this.input.forward = false;
    this.input.back = false;
    this.input.left = false;
    this.input.right = false;
    this.input.run = false;
    this.input.jumpQueued = false;
  }

  syncColliderFromPlayer(playerObject) {
    const position = playerObject.position;
    this.playerCollider.start.set(position.x, position.y + 0.35, position.z);
    this.playerCollider.end.set(position.x, position.y + 1.65, position.z);
  }

  update(playerObject, movementBasis, deltaSeconds) {
    if (!playerObject) {
      return this._idleState();
    }

    const dt = clamp(deltaSeconds, 0, 0.05);
    this.syncColliderFromPlayer(playerObject);

    if (!this.enabled) {
      return this._applyPassivePhysics(playerObject, dt);
    }

    this.tempDirection.set(0, 0, 0);
    if (this.input.forward) this.tempDirection.add(movementBasis.forward);
    if (this.input.back) this.tempDirection.sub(movementBasis.forward);
    if (this.input.right) this.tempDirection.add(movementBasis.right);
    if (this.input.left) this.tempDirection.sub(movementBasis.right);

    if (this.tempDirection.lengthSq() > 0.0001) {
      this.tempDirection.normalize();
    }

    const sprintingForward = this.input.run && this.input.forward && !this.input.back;
    const targetSpeed = sprintingForward ? this.runSpeed : this.walkSpeed;
    this.tempTargetVelocity.copy(this.tempDirection).multiplyScalar(targetSpeed);

    const accel = this.tempDirection.lengthSq() > 0 ? this.acceleration : this.deceleration;
    this.horizontalVelocity.x = damp(this.horizontalVelocity.x, this.tempTargetVelocity.x, accel, dt);
    this.horizontalVelocity.z = damp(this.horizontalVelocity.z, this.tempTargetVelocity.z, accel, dt);

    let justJumped = false;
    if (this.onGround && this.input.jumpQueued) {
      this.verticalVelocity = this.jumpSpeed;
      this.onGround = false;
      justJumped = true;
    }
    this.input.jumpQueued = false;

    if (!this.onGround) {
      this.verticalVelocity -= this.gravity * dt;
    }

    this.tempMove.set(
      this.horizontalVelocity.x * dt,
      this.verticalVelocity * dt,
      this.horizontalVelocity.z * dt
    );

    this.playerCollider.translate(this.tempMove);

    if (this.worldOctree) {
      const collisionResult = this.worldOctree.capsuleIntersect(this.playerCollider);
      this.onGround = false;

      if (collisionResult) {
        this.playerCollider.translate(collisionResult.normal.multiplyScalar(collisionResult.depth));
        if (collisionResult.normal.y > 0.25) {
          this.onGround = true;
          this.verticalVelocity = Math.max(this.verticalVelocity, 0);
        }
      }
    }

    playerObject.position.copy(this.playerCollider.end).sub(this.playerHeightOffset);

    if (playerObject.position.y < 0) {
      const correction = 0 - playerObject.position.y;
      this.playerCollider.translate(this.tempMove.set(0, correction, 0));
      playerObject.position.y = 0;
      this.onGround = true;
      this.verticalVelocity = Math.max(this.verticalVelocity, 0);
    }

    if (this.onGround) {
      this.airborneTime = 0;
    } else {
      this.airborneTime += dt;
    }

    const planarSpeed = Math.sqrt(
      (this.horizontalVelocity.x * this.horizontalVelocity.x) +
      (this.horizontalVelocity.z * this.horizontalVelocity.z)
    );

    return {
      moving: planarSpeed > 0.3,
      running: sprintingForward && planarSpeed > this.walkSpeed + 0.6,
      sprintingForward,
      jumping: this.airborneTime > this.jumpGraceSeconds,
      justJumped,
      onGround: this.onGround,
      verticalVelocity: this.verticalVelocity,
      speed: planarSpeed,
      velocity: this.horizontalVelocity
    };
  }

  _applyPassivePhysics(playerObject, dt) {
    if (!playerObject) {
      return this._idleState();
    }

    if (!this.onGround) {
      this.verticalVelocity -= this.gravity * dt;
      this.playerCollider.translate(this.tempMove.set(0, this.verticalVelocity * dt, 0));

      if (this.worldOctree) {
        const collisionResult = this.worldOctree.capsuleIntersect(this.playerCollider);
        if (collisionResult) {
          this.playerCollider.translate(collisionResult.normal.multiplyScalar(collisionResult.depth));
          if (collisionResult.normal.y > 0.25) {
            this.onGround = true;
            this.verticalVelocity = 0;
          }
        }
      }

      playerObject.position.copy(this.playerCollider.end).sub(this.playerHeightOffset);

      if (playerObject.position.y < 0) {
        const correction = 0 - playerObject.position.y;
        this.playerCollider.translate(this.tempMove.set(0, correction, 0));
        playerObject.position.y = 0;
        this.onGround = true;
        this.verticalVelocity = 0;
      }
    }

    if (this.onGround) {
      this.airborneTime = 0;
    } else {
      this.airborneTime += dt;
    }

    return this._idleState();
  }

  _idleState() {
    return {
      moving: false,
      running: false,
      sprintingForward: false,
      jumping: this.airborneTime > this.jumpGraceSeconds,
      justJumped: false,
      onGround: this.onGround,
      verticalVelocity: this.verticalVelocity,
      speed: 0,
      velocity: this.horizontalVelocity
    };
  }

  _bindInput() {
    window.addEventListener('keydown', (event) => {
      switch (event.code) {
        case 'KeyW':
          this.input.forward = true;
          break;
        case 'KeyS':
          this.input.back = true;
          break;
        case 'KeyA':
          this.input.left = true;
          break;
        case 'KeyD':
          this.input.right = true;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.input.run = true;
          break;
        case 'Space':
          if (!event.repeat) {
            this.input.jumpQueued = true;
          }
          break;
        default:
          break;
      }
    });

    window.addEventListener('keyup', (event) => {
      switch (event.code) {
        case 'KeyW':
          this.input.forward = false;
          break;
        case 'KeyS':
          this.input.back = false;
          break;
        case 'KeyA':
          this.input.left = false;
          break;
        case 'KeyD':
          this.input.right = false;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.input.run = false;
          break;
        default:
          break;
      }
    });

    window.addEventListener('blur', () => {
      this.resetInputs();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.resetInputs();
      }
    });
  }
}
