/**
 * 键鼠实时摄像机驾驶（TML-52）：把按键意图经指数平滑积分到 THREE 节点，
 * 录制时由 TimelineRecorder 采样节点。页面失焦（blur）时 stop() 立即清零
 * 速度 —— 录制暂停、无失控位移（AC2）。
 */

import * as THREE from 'three';
import { focalLengthToFovDeg, fovDegToFocalLength } from '@lumora/core';
import type { SceneObjectData } from '@lumora/core';
import { applyTransform } from './scene-builder';

export interface CameraDriveSettings {
  /** 平移速度（米/秒） */
  speed: number;
  /** 旋转速度（弧度/秒） */
  rotateSpeed: number;
  /** 平滑系数（1/秒）：速度向目标逼近的指数速率，越大越跟手 */
  smoothing: number;
}

export const DEFAULT_CAMERA_DRIVE_SETTINGS: CameraDriveSettings = {
  speed: 2.5,
  rotateSpeed: 1.2,
  smoothing: 8,
};

export const MIN_FOCAL_MM = 8;
export const MAX_FOCAL_MM = 200;

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
  private velocity = new THREE.Vector3();
  private yawSpeed = 0;
  private pitchSpeed = 0;
  private focalSpeed = 0;
  private focal = 50;

  constructor(settings: Partial<CameraDriveSettings> = {}) {
    this.settings = { ...DEFAULT_CAMERA_DRIVE_SETTINGS, ...settings };
  }

  getSettings(): CameraDriveSettings {
    return { ...this.settings };
  }

  setSettings(settings: Partial<CameraDriveSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  /** 绑定驾驶目标；重置按键与速度，焦距从节点推导 */
  attach(target: THREE.Object3D): void {
    this.detach();
    this.target = target;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.yawSpeed = 0;
    this.pitchSpeed = 0;
    this.focalSpeed = 0;
    this.focal = this.readFocal(target);
  }

  /** 解除绑定（速度归零）；不恢复节点变换（调用方按需 restore） */
  detach(): void {
    this.target = null;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.yawSpeed = 0;
    this.pitchSpeed = 0;
    this.focalSpeed = 0;
  }

  /** 页面失焦：清空按键并立即归零速度 —— 无失控位移 */
  stop(): void {
    this.detach();
  }

  press(code: string): void {
    this.keys.add(code);
  }

  release(code: string): void {
    this.keys.delete(code);
  }

  get hasInput(): boolean {
    return this.keys.size > 0 || this.velocity.lengthSq() > 1e-9 || Math.abs(this.yawSpeed) > 1e-6;
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
    const { speed, rotateSpeed, smoothing } = this.settings;
    const k = 1 - Math.exp(-smoothing * dt);
    const boost = isHeld(this.keys, KEY_BOOST) ? 3 : 1;
    const slow = isHeld(this.keys, KEY_SLOW) ? 0.25 : 1;
    const scale = speed * boost * slow;

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(target.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(target.quaternion);
    const targetVelocity = new THREE.Vector3();
    if (isHeld(this.keys, KEY_FORWARD)) targetVelocity.addScaledVector(forward, scale);
    if (isHeld(this.keys, KEY_BACK)) targetVelocity.addScaledVector(forward, -scale);
    if (isHeld(this.keys, KEY_RIGHT)) targetVelocity.addScaledVector(right, scale);
    if (isHeld(this.keys, KEY_LEFT)) targetVelocity.addScaledVector(right, -scale);
    if (isHeld(this.keys, KEY_UP)) targetVelocity.y += scale;
    if (isHeld(this.keys, KEY_DOWN)) targetVelocity.y -= scale;
    this.velocity.lerp(targetVelocity, k);
    target.position.addScaledVector(this.velocity, dt);

    const targetYaw = (isHeld(this.keys, KEY_YAW_LEFT) ? -1 : 0) + (isHeld(this.keys, KEY_YAW_RIGHT) ? 1 : 0);
    const targetPitch = (isHeld(this.keys, KEY_PITCH_UP) ? -1 : 0) + (isHeld(this.keys, KEY_PITCH_DOWN) ? 1 : 0);
    this.yawSpeed = lerp(this.yawSpeed, targetYaw * rotateSpeed, k);
    this.pitchSpeed = lerp(this.pitchSpeed, targetPitch * rotateSpeed, k);
    if (Math.abs(this.yawSpeed) > 1e-9) {
      target.rotateOnWorldAxis(UP_VECTOR, this.yawSpeed * dt);
    }
    if (Math.abs(this.pitchSpeed) > 1e-9) {
      target.rotateX(this.pitchSpeed * dt);
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
