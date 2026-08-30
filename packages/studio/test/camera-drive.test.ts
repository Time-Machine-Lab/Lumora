import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { focalLengthToFovDeg } from '@lumora/core';
import type { SceneObjectData } from '@lumora/core';
import {
  CameraDrive,
  MAX_FOCAL_MM,
  MIN_FOCAL_MM,
  captureCameraSample,
  restoreObjectOnNode,
} from '../src/components/editor/camera-drive';

function makeCameraNode(): THREE.PerspectiveCamera {
  const node = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
  node.position.set(0, 1.6, 6);
  node.userData.objectId = 'cam';
  node.userData.focalLength = 50;
  return node;
}

describe('CameraDrive：键鼠驾驶积分器', () => {
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
