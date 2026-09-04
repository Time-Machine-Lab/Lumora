/**
 * 键鼠实时摄像机驾驶（TML-52）：把按键意图经指数平滑积分到 THREE 节点，
 * 录制时由 TimelineRecorder 采样节点。页面失焦（blur）时 stop() 立即清零
 * 速度 —— 录制暂停、无失控位移（AC2）。
 */

import * as THREE from 'three';
import { focalLengthToFovDeg, fovDegToFocalLength } from '@lumora/core';
import type { SceneObjectData, TrackData } from '@lumora/core';
import { applyTransform } from './scene-builder';

export type CameraControlMode = 'keyboard-mouse' | 'keyboard-only';

export interface CameraDriveSettings {
  /** 键鼠模式由鼠标控制视角；纯键盘模式由方向键控制视角 */
  mode: CameraControlMode;
  /** 平移速度（米/秒） */
  speed: number;
  /** 短按移动键产生的确定步长（米） */
  tapStep: number;
  /** 从短按切换到连续移动的按住时间（秒） */
  holdDelay: number;
  /** 旋转速度（弧度/秒） */
  rotateSpeed: number;
  /** 鼠标视角灵敏度倍率 */
  mouseSensitivity: number;
  /** 仅反转鼠标拖动对应的垂直俯仰方向 */
  invertMouseY: boolean;
  /** 平滑系数（1/秒）：速度向目标逼近的指数速率，越大越跟手 */
  smoothing: number;
}

export const DEFAULT_CAMERA_DRIVE_SETTINGS: CameraDriveSettings = {
  mode: 'keyboard-mouse',
  speed: 2.5,
  tapStep: 0.1,
  holdDelay: 0.12,
  rotateSpeed: 1.2,
  mouseSensitivity: 1,
  invertMouseY: false,
  smoothing: 8,
};

export const CAMERA_DRIVE_LIMITS = Object.freeze({
  speed: Object.freeze({ min: 0.1, max: 20 }),
  tapStep: Object.freeze({ min: 0.01, max: 2 }),
  holdDelay: Object.freeze({ min: 0.05, max: 0.5 }),
  rotateSpeed: Object.freeze({ min: 0.1, max: 5 }),
  mouseSensitivity: Object.freeze({ min: 0.1, max: 3 }),
  smoothing: Object.freeze({ min: 1, max: 30 }),
});

/** A non-empty enabled track owns its bound camera channel during playback/seek. */
export function isCameraTakeoverTrack(track: TrackData, cameraId: string): boolean {
  return track.objectId === cameraId && track.keyframes.length > 0 && !track.disabled;
}

export interface CameraDriveBlockerInput {
  driveEnabled: boolean;
  /** Whether the export operation is actively running (the workspace cannot close yet). */
  exportRunning?: boolean;
  overwritePending: boolean;
  recordingPaused: boolean;
  playing: boolean;
  recording: boolean;
  cameraId: string | null;
  cameraName: string | null;
  tracks: readonly TrackData[];
}

export interface CameraDriveBlocker {
  kind: 'export' | 'overwrite' | 'recording-paused' | 'playback' | 'tracks';
  message: string;
  tracks?: readonly TrackData[];
}

/**
 * Resolve every active owner of manual camera input. The list is deliberately
 * independent: clearing one owner must not promise that another owner is gone.
 */
