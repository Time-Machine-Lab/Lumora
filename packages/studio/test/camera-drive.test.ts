import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { focalLengthToFovDeg } from '@lumora/core';
import type { SceneObjectData } from '@lumora/core';
import {
  CAMERA_DRIVE_LIMITS,
  CameraDrive,
  MAX_FOCAL_MM,
  MIN_FOCAL_MM,
  applyCameraWorldDelta,
  captureCameraSample,
  hasSingularWorldTransform,
  getWorldOrthonormalQuaternion,
  getWorldRigidQuaternion,
  restoreObjectOnNode,
  syncRigidCameraProxy,
} from '../src/components/editor/camera-drive';

function makeCameraNode(): THREE.PerspectiveCamera {
  const node = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
  node.position.set(0, 1.6, 6);
  node.userData.objectId = 'cam';
  node.userData.focalLength = 50;
  return node;
}

function makeCompensatedNearSingularCamera(): THREE.PerspectiveCamera {
  const root = new THREE.Group();
  root.scale.set(1, 1, 1e-9);
  const parent = new THREE.Group();
  parent.rotation.y = Math.PI / 4;
  const node = makeCameraNode();
  node.rotation.y = -Math.PI / 4;
  root.add(parent);
  parent.add(node);
  root.updateMatrixWorld(true);
  return node;
}

