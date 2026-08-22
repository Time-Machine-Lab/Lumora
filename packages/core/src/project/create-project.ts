/**
 * 空白项目工厂（FR-001：创建项目 → 初始化默认场景与摄像机）。
 * 与 sample-project 的区别：不带演示内容，仅含一个默认场景与一台默认摄像机。
 */

import { createCameraObject, createScene, genId } from '../scene/create';
import type { Project } from '../scene/types';

export interface BlankProjectOptions {
  /** 画幅宽高比，默认 16:9 */
  aspect?: [number, number];
  fps?: number;
}

export function createBlankProject(
  uri = `lumora://project/${genId('p')}`,
  name = '未命名项目',
  options: BlankProjectOptions = {},
): Project {
  const now = new Date().toISOString();
  const scene = createScene('主场景');
  const camera = createCameraObject('主摄像机');
  return {
    uri,
    name,
    schemaVersion: 2,
    createdAt: now,
    revision: 0,
    settings: { fps: options.fps ?? 24, aspect: options.aspect ?? [16, 9] },
    activeSceneId: scene.id,
    scenes: [{ ...scene, rootObjectIds: [camera.id], activeCameraId: camera.id }],
    objects: [camera],
    assets: [],
  };
}