export function getCameraDriveBlockers(input: CameraDriveBlockerInput): CameraDriveBlocker[] {
  const blockers: CameraDriveBlocker[] = [];
  if (!input.driveEnabled) {
    blockers.push({
      kind: 'export',
      message: input.exportRunning
        ? '导出正在运行；请先取消或等待完成，再关闭导出，之后可手动操控。'
        : '导出工作区正在接管视口；关闭导出工作区后可手动操控。',
    });
  }
  if (input.overwritePending) {
    blockers.push({
      kind: 'overwrite',
      message: '正在等待录制覆盖确认；完成或放弃确认后可手动操控。',
    });
  }
  if (input.recordingPaused) {
    blockers.push({
      kind: 'recording-paused',
      message: '录制已暂停；继续录制或停止录制后可手动操控。',
    });
  }
  if (input.playing && !input.recording) {
    blockers.push({
      kind: 'playback',
      message: '播放正在接管机位；暂停播放后可手动操控。',
    });
  }
  if (!input.recording && input.cameraId && input.cameraName) {
    const takeoverTracks = input.tracks.filter((track) => isCameraTakeoverTrack(track, input.cameraId!));
    if (takeoverTracks.length > 0) {
      blockers.push({
        kind: 'tracks',
        tracks: takeoverTracks,
        message:
          `启用轨道${takeoverTracks.map((track) => `“${track.name}”`).join('、')}` +
          `正在接管机位“${input.cameraName}”；禁用这些轨道后可手动操控。`,
      });
    }
  }
  return blockers;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function normalizeCameraDriveSettings(
  settings: Partial<CameraDriveSettings>,
  base: CameraDriveSettings = DEFAULT_CAMERA_DRIVE_SETTINGS,
): CameraDriveSettings {
  return {
    mode: settings.mode === 'keyboard-mouse' || settings.mode === 'keyboard-only' ? settings.mode : base.mode,
    speed: bounded(settings.speed, base.speed, CAMERA_DRIVE_LIMITS.speed.min, CAMERA_DRIVE_LIMITS.speed.max),
    tapStep: bounded(
      settings.tapStep,
      base.tapStep,
      CAMERA_DRIVE_LIMITS.tapStep.min,
      CAMERA_DRIVE_LIMITS.tapStep.max,
    ),
    holdDelay: bounded(
      settings.holdDelay,
      base.holdDelay,
      CAMERA_DRIVE_LIMITS.holdDelay.min,
      CAMERA_DRIVE_LIMITS.holdDelay.max,
    ),
    rotateSpeed: bounded(
      settings.rotateSpeed,
      base.rotateSpeed,
      CAMERA_DRIVE_LIMITS.rotateSpeed.min,
      CAMERA_DRIVE_LIMITS.rotateSpeed.max,
    ),
    mouseSensitivity: bounded(
      settings.mouseSensitivity,
      base.mouseSensitivity,
      CAMERA_DRIVE_LIMITS.mouseSensitivity.min,
      CAMERA_DRIVE_LIMITS.mouseSensitivity.max,
    ),
    invertMouseY: typeof settings.invertMouseY === 'boolean'
      ? settings.invertMouseY
      : base.invertMouseY,
    smoothing: bounded(
      settings.smoothing,
      base.smoothing,
      CAMERA_DRIVE_LIMITS.smoothing.min,
      CAMERA_DRIVE_LIMITS.smoothing.max,
    ),
  };
}

export const MIN_FOCAL_MM = 8;
export const MAX_FOCAL_MM = 200;
export const SINGULAR_CAMERA_WARNING = 'Camera cannot be driven because an ancestor transform is singular.';

const KEY_FORWARD = ['KeyW'];
const KEY_BACK = ['KeyS'];
const KEY_LEFT = ['KeyA'];
const KEY_RIGHT = ['KeyD'];
const KEY_UP = ['KeyQ'];
const KEY_DOWN = ['KeyE'];
const KEY_YAW_LEFT = ['ArrowLeft'];
const KEY_YAW_RIGHT = ['ArrowRight'];
const KEY_PITCH_UP = ['ArrowUp'];
const KEY_PITCH_DOWN = ['ArrowDown'];
const KEY_FOCAL_IN = ['BracketRight'];
const KEY_FOCAL_OUT = ['BracketLeft'];
const KEY_BOOST = ['ShiftLeft', 'ShiftRight'];
const KEY_SLOW = ['ControlLeft', 'ControlRight'];
const TRANSLATION_KEY_CODES: ReadonlySet<string> = new Set([
  ...KEY_FORWARD,
  ...KEY_BACK,
  ...KEY_LEFT,
  ...KEY_RIGHT,
  ...KEY_UP,
  ...KEY_DOWN,
]);
const KEYBOARD_MOUSE_KEY_CODES: ReadonlySet<string> = new Set([
  ...TRANSLATION_KEY_CODES,
  ...KEY_FOCAL_IN,
  ...KEY_FOCAL_OUT,
  ...KEY_BOOST,
  ...KEY_SLOW,
]);
const MAX_LOOK_DELTA = 80;
const LOOK_RADIANS_PER_PIXEL = 0.0025;

/** 驾驶键全集（按 event.code）：视口用它决定是否阻止浏览器默认行为（如方向键滚动） */
export const DRIVE_KEY_CODES: ReadonlySet<string> = new Set([
  ...KEY_FORWARD,
  ...KEY_BACK,
  ...KEY_LEFT,
  ...KEY_RIGHT,
  ...KEY_UP,
  ...KEY_DOWN,
  ...KEY_YAW_LEFT,
  ...KEY_YAW_RIGHT,
  ...KEY_PITCH_UP,
  ...KEY_PITCH_DOWN,
  ...KEY_FOCAL_IN,
  ...KEY_FOCAL_OUT,
  ...KEY_BOOST,
  ...KEY_SLOW,
]);

/** Apply a rigid camera delta in world space while preserving a nested node's local transform. */
export function applyCameraWorldDelta(
  mirrorNode: THREE.Object3D,
  previousPrimaryPosition: THREE.Vector3,
  previousPrimaryQuaternion: THREE.Quaternion,
  currentPrimaryPosition: THREE.Vector3,
  currentPrimaryQuaternion: THREE.Quaternion,
): boolean {
  const translationDelta = currentPrimaryPosition.clone().sub(previousPrimaryPosition);
  const rotationDelta = currentPrimaryQuaternion
    .clone()
    .multiply(previousPrimaryQuaternion.clone().invert())
    .normalize();
  const parent = mirrorNode.parent;
  mirrorNode.updateWorldMatrix(true, false);
  const parentTransform = parent ? getWorldTransformInfo(parent) : null;
  if (parent && !parentTransform?.invertible) return false;
  const worldPosition = mirrorNode.getWorldPosition(new THREE.Vector3()).add(translationDelta);
  const worldQuaternion = getWorldRigidQuaternion(mirrorNode)
    .premultiply(rotationDelta)
    .normalize();
  if (parent) {
    worldPosition.applyMatrix4(parentTransform!.inverse);
    if (!isFiniteVector(worldPosition)) return false;
  }
  setWorldRigidQuaternion(mirrorNode, worldQuaternion);
  mirrorNode.position.copy(worldPosition);
  return true;
}

export function getWorldRigidQuaternion(object: THREE.Object3D, result = new THREE.Quaternion()): THREE.Quaternion {
  const chain: THREE.Object3D[] = [];
  for (let current: THREE.Object3D | null = object; current; current = current.parent) chain.push(current);
  result.identity();
  for (let index = chain.length - 1; index >= 0; index -= 1) result.multiply(chain[index]!.quaternion);
  return result.normalize();
}

function setWorldRigidQuaternion(target: THREE.Object3D, worldQuaternion: THREE.Quaternion): void {
  const localQuaternion = worldQuaternion.clone();
  if (target.parent) localQuaternion.premultiply(getWorldRigidQuaternion(target.parent).invert());
  target.quaternion.copy(localQuaternion.normalize());
}

function rotateOnWorldAxis(target: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  const worldQuaternion = getWorldRigidQuaternion(target).premultiply(
    new THREE.Quaternion().setFromAxisAngle(axis, angle),
  );
  setWorldRigidQuaternion(target, worldQuaternion);
}

function rotateOnLocalAxis(target: THREE.Object3D, angle: number): void {
  const worldQuaternion = getWorldRigidQuaternion(target);
  const worldRight = new THREE.Vector3(1, 0, 0).applyQuaternion(worldQuaternion);
  worldQuaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(worldRight, angle));
  setWorldRigidQuaternion(target, worldQuaternion);
}

