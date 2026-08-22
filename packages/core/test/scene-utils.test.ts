import { describe, expect, it } from 'vitest';
import { hashBytes, sha256Hex } from '../src/scene/assets';
import { focalLengthToFovDeg, fovDegToFocalLength, fitRect, FULL_FRAME_SENSOR } from '../src/scene/camera-math';
import {
  collectUnreferencedAssets,
  findObject,
  getChildIds,
  getDescendantIds,
  isInSubtree,
  isValidTransform,
} from '../src/scene/scene-graph';
import { createSampleProject } from '../src/scene/sample-project';
import type { AssetData } from '../src/scene/types';

describe('资源哈希与去重', () => {
  it('相同内容哈希一致（SHA-256 确定性）', async () => {
    const data = new TextEncoder().encode('glb-content-1');
    const a = await hashBytes(data);
    const b = await hashBytes(data.slice().buffer as ArrayBuffer);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同内容哈希不同', async () => {
    const a = await hashBytes(new TextEncoder().encode('aaa'));
    const b = await hashBytes(new TextEncoder().encode('aab'));
    expect(a).not.toBe(b);
  });

  it('纯 JS SHA-256 与 WebCrypto 摘要一致（确定性算法，任何环境同结果）', async () => {
    const data = new TextEncoder().encode('deterministic hash content');
    const subtle = globalThis.crypto?.subtle;
    const js = sha256Hex(data);
    expect(js).toMatch(/^[0-9a-f]{64}$/);
    if (subtle) {
      const digest = await subtle.digest('SHA-256', data);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      expect(js).toBe(hex);
    }
  });

  it('纯 JS SHA-256 已知向量：空串与 abc', () => {
    expect(sha256Hex(new TextEncoder().encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('collectUnreferencedAssets：删除最后引用后资源无引用可释放', () => {
    const project = createSampleProject();
    const asset: AssetData = {
      id: 'asset-1',
      kind: 'gltf',
      name: 'm.glb',
      mime: 'model/gltf-binary',
      hash: 'h1',
      size: 10,
      source: 'file',
      storageRef: 'blob:url',
      createdAt: '2026-01-01',
    };
    const withAsset = { ...project, assets: [asset] };
    expect(collectUnreferencedAssets(withAsset)).toHaveLength(1);
    const referenced = {
      ...withAsset,
      objects: [
        ...withAsset.objects,
        { ...withAsset.objects[0]!, id: 'model-1', type: 'model' as const, assetId: 'asset-1' },
      ],
    };
    expect(collectUnreferencedAssets(referenced)).toHaveLength(0);
  });
});

describe('摄像机数学', () => {
  it('50mm 全画幅 → 垂直 FOV ≈ 26.99°；往返一致', () => {
    const fov = focalLengthToFovDeg(50, FULL_FRAME_SENSOR.height);
    expect(fov).toBeCloseTo(26.99, 1);
    expect(fovDegToFocalLength(fov, FULL_FRAME_SENSOR.height)).toBeCloseTo(50, 5);
  });

  it('focal↔fov 反函数在多个焦距上往返一致', () => {
    for (const mm of [24, 35, 50, 85, 135]) {
      const fov = focalLengthToFovDeg(mm);
      expect(fovDegToFocalLength(fov)).toBeCloseTo(mm, 5);
    }
  });

  it('fitRect：宽容器按高适配，高容器按宽适配，居中黑边', () => {
    // 16:9 内容放入 16:9 容器 → 满幅
    expect(fitRect(1600, 900, 16 / 9)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    // 放入 4:3 容器 → 上下黑边
    const tall = fitRect(800, 600, 16 / 9);
    expect(tall.width).toBe(800);
    expect(tall.height).toBeCloseTo(450);
    expect(tall.y).toBeCloseTo(75);
    // 放入 2:1 容器 → 左右黑边
    const wide = fitRect(1200, 600, 16 / 9);
    expect(wide.height).toBe(600);
    expect(wide.width).toBeCloseTo(1066.67, 1);
    expect(wide.x).toBeCloseTo(66.67, 1);
  });

  it('fitRect：非法输入回退到容器尺寸', () => {
    expect(fitRect(800, 600, 0)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(fitRect(0, 600, 16 / 9)).toEqual({ x: 0, y: 0, width: 0, height: 600 });
  });
});

describe('场景图查询', () => {
  const project = createSampleProject();

  it('示例项目：层级关系与根对象', () => {
    expect(project.settings.aspect).toEqual([16, 9]);
    expect(getChildIds(project, 'sample-group')).toEqual(['sample-cube', 'sample-sphere', 'sample-cone']);
    expect(findObject(project, 'sample-cube')?.parentId).toBe('sample-group');
    expect(getDescendantIds(project, 'sample-group')).toHaveLength(3);
    expect(getDescendantIds(project, 'sample-cube')).toHaveLength(0);
  });

  it('isInSubtree 覆盖自身与后代', () => {
    expect(isInSubtree(project, 'sample-group', 'sample-group')).toBe(true);
    expect(isInSubtree(project, 'sample-cube', 'sample-group')).toBe(true);
    expect(isInSubtree(project, 'sample-group', 'sample-cube')).toBe(false);
    expect(isInSubtree(project, 'sample-light', 'sample-group')).toBe(false);
  });

  it('变换校验拒绝 NaN/Infinity', () => {
    expect(isValidTransform({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] })).toBe(true);
    expect(
      isValidTransform({ position: [NaN, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    ).toBe(false);
    expect(
      isValidTransform({ position: [1, Infinity, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    ).toBe(false);
    expect(isValidTransform({ position: [1, 2], rotation: [0, 0, 0], scale: [1, 1, 1] })).toBe(false);
    expect(isValidTransform(null)).toBe(false);
  });
});
