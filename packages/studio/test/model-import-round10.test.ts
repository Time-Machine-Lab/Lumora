// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject, SceneEditor } from '@lumora/core';
import { ContentCache } from '../src/components/editor/content-cache';
import { importModelFile } from '../src/components/editor/model-import';

/**
 * R10-M3 #10 对抗测试（TML-57 第十轮 M3，修复前必须失败）：
 * partPathFor 把依赖路径表示为「自 main 目录上溯」的相对形态（../… 链），
 * resolvePartPath 的两侧归并却吞掉前导 '..' → 深度区分失效：main 于 a/b/、
 * uri='../../textures/wood.png'（两级上溯）同时存在一级上溯候选时，现 HEAD
 * 错误精确命中一级候选，持久化 '../textures/wood.png'（依赖与 URI 错配，
 * 重开项目后按同一规则加载到错误文件）。修复后深度参与精确比较，命中两级
 * 上溯者，持久化 '../../textures/wood.png'。
 */

function makeGltf(): GLTF {
  return { scene: new THREE.Group() } as unknown as GLTF;
}

/** File + webkitRelativePath（目录选择形态）；路径统一 POSIX 分隔 */
function fileWithPath(name: string, path: string, bytes: number[], type: string): File {
  const file = new File([new Uint8Array(bytes)], name, { type });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

function gltfJson(uris: { buffers?: string[]; images?: string[] }): string {
  return JSON.stringify({
    asset: { version: '2.0' },
    buffers: (uris.buffers ?? []).map((uri) => ({ uri, byteLength: 4 })),
    images: (uris.images ?? []).map((uri) => ({ uri })),
  });
}

let editor: SceneEditor;
let cache: ContentCache;

beforeEach(() => {
  editor = new SceneEditor();
  editor.openProject(createSampleProject());
  cache = new ContentCache({ loader: vi.fn(async () => makeGltf()) });
});

afterEach(() => {
  cache.dispose();
});

describe('R10-M3 #10 GLTF 相对路径：前导 .. 深度端到端', () => {
  it('R10-10-T4 main 于 a/b/：两级上溯 URI 精确命中两级依赖，持久化 ../../ 相对路径（RED）', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'a/b/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ images: ['../../textures/wood.png'] }))),
      'model/gltf+json',
    );
    const near = fileWithPath('wood.png', 'a/textures/wood.png', [9], 'image/png');
    const far = fileWithPath('wood.png', 'textures/wood.png', [7], 'image/png');

    const result = await importModelFile(editor, cache, [main, near, far]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // RED：现 HEAD 深度被归并吞掉 → exact 命中一级上溯（near）→ 持久化
    // '../textures/wood.png'（URI 与依赖错配）；修复后命中 far（两级）
    expect(result.asset.parts?.map((p) => p.path)).toEqual(['../../textures/wood.png']);
  });
});