interface WorldTransformInfo {
  invertible: boolean;
  needsBasis: boolean;
  inverse: THREE.Matrix4;
  inverseLinear: THREE.Matrix3;
}

function getWorldTransformInfo(object: THREE.Object3D): WorldTransformInfo {
  object.updateWorldMatrix(true, false);
  const elements = object.matrixWorld.elements;
  const scaleX = Math.hypot(elements[0]!, elements[1]!, elements[2]!);
  const scaleY = Math.hypot(elements[4]!, elements[5]!, elements[6]!);
  const scaleZ = Math.hypot(elements[8]!, elements[9]!, elements[10]!);
  const right = new THREE.Vector3(elements[0]!, elements[1]!, elements[2]!).multiplyScalar(1 / scaleX);
  const up = new THREE.Vector3(elements[4]!, elements[5]!, elements[6]!).multiplyScalar(1 / scaleY);
  const forward = new THREE.Vector3(elements[8]!, elements[9]!, elements[10]!).multiplyScalar(1 / scaleZ);
  const basisDeterminant = right.dot(new THREE.Vector3().crossVectors(up, forward));
  const inverse = object.matrixWorld.clone().invert();
  const inverseIsNonZero = inverse.elements.some((value) => value !== 0);
  const invertible =
    scaleX > 0 &&
    scaleY > 0 &&
    scaleZ > 0 &&
    Number.isFinite(basisDeterminant) &&
    Math.abs(basisDeterminant) >= 1e-8 &&
    inverse.elements.every((value) => Number.isFinite(value)) &&
    inverseIsNonZero;
  if (!invertible) {
    return {
      invertible: false,
      needsBasis: true,
      inverse: new THREE.Matrix4(),
      inverseLinear: new THREE.Matrix3(),
    };
  }
  const largest = Math.max(scaleX, scaleY, scaleZ);
  const smallest = Math.min(scaleX, scaleY, scaleZ);
  const nonOrthogonal =
    Math.abs(right.dot(up)) > 1e-5 ||
    Math.abs(right.dot(forward)) > 1e-5 ||
    Math.abs(up.dot(forward)) > 1e-5;
  const matrixQuaternion = object.getWorldQuaternion(new THREE.Quaternion());
  const rigidQuaternion = getWorldRigidQuaternion(object);
  const signedRotation = matrixQuaternion.angleTo(rigidQuaternion) > 1e-5;
  const needsBasis =
    basisDeterminant < 0 ||
    (largest > 0 && largest - smallest > 1e-6 * largest) ||
    nonOrthogonal ||
    signedRotation;
  return {
    invertible: true,
    needsBasis,
    inverse,
    inverseLinear: new THREE.Matrix3().setFromMatrix4(inverse),
  };
}

