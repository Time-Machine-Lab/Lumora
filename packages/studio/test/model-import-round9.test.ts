// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject, SceneEditor } from '@lumora/core';
import { ContentCache } from '../src/components/editor/content-cache';
import { importModelFile } from '../src/components/editor/model-import';

/**
 * R9-M3 #10 对抗测试（TML-57 第九轮 M3，修复前必须失败）：
 * partPathFor 对「主文件目录前缀不匹配」的依赖用 '../'.repeat(mainDirSegments)
 * 构造相对路径——先上溯到根再沿 part 全段下行，重复了 LCP 之上的公共段
 * （reviewer 实测）：main='bundle/models/scene.gltf' + part='bundle/textures/wood.png'
 * 应持久化 '../textures/wood.png'，现 HEAD 产出 '../../bundle/textures/wood.png'。
 * 修复：按 main/part 段最长公共前缀（LCP）计算 POSIX 相对路径（relativePosixPath）。
 * T2 另覆盖 %2F 段边界端到端：URI 'textures%2Fwood.png' 不得命中实体
 * 'textures/wood.png'（导入必须失败，现 HEAD 错误接受）。
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

describe('R9-M3 #10 GLTF 相对路径：LCP 边界与 %2F 段', () => {
  it('R9-10-T1 reviewer 场景：main 在 bundle/models、依赖在 bundle/textures → ../textures/wood.png', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'bundle/models/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ images: ['../textures/wood.png'] }))),
      'model/gltf+json',
    );
    const wood = fileWithPath('wood.png', 'bundle/textures/wood.png', [9], 'image/png');

    const result = await importModelFile(editor, cache, [main, wood]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // RED：现 HEAD mainDirSegments=2 → '../../bundle/textures/wood.png'
    //（先上溯到根再沿 part 全段下行，重复 LCP 之上的公共段 bundle/）
    expect(result.asset.parts?.[0]?.path).toBe('../textures/wood.png');
  });

  it('R9-10-T2 %2F 段边界端到端：URI 编码斜杠不得命中两级实体，导入必须失败', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'models/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ images: ['textures%2Fwood.png'] }))),
      'model/gltf+json',
    );
    const wood = fileWithPath('wood.png', 'models/textures/wood.png', [9], 'image/png');

    const result = await importModelFile(editor, cache, [main, wood]);
    // RED：现 HEAD normalizeUri 压平段边界 → 精确命中实体 → 导入成功（错误接受）
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('缺少依赖文件');
  });

  it('R9-10-T3 主文件目录内的依赖：段内相对路径保持（防 LCP 修复过度）', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'bundle/models/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ images: ['textures/wood.png'] }))),
      'model/gltf+json',
    );
    const wood = fileWithPath('wood.png', 'bundle/models/textures/wood.png', [9], 'image/png');

    const result = await importModelFile(editor, cache, [main, wood]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.parts?.[0]?.path).toBe('textures/wood.png');
  });
});
