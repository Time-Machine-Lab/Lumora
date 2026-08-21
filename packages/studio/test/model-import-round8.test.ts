// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject, SceneEditor } from '@lumora/core';
import { ContentCache } from '../src/components/editor/content-cache';
import { importModelFile } from '../src/components/editor/model-import';

/**
 * R8-10 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * GLTF 外部路径与持久化集合不可靠（model-import.ts:44-52,121-136,171-188 +
 * content-cache.ts:219-263）：
 * - 全部选中文件（含未引用文件）都持久化为 parts 并参与组合哈希 →
 *   增删无关文件改变内容哈希、去重失效、载荷膨胀；
 * - 重复选中的同一依赖重复持久化，哈希不稳定；
 * - URI 与实体路径共用同一 decode 规范化：实体文件名里的字面 % 序列被
 *   误当作 percent 编码解码，与编码 URI 假命中（错误接受）；
 * - 主文件目录前缀不匹配时回退 basename，丢失目录结构。
 * 修复：只持久化 required URI 实际解析的去重集合；URI 按段 decode、
 * 实体路径按字面保留，两侧分别规范化；以主文件目录解析完整 POSIX 相对路径。
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

describe('R8-10 GLTF 外部依赖：路径解析与持久化集合', () => {
  it('R8-10-T1 只持久化 required URI 实际解析的去重集合：未引用文件不进 parts，组合哈希不受其影响', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'models/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ buffers: ['scene.bin'], images: ['textures/wood.png'] }))),
      'model/gltf+json',
    );
    const bin = fileWithPath('scene.bin', 'models/scene.bin', [1, 2, 3, 4], 'application/octet-stream');
    const wood = fileWithPath('wood.png', 'models/textures/wood.png', [9, 9, 9], 'image/png');
    const unused = fileWithPath('unused.txt', 'models/unused.txt', [0], 'text/plain');

    const first = await importModelFile(editor, cache, [main, bin, wood, unused]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const paths = (first.asset.parts ?? []).map((p) => p.path).sort();
    // RED：旧实现把全部选中文件（含未引用的 unused.txt）持久化为 parts
    expect(paths).toEqual(['scene.bin', 'textures/wood.png']);
    const sizes = first.asset.size;
    expect(sizes).toBe(main.size + 4 + 3);

    const second = await importModelFile(editor, cache, [main, bin, wood]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // RED：旧实现 parts 含未引用文件 → 组合哈希变化 → 同内容去重失败
    expect(second.asset.hash).toBe(first.asset.hash);
    expect(second.deduped).toBe(true);
  });

  it('R8-10-T2 重复选中的同一依赖：按解析结果去重，不重复持久化、哈希稳定', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'models/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ buffers: ['scene.bin'] }))),
      'model/gltf+json',
    );
    const binA = fileWithPath('scene.bin', 'models/scene.bin', [1, 2, 3, 4], 'application/octet-stream');
    const binB = fileWithPath('scene.bin', 'models/scene.bin', [1, 2, 3, 4], 'application/octet-stream');

    const first = await importModelFile(editor, cache, [main, binA, binB]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // RED：旧实现两份同路径依赖全部持久化
    expect(first.asset.parts).toHaveLength(1);

    const second = await importModelFile(editor, cache, [main, binA]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // RED：旧实现 partsText 含重复项 → 哈希不稳定 → 去重失败
    expect(second.asset.hash).toBe(first.asset.hash);
    expect(second.deduped).toBe(true);
  });

  it('R8-10-T3 URI 与实体路径分别规范化：字面 % 文件名不得与编码 URI 假命中', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'models/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ images: ['tex%20x.png'] }))),
      'model/gltf+json',
    );
    // 实体文件的名字真的含有字面 '%20'（四个字符），不是编码后的空格
    const literal = fileWithPath('tex%20x.png', 'models/tex%20x.png', [1], 'image/png');

    const result = await importModelFile(editor, cache, [main, literal]);
    // RED：旧实现两侧统一 decodeURIComponent → 'tex x.png' 假命中（错误接受）；
    // 修复后 URI 解码为 'tex x.png'、实体按字面保留 → 缺失 → 正确拒绝
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('缺少依赖文件');
  });

  it('R8-10-T4 以主文件目录解析完整 POSIX 相对路径：目录外依赖以 ../ 上溯', async () => {
    const main = fileWithPath(
      'scene.gltf',
      'models/scene.gltf',
      Array.from(new TextEncoder().encode(gltfJson({ images: ['textures/wood.png'] }))),
      'model/gltf+json',
    );
    // 主文件在 models/ 子目录，依赖在目录树兄弟分支
    const wood = fileWithPath('wood.png', 'textures/wood.png', [9], 'image/png');

    const result = await importModelFile(editor, cache, [main, wood]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // RED：旧实现主目录前缀不匹配时回退 basename（'wood.png'），丢失目录结构；
    // 修复后以主文件目录为基准构造完整相对路径 '../textures/wood.png'
    expect(result.asset.parts?.[0]?.path).toBe('../textures/wood.png');
  });
});