export function hasNonRigidWorldTransform(object: THREE.Object3D): boolean {
  const info = getWorldTransformInfo(object);
  return !info.invertible || info.needsBasis;
}

export function hasSingularWorldTransform(object: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (!getWorldTransformInfo(current).invertible) return true;
  }
  return false;
}

function getWorldBasis(target: THREE.Object3D): {
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
} {
  const quaternion = getWorldRigidQuaternion(target);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  const forward = new THREE.Vector3(0, 0, target instanceof THREE.Camera ? -1 : 1).applyQuaternion(quaternion);
  return { right, up, forward };
}

/** Return the hierarchy's rigid pose without allowing ancestor scale or shear to distort camera roll. */
export function getWorldOrthonormalQuaternion(
  object: THREE.Object3D,
  result = new THREE.Quaternion(),
): THREE.Quaternion {
  return getWorldRigidQuaternion(object, result);
}

/** Synchronize a stable, unparented render/capture camera from a scene camera's rigid world pose. */
export function syncRigidCameraProxy(
  source: THREE.PerspectiveCamera,
  proxy: THREE.PerspectiveCamera,
  aspect: number,
): boolean {
  if (!getWorldTransformInfo(source).invertible) return false;
  const worldPosition = source.getWorldPosition(new THREE.Vector3());
  if (!isFiniteVector(worldPosition)) return false;
  proxy.position.copy(worldPosition);
  getWorldRigidQuaternion(source, proxy.quaternion);
  proxy.scale.set(1, 1, 1);
  proxy.fov = source.fov;
  proxy.aspect = aspect;
  proxy.near = source.near;
  proxy.far = source.far;
  proxy.zoom = source.zoom;
  proxy.focus = source.focus;
  proxy.filmGauge = source.filmGauge;
  proxy.filmOffset = source.filmOffset;
  proxy.updateProjectionMatrix();
  proxy.updateMatrixWorld(true);
  return true;
}

