import * as THREE from 'three';

/**
 * Creates a simple character using Three.js geometries
 * @returns {THREE.Group} Character group
 */
export function createSimpleCharacter() {
    // Create a group to hold all meshes
    const character = new THREE.Group();
    
    // Define blue color for the entire character
    const blueColor = 0x0055ff;
    
    // Body
    const bodyGeometry = new THREE.CylinderGeometry(0.7, 0.5, 3, 8);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: blueColor });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 1.5;
    body.castShadow = true;
    character.add(body);
    
    // Head
    const headGeometry = new THREE.SphereGeometry(0.8, 16, 16);
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc99 }); // Keep the head skin-colored
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 3.5;
    head.castShadow = true;
    character.add(head);
    
    // Arms
    const armGeometry = new THREE.CylinderGeometry(0.2, 0.2, 2, 8);
    const armMaterial = new THREE.MeshStandardMaterial({ color: blueColor });
    
    // Left arm
    const leftArm = new THREE.Mesh(armGeometry, armMaterial);
    leftArm.position.set(-1, 1.5, 0);
    leftArm.rotation.z = Math.PI / 4;
    leftArm.castShadow = true;
    character.add(leftArm);
    
    // Right arm
    const rightArm = new THREE.Mesh(armGeometry, armMaterial);
    rightArm.position.set(1, 1.5, 0);
    rightArm.rotation.z = -Math.PI / 4;
    rightArm.castShadow = true;
    character.add(rightArm);
    
    // Legs
    const legGeometry = new THREE.CylinderGeometry(0.25, 0.25, 2, 8);
    const legMaterial = new THREE.MeshStandardMaterial({ color: blueColor });
    
    // Left leg
    const leftLeg = new THREE.Mesh(legGeometry, legMaterial);
    leftLeg.position.set(-0.5, -0.5, 0);
    leftLeg.castShadow = true;
    character.add(leftLeg);
    
    // Right leg
    const rightLeg = new THREE.Mesh(legGeometry, legMaterial);
    rightLeg.position.set(0.5, -0.5, 0);
    rightLeg.castShadow = true;
    character.add(rightLeg);
    
    // Set initial position
    character.position.y = 0;
    character.userData.isSimpleFallback = true;
    
    return character;
}

/**
 * Creates mock animations for the fallback character
 * @param {THREE.AnimationMixer} mixer - The animation mixer
 * @param {THREE.Group} character - The character group
 * @returns {Object} Object containing animation actions
 */
export function createSimpleAnimations(mixer, character) {
    // We'll create simple keyframe animations
    const animations = {};
    
    // Idle animation - slight bobbing up and down
    const idleKF = new THREE.KeyframeTrack(
        '.position[y]',
        [0, 0.5, 1], 
        [0, 0.1, 0]  // Move up and down slightly
    );
    
    const idleClip = new THREE.AnimationClip('idle', 1, [idleKF]);
    animations.idle = mixer.clipAction(idleClip);
    
    // Walking animation - bobbing with leg movement
    const walkingKF = new THREE.KeyframeTrack(
        '.position[y]',
        [0, 0.25, 0.5, 0.75, 1], 
        [0, 0.15, 0, 0.15, 0]  // More pronounced bobbing
    );
    
    const walkingClip = new THREE.AnimationClip('walking', 0.5, [walkingKF]);
    animations.walking = mixer.clipAction(walkingClip);
    
    // Running animation - faster, more pronounced bobbing
    const runningKF = new THREE.KeyframeTrack(
        '.position[y]',
        [0, 0.25, 0.5, 0.75, 1], 
        [0, 0.25, 0, 0.25, 0]  // Even more pronounced bobbing
    );
    
    const runningClip = new THREE.AnimationClip('running', 0.3, [runningKF]);
    animations.running = mixer.clipAction(runningClip);
    
    // Jumping animation
    const jumpingKF = new THREE.KeyframeTrack(
        '.position[y]',
        [0, 0.5, 1], 
        [0, 1, 0]  // Jump up and down
    );
    
    const jumpingClip = new THREE.AnimationClip('jumping', 1, [jumpingKF]);
    animations.jumping = mixer.clipAction(jumpingClip);
    
    return animations;
}