describe('CameraDrive：键鼠驾驶积分器', () => {
  it('applies a world-space camera delta through a transformed parent', () => {
    const parent = new THREE.Group();
    parent.position.set(3, -2, 4);
    parent.rotation.set(0.2, -0.4, 0.3);
    parent.scale.setScalar(2);
    const mirror = makeCameraNode();
    mirror.position.set(0.8, 1.2, -0.6);
    mirror.rotation.set(-0.1, 0.4, 0.2);
    parent.add(mirror);
    parent.updateMatrixWorld(true);

    const beforePosition = mirror.getWorldPosition(new THREE.Vector3());
    const beforeQuaternion = mirror.getWorldQuaternion(new THREE.Quaternion());
    const previousPrimaryPosition = new THREE.Vector3(-1, 2, 5);
    const currentPrimaryPosition = new THREE.Vector3(2, 3, 4);
    const rotationDelta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, -0.25, 0.1));
    const previousPrimaryQuaternion = new THREE.Quaternion();
    const currentPrimaryQuaternion = rotationDelta.clone().multiply(previousPrimaryQuaternion);

    const applied = applyCameraWorldDelta(
      mirror,
      previousPrimaryPosition,
      previousPrimaryQuaternion,
      currentPrimaryPosition,
      currentPrimaryQuaternion,
    );
    mirror.updateMatrixWorld(true);

    const expectedPosition = beforePosition
      .clone()
      .add(currentPrimaryPosition.clone().sub(previousPrimaryPosition));
    const expectedQuaternion = rotationDelta.clone().multiply(beforeQuaternion);
    expect(applied).toBe(true);
    expect(mirror.getWorldPosition(new THREE.Vector3()).distanceTo(expectedPosition)).toBeLessThan(1e-8);
    expect(mirror.getWorldQuaternion(new THREE.Quaternion()).angleTo(expectedQuaternion)).toBeLessThan(1e-8);
  });

  it('keeps world direction after a rotation delta through a non-uniformly scaled parent', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.4, -0.7, 0.2);
    parent.scale.set(2, 3, 0.5);
    const mirror = makeCameraNode();
    mirror.rotation.set(-0.2, 0.6, 0.1);
    parent.add(mirror);
    parent.updateMatrixWorld(true);

    const beforeDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(mirror));
    const previousPrimaryPosition = new THREE.Vector3();
    const currentPrimaryPosition = new THREE.Vector3();
    const rotationDelta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, -0.35, 0.15));

    applyCameraWorldDelta(
      mirror,
      previousPrimaryPosition,
      new THREE.Quaternion(),
      currentPrimaryPosition,
      rotationDelta,
    );
    mirror.updateMatrixWorld(true);
    const expectedDirection = beforeDirection.clone().applyQuaternion(rotationDelta).normalize();
    const actualDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(mirror));
    expect(actualDirection.angleTo(expectedDirection)).toBeLessThan(1e-8);
  });

  it('rotates a nested camera around the world Y axis instead of its parent-local axis', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.2, 0.7, 0.3);
    const node = makeCameraNode();
    parent.add(node);
    parent.updateMatrixWorld(true);
    const drive = new CameraDrive({ mode: 'keyboard-only', rotateSpeed: 1, smoothing: 30 });
    drive.attach(node);
    drive.press('ArrowRight');
    const before = parent.quaternion.clone().multiply(node.quaternion);
    drive.update(0.4);
    const after = parent.quaternion.clone().multiply(node.quaternion).normalize();
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4).multiply(before);

    expect(after.angleTo(expected)).toBeLessThan(1e-4);
  });

  it('keeps a directly driven camera world-facing under a non-uniformly scaled parent', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.4, 0.7, -0.3);
    parent.scale.set(2, 3, 0.5);
    const node = makeCameraNode();
    node.rotation.set(-0.2, 0.6, 0.1);
    parent.add(node);
    parent.updateMatrixWorld(true);
    const drive = new CameraDrive({ mode: 'keyboard-only', rotateSpeed: 1, smoothing: 30 });
    drive.attach(node);
    const before = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(node));
    drive.press('ArrowRight');
    drive.update(0.4);
    node.updateMatrixWorld(true);
    const after = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(node));
    const expected = before
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.4)
      .normalize();

    expect(after.angleTo(expected)).toBeLessThan(1e-4);
  });

  it('keeps a directly driven camera world-facing under a reflected parent', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.2, 0.7, 0.3);
    parent.scale.set(-1, 1, 1);
    const node = makeCameraNode();
    node.rotation.set(0.1, -0.2, 0.3);
    parent.add(node);
    parent.updateMatrixWorld(true);
    const drive = new CameraDrive({ mode: 'keyboard-only', rotateSpeed: 1, smoothing: 30 });
    drive.attach(node);
    const before = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(node));
    drive.press('ArrowRight');
    drive.update(0.4);
    node.updateMatrixWorld(true);
    const after = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(node));
    const expected = before
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.4)
      .normalize();

    expect(after.angleTo(expected)).toBeLessThan(1e-4);
  });

  it('preserves a complete rigid world basis under a non-uniformly scaled parent', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.4, -0.7, 0.2);
    parent.scale.set(2, 3, 0.5);
    const node = makeCameraNode();
    node.rotation.set(-0.2, 0.6, 0.1);
    parent.add(node);
    parent.updateMatrixWorld(true);
    const drive = new CameraDrive({ mode: 'keyboard-only', rotateSpeed: 1, smoothing: 30 });
    drive.attach(node);
    const beforeQuaternion = getWorldRigidQuaternion(node);
    const beforeForward = new THREE.Vector3(0, 0, -1).applyQuaternion(beforeQuaternion);
    const beforeUp = new THREE.Vector3(0, 1, 0).applyQuaternion(beforeQuaternion);
    const beforeRight = new THREE.Vector3(1, 0, 0).applyQuaternion(beforeQuaternion);
    drive.press('ArrowUp');
    drive.update(0.35);
    node.updateMatrixWorld(true);
    const afterQuaternion = getWorldRigidQuaternion(node);
    const afterForward = new THREE.Vector3(0, 0, -1).applyQuaternion(afterQuaternion);
    const afterUp = new THREE.Vector3(0, 1, 0).applyQuaternion(afterQuaternion);
    const afterRight = new THREE.Vector3(1, 0, 0).applyQuaternion(afterQuaternion);
    const expectedForward = beforeForward.clone().applyAxisAngle(beforeRight, -0.35).normalize();
    const expectedUp = beforeUp.clone().applyAxisAngle(beforeRight, -0.35).normalize();
    const expectedRight = beforeRight.clone().applyAxisAngle(beforeRight, -0.35).normalize();

    expect(afterForward.angleTo(expectedForward)).toBeLessThan(1e-4);
    expect(afterUp.angleTo(expectedUp)).toBeLessThan(1e-4);
    expect(afterRight.angleTo(expectedRight)).toBeLessThan(1e-4);
    expect(Math.abs(afterUp.dot(afterRight))).toBeLessThan(1e-10);
    expect(Math.abs(afterForward.dot(afterRight))).toBeLessThan(1e-10);
  });

  it('uses world-space distance for tap movement under a transformed parent', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.4, -0.7, 0.2);
    parent.scale.set(2, 3, 0.5);
    const node = makeCameraNode();
    node.rotation.set(-0.2, 0.6, 0.1);
    parent.add(node);
    parent.updateMatrixWorld(true);
    const beforePosition = node.getWorldPosition(new THREE.Vector3());
    const beforeForward = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(node));
    const drive = new CameraDrive({ tapStep: 0.1, holdDelay: 0.12 });
    drive.attach(node);
    drive.press('KeyW');
    drive.release('KeyW');
    node.updateMatrixWorld(true);

    const expected = beforePosition.clone().addScaledVector(beforeForward, 0.1);
    expect(node.getWorldPosition(new THREE.Vector3()).distanceTo(expected)).toBeLessThan(1e-8);
  });

  it('uses world-space speed for held movement under a transformed parent', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.4, -0.7, 0.2);
    parent.scale.set(2, 3, 0.5);
    const node = makeCameraNode();
    node.rotation.set(-0.2, 0.6, 0.1);
    parent.add(node);
    parent.updateMatrixWorld(true);
    const beforePosition = node.getWorldPosition(new THREE.Vector3());
    const beforeForward = new THREE.Vector3(0, 0, -1).applyQuaternion(getWorldRigidQuaternion(node));
    const drive = new CameraDrive({ speed: 1, smoothing: 30, holdDelay: 0.12 });
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.4);
    node.updateMatrixWorld(true);

    const displacement = node.getWorldPosition(new THREE.Vector3()).sub(beforePosition);
    expect(displacement.length()).toBeCloseTo(0.28, 5);
    expect(displacement.normalize().angleTo(beforeForward)).toBeLessThan(1e-8);
  });

  it('uses the exact rigid hierarchy pose for viewport and capture proxies', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.4, -0.7, 0.2);
    parent.scale.set(2, 3, 0.5);
    const node = makeCameraNode();
    node.rotation.set(-0.2, 0.6, 0.1);
    parent.add(node);
    parent.updateMatrixWorld(true);
    node.fov = 38;
    node.zoom = 1.25;
    const viewportProxy = new THREE.PerspectiveCamera();
    const captureProxy = new THREE.PerspectiveCamera();
    expect(syncRigidCameraProxy(node, viewportProxy, 2)).toBe(true);
    expect(syncRigidCameraProxy(node, captureProxy, 2)).toBe(true);

    const expectedQuaternion = getWorldRigidQuaternion(node);
    const expectedPosition = node.getWorldPosition(new THREE.Vector3());
    for (const axis of [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, -1),
    ]) {
      const expected = axis.clone().applyQuaternion(expectedQuaternion);
      expect(axis.clone().applyQuaternion(viewportProxy.quaternion).angleTo(expected)).toBeLessThan(1e-8);
      expect(axis.clone().applyQuaternion(captureProxy.quaternion).angleTo(expected)).toBeLessThan(1e-8);
    }
    expect(viewportProxy.position.distanceTo(expectedPosition)).toBeLessThan(1e-8);
    expect(captureProxy.position.distanceTo(viewportProxy.position)).toBeLessThan(1e-8);
    expect(captureProxy.quaternion.angleTo(viewportProxy.quaternion)).toBeLessThan(1e-8);
    expect(viewportProxy.fov).toBe(38);
    expect(viewportProxy.zoom).toBe(1.25);
    expect(viewportProxy.aspect).toBe(2);

    const before = viewportProxy.quaternion.clone();
    parent.rotation.y += 0.45;
    parent.scale.set(-2, 1, 4);
    parent.updateMatrixWorld(true);
    expect(syncRigidCameraProxy(node, viewportProxy, 16 / 9)).toBe(true);
    expect(viewportProxy.quaternion.angleTo(before)).toBeGreaterThan(0.1);
    expect(viewportProxy.quaternion.angleTo(getWorldRigidQuaternion(node))).toBeLessThan(1e-8);
    expect(getWorldOrthonormalQuaternion(node).angleTo(viewportProxy.quaternion)).toBeLessThan(1e-8);
  });

  it('treats a uniformly small invertible hierarchy as non-singular for proxies', () => {
    const parent = new THREE.Group();
    parent.position.set(3, -2, 4);
    parent.rotation.set(0.2, -0.4, 0.3);
    parent.scale.setScalar(0.001);
    const source = makeCameraNode();
    parent.add(source);
    parent.updateMatrixWorld(true);
    const proxy = new THREE.PerspectiveCamera();

    expect(hasSingularWorldTransform(source)).toBe(false);
    expect(syncRigidCameraProxy(source, proxy, 16 / 9)).toBe(true);
    expect(proxy.position.distanceTo(source.getWorldPosition(new THREE.Vector3()))).toBeLessThan(1e-8);
    expect(proxy.position.toArray().every(Number.isFinite)).toBe(true);
  });

  it('rejects transforms whose determinant underflows to a zero inverse', () => {
    const parent = new THREE.Group();
    parent.scale.setScalar(1e-108);
    const source = makeCameraNode();
    parent.add(source);
    parent.updateMatrixWorld(true);

    expect(hasSingularWorldTransform(source)).toBe(true);
  });

  it('drives a camera through a uniformly small invertible hierarchy', () => {
    const parent = new THREE.Group();
    parent.rotation.set(0.2, -0.4, 0.3);
    parent.scale.setScalar(0.001);
    const node = makeCameraNode();
    parent.add(node);
    parent.updateMatrixWorld(true);
    const drive = new CameraDrive({ speed: 2, smoothing: 30, holdDelay: 0 });
    drive.attach(node);
    const beforePosition = node.getWorldPosition(new THREE.Vector3());

    drive.press('KeyW');
    drive.update(0.2);
    parent.updateMatrixWorld(true);

    expect(drive.hasInput).toBe(true);
    expect(node.getWorldPosition(new THREE.Vector3()).distanceTo(beforePosition)).toBeGreaterThan(0.01);
  });

  it('flags a compensated descendant when an ancestor inverse is unusable', () => {
    const node = makeCompensatedNearSingularCamera();

    expect(hasSingularWorldTransform(node.parent!)).toBe(true);
    expect(hasSingularWorldTransform(node)).toBe(true);
  });

  it('clears stalled translation when an ancestor inverse is unusable', () => {
    const node = makeCompensatedNearSingularCamera();
    const drive = new CameraDrive({ speed: 2, smoothing: 30, holdDelay: 0.05 });
    drive.attach(node);
    const beforePosition = node.position.clone();

    drive.press('KeyW');
    drive.update(0.2);

    expect(node.position.distanceTo(beforePosition)).toBeLessThan(1e-9);
    expect(drive.hasInput).toBe(false);
  });

  it('keeps mixed camera input atomic when an ancestor inverse is unusable', () => {
    const node = makeCompensatedNearSingularCamera();
    const drive = new CameraDrive({
      mode: 'keyboard-only',
      speed: 2,
      rotateSpeed: 1,
      smoothing: 30,
      holdDelay: 0.05,
    });
    drive.attach(node);
    const beforePosition = node.position.clone();
    const beforeQuaternion = node.quaternion.clone();
    const beforeFov = node.fov;
    const beforeFocal = (node.userData as Record<string, unknown>).focalLength;

    drive.press('KeyW');
    drive.press('ArrowRight');
    drive.press('BracketRight');
    drive.update(0.2);

    expect(node.position.distanceTo(beforePosition)).toBeLessThan(1e-9);
    expect(node.quaternion.angleTo(beforeQuaternion)).toBeLessThan(1e-9);
    expect(node.fov).toBe(beforeFov);
    expect((node.userData as Record<string, unknown>).focalLength).toBe(beforeFocal);
    expect(drive.hasInput).toBe(false);
  });

  it('leaves a mirrored camera finite when its parent transform is singular', () => {
    const parent = new THREE.Group();
    parent.position.set(3, -2, 4);
    parent.rotation.set(0.2, -0.4, 0.3);
    parent.scale.set(0, 3, 0.5);
    const mirror = makeCameraNode();
    parent.add(mirror);
    parent.updateMatrixWorld(true);
    const beforePosition = mirror.position.clone();
    const beforeQuaternion = mirror.quaternion.clone();

    const applied = applyCameraWorldDelta(
      mirror,
      new THREE.Vector3(-1, 2, 5),
      new THREE.Quaternion(),
      new THREE.Vector3(2, 3, 4),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, -0.25, 0.1)),
    );

    expect(applied).toBe(false);
    expect(mirror.position.toArray().every(Number.isFinite)).toBe(true);
    expect(mirror.quaternion.toArray().every(Number.isFinite)).toBe(true);
    expect(mirror.position.distanceTo(beforePosition)).toBeLessThan(1e-9);
    expect(mirror.quaternion.angleTo(beforeQuaternion)).toBeLessThan(1e-9);
  });

  it('clears held input and momentum when an ancestor becomes singular', () => {
    const parent = new THREE.Group();
    const node = makeCameraNode();
    parent.add(node);
    parent.updateMatrixWorld(true);
    const drive = new CameraDrive({ speed: 2, smoothing: 30, holdDelay: 0.05 });
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.2);
    expect(drive.hasInput).toBe(true);

    parent.scale.x = 0;
    parent.updateMatrixWorld(true);
    const blockedPosition = node.position.clone();
    drive.update(0.1);
    expect(drive.hasInput).toBe(false);
    expect(node.position.distanceTo(blockedPosition)).toBeLessThan(1e-9);

    parent.scale.x = 1;
    parent.updateMatrixWorld(true);
    drive.update(0.4);
    expect(node.position.distanceTo(blockedPosition)).toBeLessThan(1e-9);
  });

  it('短按移动键只产生一次确定的本地轴步进', () => {
    const drive = new CameraDrive({ tapStep: 0.1, holdDelay: 0.12, speed: 2.5 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.05);
    drive.release('KeyW');

    expect(node.position.z).toBeCloseTo(5.9, 6);
  });

  it('越过短按阈值后按住移动键产生连续平滑位移', () => {
    const drive = new CameraDrive({ tapStep: 0.1, holdDelay: 0.12, speed: 2.5, smoothing: 12 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.06);
    drive.update(0.06);
    drive.update(0.2);
    drive.release('KeyW');

    expect(node.position.z).toBeLessThan(5.9);
  });

  it('refreshes dirty ancestors before blocking rotation and focal writes', () => {
    const parent = new THREE.Group();
    const node = makeCameraNode();
    parent.add(node);
    parent.updateMatrixWorld(true);
    const drive = new CameraDrive({ speed: 2, smoothing: 30, holdDelay: 0.05 });
    drive.attach(node);
    drive.press('KeyW');
    drive.press('BracketRight');
    drive.look(20, -10);

    parent.scale.x = 0;
    const blockedPosition = node.position.clone();
    const blockedQuaternion = node.quaternion.clone();
    const blockedFov = node.fov;
    const blockedFocal = (node.userData as Record<string, unknown>).focalLength;
    drive.update(0.2);

    expect(node.position.distanceTo(blockedPosition)).toBeLessThan(1e-9);
    expect(node.quaternion.angleTo(blockedQuaternion)).toBeLessThan(1e-9);
    expect(node.fov).toBe(blockedFov);
    expect((node.userData as Record<string, unknown>).focalLength).toBe(blockedFocal);
    expect(drive.hasInput).toBe(false);
  });

  it('refreshes a dirty singular mirror parent before applying a world delta', () => {
    const parent = new THREE.Group();
    const mirror = makeCameraNode();
    parent.add(mirror);
    parent.updateMatrixWorld(true);
    const blockedPosition = mirror.position.clone();
    const blockedQuaternion = mirror.quaternion.clone();

    parent.scale.x = 0;
    applyCameraWorldDelta(
      mirror,
      new THREE.Vector3(),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 2, 3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0.3)),
    );

    expect(mirror.position.distanceTo(blockedPosition)).toBeLessThan(1e-9);
    expect(mirror.quaternion.angleTo(blockedQuaternion)).toBeLessThan(1e-9);
  });

  it('rejects proxy capture immediately after an ancestor becomes singular', () => {
    const parent = new THREE.Group();
    const source = makeCameraNode();
    parent.add(source);
    parent.updateMatrixWorld(true);
    const proxy = new THREE.PerspectiveCamera();
    expect(syncRigidCameraProxy(source, proxy, 16 / 9)).toBe(true);
    const blockedPosition = proxy.position.clone();
    const blockedQuaternion = proxy.quaternion.clone();

    parent.scale.x = 0;

    expect(syncRigidCameraProxy(source, proxy, 16 / 9)).toBe(false);
    expect(proxy.position.distanceTo(blockedPosition)).toBeLessThan(1e-9);
    expect(proxy.quaternion.angleTo(blockedQuaternion)).toBeLessThan(1e-9);
  });

  it('normalizes rigid proxy scale so focal settings remain the optical control', () => {
    const source = makeCameraNode();
    source.scale.set(2, 3, 4);
    const proxy = new THREE.PerspectiveCamera();
    proxy.scale.set(5, 6, 7);

    expect(syncRigidCameraProxy(source, proxy, 16 / 9)).toBe(true);
    expect(proxy.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('held movement never applies the maximum tap step when crossing holdDelay', () => {
    const drive = new CameraDrive({
      tapStep: CAMERA_DRIVE_LIMITS.tapStep.max,
      holdDelay: CAMERA_DRIVE_LIMITS.holdDelay.min,
      speed: CAMERA_DRIVE_LIMITS.speed.max,
      smoothing: CAMERA_DRIVE_LIMITS.smoothing.max,
    });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');

    const frameSeconds = 1 / 60;
    const positions: THREE.Vector3[] = [node.position.clone()];
    for (let frame = 0; frame < 12; frame += 1) {
      drive.update(frameSeconds);
      positions.push(node.position.clone());
    }
    const beforeRelease = node.position.clone();
    drive.release('KeyW');
    positions.push(node.position.clone());

    const perFrameDistances = positions.slice(1).map((position, index) =>
      position.distanceTo(positions[index]!),
    );
    expect(Math.max(...perFrameDistances)).toBeLessThanOrEqual(
      CAMERA_DRIVE_LIMITS.speed.max * frameSeconds,
    );
    expect(node.position.distanceTo(beforeRelease)).toBeLessThan(1e-12);
  });

  it('重复 keydown 不重置按住计时，且不会在释放时追加短按步进', () => {
    const drive = new CameraDrive({ tapStep: 0.1, holdDelay: 0.12, speed: 3, smoothing: 20 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.08);
    drive.press('KeyW');
    drive.update(0.2);
    drive.release('KeyW');

    expect(node.position.z).toBeLessThan(5.8);
  });

  it('相反方向的短按使用同一步长并可预测地抵消', () => {
    const drive = new CameraDrive({ tapStep: 0.15, holdDelay: 0.12 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.release('KeyW');
    drive.press('KeyS');
    drive.release('KeyS');

    expect(node.position.toArray()).toEqual([0, 1.6, 6]);
  });

  it('按住 W 前进：向相机朝向的 -Z 平滑加速（指数逼近目标速度）', () => {
    const drive = new CameraDrive({ speed: 2.5, rotateSpeed: 1.2, smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.5);
    // 指数平滑：目标 2.5m/s × (1-e^-4) ≈ 2.45m/s，0.5s 位移 ≈ 1.23m
    expect(node.position.z).toBeLessThan(6);
    expect(node.position.z).toBeGreaterThan(4.7);
    expect(node.position.x).toBe(0);
    expect(node.position.y).toBe(1.6);
  });

  it('松键后余速滑行衰减，最终静止', () => {
    const drive = new CameraDrive({ smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.2);
    drive.release('KeyW');
    const mid = node.position.z;
    drive.update(0.2);
    expect(node.position.z).toBeLessThan(mid); // 余速继续滑行
    drive.update(0.5);
    drive.update(0.5);
    drive.update(0.5);
    const settled = node.position.z;
    drive.update(0.5);
    expect(node.position.z).toBeCloseTo(settled, 5); // 已静止
  });

  it('stop() 硬停：速度立即归零，后续 update 无位移（失焦保护）', () => {
    const drive = new CameraDrive({ smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.2);
    expect(node.position.z).toBeLessThan(6);
    drive.stop();
    const frozen = node.position.clone();
    drive.update(0.5);
    drive.update(0.5);
    expect(node.position.z).toBeCloseTo(frozen.z, 10);
  });

  it('cancelTranslationMomentum clears released-key drift while keeping the target attached', () => {
    const drive = new CameraDrive({ smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.2);
    drive.release('KeyW');
    drive.cancelTranslationMomentum();
    const frozen = node.position.clone();

    drive.update(0.5);

    expect(node.position.distanceTo(frozen)).toBeLessThan(1e-9);
    expect(drive.hasInput).toBe(false);
  });

  it('方向键偏航/俯仰：左转绕世界 Y，抬头绕局部 X', () => {
    const drive = new CameraDrive({ mode: 'keyboard-only', rotateSpeed: 1.2, smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('ArrowLeft');
    drive.update(0.5);
    expect(node.rotation.y).toBeLessThan(0); // 左转 = 负偏航
    drive.detach();
    drive.attach(node);
    drive.press('ArrowUp');
    drive.update(0.5);
    expect(node.rotation.x).toBeLessThan(0); // 抬头 = 负俯仰
  });

  it('[, ] 变焦：平滑推拉焦距并同步 fov，夹取到 [8, 200]mm', () => {
    const drive = new CameraDrive({ smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('BracketRight');
    drive.update(1);
    const focal = node.userData.focalLength as number;
    expect(focal).toBeGreaterThan(50);
    expect(focal).toBeLessThan(64); // 12mm/s × (1-e^-8) 且 clamp 后
    expect(node.fov).toBeCloseTo(focalLengthToFovDeg(focal), 6);
    // 下限夹取
    const narrow = makeCameraNode();
    narrow.userData.focalLength = 9;
    drive.attach(narrow);
    drive.press('BracketLeft');
    drive.update(10);
    expect(narrow.userData.focalLength).toBeGreaterThanOrEqual(MIN_FOCAL_MM);
    // 上限夹取
    const wide = makeCameraNode();
    wide.userData.focalLength = 199;
    drive.attach(wide);
    drive.press('BracketRight');
    drive.update(10);
    expect(wide.userData.focalLength).toBeLessThanOrEqual(MAX_FOCAL_MM);
  });

  it('attach 重置按键与速度（换绑不残留旧输入）', () => {
    const drive = new CameraDrive({ smoothing: 8 });
    const a = makeCameraNode();
    const b = makeCameraNode();
    drive.attach(a);
    drive.press('KeyW');
    drive.update(0.1);
    drive.attach(b);
    expect(drive.hasInput).toBe(false);
    const before = b.position.z;
    drive.update(0.5);
    expect(b.position.z).toBeCloseTo(before, 10);
  });

  it('键鼠模式接收位移键、拒绝方向键，并平滑应用鼠标视角', () => {
    const drive = new CameraDrive({ mode: 'keyboard-mouse', mouseSensitivity: 1, smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);

    expect(drive.acceptsKey('KeyW')).toBe(true);
    expect(drive.acceptsKey('ArrowLeft')).toBe(false);
    drive.look(40, -20);
    drive.update(1 / 60);

    expect(node.rotation.y).not.toBe(0);
    expect(node.rotation.x).not.toBe(0);
    expect(drive.hasInput).toBe(true);
  });

  it('纯键盘模式忽略鼠标视角，切换模式会清除残余视角输入', () => {
    const drive = new CameraDrive({ mode: 'keyboard-mouse', mouseSensitivity: 1 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.look(40, 20);
    drive.setSettings({ mode: 'keyboard-only' });
    drive.update(0.5);
    const rotation = node.rotation.clone();
    drive.look(40, 20);
    drive.update(0.5);

    expect(node.rotation.x).toBeCloseTo(rotation.x, 10);
    expect(node.rotation.y).toBeCloseTo(rotation.y, 10);
    expect(drive.acceptsKey('ArrowLeft')).toBe(true);
  });

  it('鼠标视角限幅且残余输入逐帧衰减，不会产生单帧无界跳变', () => {
    const huge = new CameraDrive({ mode: 'keyboard-mouse', mouseSensitivity: 1, smoothing: 8 });
    const bounded = new CameraDrive({ mode: 'keyboard-mouse', mouseSensitivity: 1, smoothing: 8 });
    const hugeNode = makeCameraNode();
    const boundedNode = makeCameraNode();
    huge.attach(hugeNode);
    bounded.attach(boundedNode);
    huge.look(10_000, -10_000);
    bounded.look(80, -80);
    huge.update(1 / 60);
    bounded.update(1 / 60);

    expect(hugeNode.rotation.x).toBeCloseTo(boundedNode.rotation.x, 8);
    expect(hugeNode.rotation.y).toBeCloseTo(boundedNode.rotation.y, 8);
    const firstYaw = hugeNode.rotation.y;
    huge.update(1 / 60);
    expect(Math.abs(hugeNode.rotation.y)).toBeGreaterThan(Math.abs(firstYaw));
    expect(Math.abs(hugeNode.rotation.y - firstYaw)).toBeLessThan(Math.abs(firstYaw));
  });

  it('cancelLook clears queued mouse rotation without cancelling held translation', () => {
    const drive = new CameraDrive({ mode: 'keyboard-mouse', speed: 3, smoothing: 8 });
    const node = makeCameraNode();
    drive.attach(node);
    drive.press('KeyW');
    drive.update(0.06);
    drive.update(0.08);
    drive.look(80, -40);
    drive.update(1 / 60);

    const rotationAtCancel = node.quaternion.clone();
    const positionAtCancel = node.position.clone();
    const cancelLook = (drive as CameraDrive & { cancelLook?: () => void }).cancelLook;
    expect(cancelLook).toBeTypeOf('function');
    if (!cancelLook) return;

    cancelLook.call(drive);
    drive.update(0.1);

    expect(node.quaternion.angleTo(rotationAtCancel)).toBeLessThan(1e-9);
    expect(node.position.distanceTo(positionAtCancel)).toBeGreaterThan(0.05);
    expect(drive.hasInput).toBe(true);
  });
});

describe('captureCameraSample / restoreObjectOnNode', () => {
  it('采样节点通道：position/rotation 取变换，focalLength 优先 userData', () => {
    const node = makeCameraNode();
    node.position.set(1, 2, 3);
    node.rotation.set(0.1, 0.2, 0.3);
    node.userData.focalLength = 42;
    const sample = captureCameraSample(node);
    expect(sample.position).toEqual([1, 2, 3]);
    expect(sample.rotation).toEqual([0.1, 0.2, 0.3]);
    expect(sample.focalLength).toBe(42);
  });

  it('无 userData 焦距时由 fov 反推；非相机节点为 null', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    expect(captureCameraSample(camera).focalLength).toBeGreaterThan(0);
    const group = new THREE.Group();
    expect(captureCameraSample(group).focalLength).toBeNull();
  });

  it('restoreObjectOnNode 还原静态位姿与相机参数，清除驾驶焦距标记', () => {
    const object: SceneObjectData = {
      id: 'cam',
      type: 'camera',
      name: '机位',
      parentId: null,
      transform: { position: [0, 1.6, 6], rotation: [0.3, 0.5, 0.1], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      camera: {
        projection: 'perspective',
        focalLength: 35,
        fov: focalLengthToFovDeg(35),
        sensorWidth: 36,
        sensorHeight: 24,
        near: 0.05,
        far: 500,
        aspect: 2,
      },
    };
    const node = makeCameraNode();
    node.position.set(9, 9, 9);
    node.rotation.set(0, 0, 0);
    node.fov = 90;
    restoreObjectOnNode(node, object);
    expect(node.position.toArray()).toEqual([0, 1.6, 6]);
    expect(node.rotation.x).toBeCloseTo(0.3);
    expect(node.fov).toBeCloseTo(object.camera!.fov, 6);
    expect(node.near).toBe(0.05);
    expect(node.far).toBe(500);
    expect((node.userData as Record<string, unknown>).focalLength).toBeUndefined();
  });
});