function getWorldMovementBasis(target: THREE.Object3D): {
  right: THREE.Vector3;
  forward: THREE.Vector3;
} {
  target.updateWorldMatrix(true, false);
  const basis = getWorldBasis(target);
  return { right: basis.right, forward: basis.forward };
}

function applyWorldTranslation(target: THREE.Object3D, worldDelta: THREE.Vector3): boolean {
  if (!isFiniteVector(worldDelta)) return false;
  if (!target.parent) {
    target.position.add(worldDelta);
    return true;
  }
  const parentTransform = getWorldTransformInfo(target.parent);
  if (!parentTransform.invertible) return false;
  const localDelta = worldDelta.clone().applyMatrix3(parentTransform.inverseLinear);
  if (!isFiniteVector(localDelta)) return false;
  target.position.add(localDelta);
  return true;
}

function isFiniteVector(vector: THREE.Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isHeld(keys: Set<string>, codes: string[]): boolean {
  return codes.some((code) => keys.has(code));
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * 相机驾驶积分器：attach 后 update(dt) 推进节点变换；press/release 记录按键，
 * stop() 清空按键并立即归零速度（失焦保护）。目标速度由按住按键合成，
 * 速度经指数平滑（smoothing 参数）——松键后有轻微余速滑行，blur 则硬停。
 */
export class CameraDrive {
  private target: THREE.Object3D | null = null;
  private settings: CameraDriveSettings;
  private keys = new Set<string>();
  private keyDurations = new Map<string, number>();
  private velocity = new THREE.Vector3();
  private yawSpeed = 0;
  private pitchSpeed = 0;
  private focalSpeed = 0;
  private focal = 50;
  private lookDelta = new THREE.Vector2();

  constructor(settings: Partial<CameraDriveSettings> = {}) {
    this.settings = normalizeCameraDriveSettings(settings);
  }

  getSettings(): CameraDriveSettings {
    return { ...this.settings };
  }

  setSettings(settings: Partial<CameraDriveSettings>): void {
    const previousMode = this.settings.mode;
    const previousInvertMouseY = this.settings.invertMouseY;
    this.settings = normalizeCameraDriveSettings(settings, this.settings);
    if (this.settings.mode !== previousMode) {
      this.clearMotion();
    } else if (this.settings.invertMouseY !== previousInvertMouseY) {
      this.cancelLook();
    }
  }

  acceptsKey(code: string): boolean {
    return this.settings.mode === 'keyboard-only'
      ? DRIVE_KEY_CODES.has(code)
      : KEYBOARD_MOUSE_KEY_CODES.has(code);
  }

  /** 绑定驾驶目标；重置按键与速度，焦距从节点推导 */
  attach(target: THREE.Object3D): void {
    this.detach();
    this.target = target;
    this.focal = this.readFocal(target);
  }

  /** 解除绑定（速度归零）；不恢复节点变换（调用方按需 restore） */
  detach(): void {
    this.target = null;
    this.clearMotion();
  }

  private clearMotion(): void {
    this.keys.clear();
    this.keyDurations.clear();
    this.velocity.set(0, 0, 0);
    this.yawSpeed = 0;
    this.pitchSpeed = 0;
    this.focalSpeed = 0;
    this.lookDelta.set(0, 0);
  }

  /** 页面失焦：清空按键并立即归零速度 —— 无失控位移 */
  stop(): void {
    this.detach();
  }

  press(code: string): void {
    if (!this.acceptsKey(code) || this.keys.has(code)) return;
    this.keys.add(code);
    if (TRANSLATION_KEY_CODES.has(code)) this.keyDurations.set(code, 0);
  }

  release(code: string): void {
    if (!this.keys.has(code)) return;
    const duration = this.keyDurations.get(code);
    if (duration !== undefined && duration < this.settings.holdDelay) this.applyTap(code);
    this.keys.delete(code);
    this.keyDurations.delete(code);
  }

  look(deltaX: number, deltaY: number): void {
    if (
      this.settings.mode !== 'keyboard-mouse' ||
      !Number.isFinite(deltaX) ||
      !Number.isFinite(deltaY)
    ) return;
    this.lookDelta.x = THREE.MathUtils.clamp(this.lookDelta.x + deltaX, -MAX_LOOK_DELTA, MAX_LOOK_DELTA);
    const verticalDelta = this.settings.invertMouseY ? -deltaY : deltaY;
    this.lookDelta.y = THREE.MathUtils.clamp(
      this.lookDelta.y + verticalDelta,
      -MAX_LOOK_DELTA,
      MAX_LOOK_DELTA,
    );
  }

  /** Clear queued pointer-look momentum without interrupting held keyboard input. */
  cancelLook(): void {
    this.lookDelta.set(0, 0);
  }

  /** Clear released-key drift without detaching the current camera target. */
  cancelTranslationMomentum(): void {
    this.velocity.set(0, 0, 0);
  }

  get hasInput(): boolean {
    return (
      this.keys.size > 0 ||
      this.velocity.lengthSq() > 1e-9 ||
      Math.abs(this.yawSpeed) > 1e-6 ||
      Math.abs(this.pitchSpeed) > 1e-6 ||
      Math.abs(this.focalSpeed) > 1e-6 ||
      this.lookDelta.lengthSq() > 1e-6
    );
  }

  private applyTap(code: string): void {
    const target = this.target;
    if (!target) return;
    if (hasSingularWorldTransform(target)) {
      this.clearMotion();
      return;
    }
    const boost = isHeld(this.keys, KEY_BOOST) ? 3 : 1;
    const slow = isHeld(this.keys, KEY_SLOW) ? 0.25 : 1;
    const step = this.settings.tapStep * boost * slow;
    const { forward, right } = getWorldMovementBasis(target);
    const worldDelta = new THREE.Vector3();
    if (KEY_FORWARD.includes(code)) worldDelta.copy(forward).multiplyScalar(step);
    else if (KEY_BACK.includes(code)) worldDelta.copy(forward).multiplyScalar(-step);
    else if (KEY_RIGHT.includes(code)) worldDelta.copy(right).multiplyScalar(step);
    else if (KEY_LEFT.includes(code)) worldDelta.copy(right).multiplyScalar(-step);
    else if (KEY_UP.includes(code)) worldDelta.copy(UP_VECTOR).multiplyScalar(step);
    else if (KEY_DOWN.includes(code)) worldDelta.copy(UP_VECTOR).multiplyScalar(-step);
    if (!applyWorldTranslation(target, worldDelta)) this.clearMotion();
  }

  private readFocal(node: THREE.Object3D): number {
    const stored = (node.userData as Record<string, unknown>).focalLength;
    if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
    if (node instanceof THREE.PerspectiveCamera) return fovDegToFocalLength(node.fov);
    return 50;
  }

  /** 每帧推进（dt 秒）：平移/旋转/焦距按平滑系数积分到节点 */
  update(deltaSeconds: number): void {
    const target = this.target;
    if (!target) return;
    const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    if (dt <= 0) return;
    if (hasSingularWorldTransform(target)) {
      this.clearMotion();
      return;
    }
    const { speed, holdDelay, rotateSpeed, mouseSensitivity, smoothing } = this.settings;
    const k = 1 - Math.exp(-smoothing * dt);
    const boost = isHeld(this.keys, KEY_BOOST) ? 3 : 1;
    const slow = isHeld(this.keys, KEY_SLOW) ? 0.25 : 1;
    const scale = speed * boost * slow;

    const { forward, right } = getWorldMovementBasis(target);
    const targetVelocity = new THREE.Vector3();
    const movementWeight = (code: string): number => {
      if (!this.keys.has(code)) return 0;
      const previous = this.keyDurations.get(code) ?? 0;
      const next = previous + dt;
      this.keyDurations.set(code, next);
      return Math.min(dt, Math.max(0, next - holdDelay)) / dt;
    };
    const forwardWeight = movementWeight('KeyW') - movementWeight('KeyS');
    const rightWeight = movementWeight('KeyD') - movementWeight('KeyA');
    const upWeight = movementWeight('KeyQ') - movementWeight('KeyE');
    targetVelocity.addScaledVector(forward, scale * forwardWeight);
    targetVelocity.addScaledVector(right, scale * rightWeight);
    targetVelocity.y += scale * upWeight;
    this.velocity.lerp(targetVelocity, k);
    if (!applyWorldTranslation(target, this.velocity.clone().multiplyScalar(dt))) {
      this.clearMotion();
      return;
    }

    const targetYaw = (isHeld(this.keys, KEY_YAW_LEFT) ? -1 : 0) + (isHeld(this.keys, KEY_YAW_RIGHT) ? 1 : 0);
    const targetPitch = (isHeld(this.keys, KEY_PITCH_UP) ? -1 : 0) + (isHeld(this.keys, KEY_PITCH_DOWN) ? 1 : 0);
    this.yawSpeed = lerp(this.yawSpeed, targetYaw * rotateSpeed, k);
    this.pitchSpeed = lerp(this.pitchSpeed, targetPitch * rotateSpeed, k);
    if (Math.abs(this.yawSpeed) > 1e-9) {
      rotateOnWorldAxis(target, UP_VECTOR, this.yawSpeed * dt);
    }
    if (Math.abs(this.pitchSpeed) > 1e-9) {
      rotateOnLocalAxis(target, this.pitchSpeed * dt);
    }

    if (this.settings.mode === 'keyboard-mouse' && this.lookDelta.lengthSq() > 1e-9) {
      const yaw = -this.lookDelta.x * k * mouseSensitivity * LOOK_RADIANS_PER_PIXEL;
      const pitch = this.lookDelta.y * k * mouseSensitivity * LOOK_RADIANS_PER_PIXEL;
      rotateOnWorldAxis(target, UP_VECTOR, yaw);
      rotateOnLocalAxis(target, pitch);
      this.lookDelta.multiplyScalar(1 - k);
      if (this.lookDelta.lengthSq() < 1e-6) this.lookDelta.set(0, 0);
    }

    const targetFocal = (isHeld(this.keys, KEY_FOCAL_IN) ? 1 : 0) + (isHeld(this.keys, KEY_FOCAL_OUT) ? -1 : 0);
    this.focalSpeed = lerp(this.focalSpeed, targetFocal * 12, k);
    if (Math.abs(this.focalSpeed) > 1e-6) {
      this.focal = Math.min(MAX_FOCAL_MM, Math.max(MIN_FOCAL_MM, this.focal + this.focalSpeed * dt));
      this.applyFocal(target, this.focal);
    }
  }

  private applyFocal(node: THREE.Object3D, focalLength: number): void {
    (node.userData as Record<string, unknown>).focalLength = focalLength;
    if (node instanceof THREE.PerspectiveCamera) {
      node.fov = focalLengthToFovDeg(focalLength);
      node.updateProjectionMatrix();
    }
  }
}

const UP_VECTOR = new THREE.Vector3(0, 1, 0);

/** 录制采样：视口把当前驱动/录制机位节点映射为可采样的通道值 */
export interface CaptureNodeSample {
  position: [number, number, number];
  rotation: [number, number, number];
  /** 节点焦距（无相机载荷或未推导时为 null，跳过 focalLength 通道） */
  focalLength: number | null;
}

/** 把录制机位节点映射为采样通道值（focalLength 优先读 userData，否则由 fov 反推） */
export function captureCameraSample(node: THREE.Object3D): CaptureNodeSample {
  const focal =
    (node.userData as Record<string, unknown>).focalLength ??
    (node instanceof THREE.PerspectiveCamera ? fovDegToFocalLength(node.fov) : null);
  return {
    position: [node.position.x, node.position.y, node.position.z],
    rotation: [node.rotation.x, node.rotation.y, node.rotation.z],
    focalLength: typeof focal === 'number' && Number.isFinite(focal) ? focal : null,
  };
}

/** 把项目对象数据恢复到节点（驾驶/回放结束后还原静态位姿与相机参数） */
export function restoreObjectOnNode(node: THREE.Object3D, object: SceneObjectData): void {
  applyTransform(node, object.transform);
  delete (node.userData as Record<string, unknown>).focalLength;
  if (node instanceof THREE.PerspectiveCamera && object.camera) {
    node.fov = object.camera.fov;
    node.aspect = object.camera.aspect ?? node.aspect;
    node.near = object.camera.near;
    node.far = object.camera.far;
    node.updateProjectionMatrix();
  }
}
