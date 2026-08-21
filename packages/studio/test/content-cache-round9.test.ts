// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { relativePosixPath, resolvePartPath } from '../src/components/editor/content-cache';

/**
 * R9-M3 #10 对抗测试（TML-57 第九轮 M3，修复前必须失败）：
 * URI 规范化把解码后的 %2F 留在段内（不充当分隔符）的注释与实现不符——
 * normalizeUri 按段 decode 后重新 join 成 string，段边界被抹平：
 * - 'textures%2Fwood.png' 解码为单段 'textures/wood.png'，与两段实体
 *   'textures/wood.png' join 后相等 → resolvePartPath 错误精确命中（错误接受）；
 * - 混合编码 'sub%2Fdir/mesh.bin'（%2F 只在一段中间）同样被压平成三段实体；
 * - 含解码斜杠的最后一段仍参与 basename 兜底，段边界再次被抹平。
 * 修复：URI 规范化返回段数组（decode 后 %2F 保留为段内字面）；精确匹配 =
 * 段数组相等；只有最后一段不含解码斜杠时才允许 basename 兜底。
 */

function part(path: string): { path: string } {
  return { path };
}

describe('R9-M3 #10 URI 段边界：%2F 不得成为分隔符', () => {
  it('R9-10-T1 编码斜杠不得精确命中同级两段实体（textures%2Fwood.png ≠ textures/wood.png）', () => {
    // RED：现 HEAD normalizeUri 解码后 join → 'textures/wood.png' === 实体 → 'exact'
    const resolution = resolvePartPath('textures%2Fwood.png', [part('textures/wood.png')]);
    expect(resolution.kind).toBe('missing');
  });

  it('R9-10-T2 含解码斜杠的最后一段不得参与 basename 兜底', () => {
    // 若按段序列参与兜底：'tex/wood.png' 的 basename 'wood.png' 命中两条 → 歧义；
    // 修复后：最后一段含解码斜杠 → 无 basename 兜底 → 缺失（RED：现 HEAD 'exact'）
    const resolution = resolvePartPath('tex%2Fwood.png', [
      part('tex/wood.png'),
      part('other/wood.png'),
    ]);
    expect(resolution.kind).toBe('missing');
  });

  it('R9-10-T3 混合编码/未编码斜杠：%2F 只压平其所在段，不并入相邻段', () => {
    // 现 HEAD：['sub/dir','mesh.bin'] join → 'sub/dir/mesh.bin' === 实体 → 'exact'（错误）；
    // 修复后：精确匹配按段数组判等不命中；最后一段 'mesh.bin' 无解码斜杠 →
    // basename 兜底命中两条 → 歧义（不得静默取其一）
    const resolution = resolvePartPath('sub%2Fdir/mesh.bin', [
      part('sub/dir/mesh.bin'),
      part('other/mesh.bin'),
    ]);
    expect(resolution.kind).toBe('ambiguous');
  });

  it('R9-10-T4 未编码路径与 %20 空格：既有精确匹配语义保持（防过度修复）', () => {
    expect(resolvePartPath('textures/wood.png', [part('textures/wood.png')])).toEqual({
      kind: 'exact',
      part: part('textures/wood.png'),
    });
    expect(resolvePartPath('my%20tex.png', [part('my tex.png')]).kind).toBe('exact');
    expect(resolvePartPath('sub/./mesh.bin', [part('sub/mesh.bin')]).kind).toBe('exact');
    expect(resolvePartPath('sub/../sub/mesh.bin', [part('sub/mesh.bin')]).kind).toBe('exact');
    expect(resolvePartPath('other/name.png', [part('textures/wood.png')]).kind).toBe('missing');
  });
});

describe('R9-M3 #10 relativePosixPath：按段最长公共前缀上溯（LCP）', () => {
  it('R9-10-T5 reviewer 场景：bundle/models + bundle/textures → ../textures/wood.png（LCP=1，上溯 1）', () => {
    expect(relativePosixPath('bundle/models/scene.gltf', 'bundle/textures/wood.png')).toBe(
      '../textures/wood.png',
    );
  });

  it('R9-10-T6 目录外 LCP=0：完整上溯到根；主目录内：段内相对路径', () => {
    expect(relativePosixPath('models/scene.gltf', 'textures/wood.png')).toBe('../textures/wood.png');
    expect(relativePosixPath('models/scene.gltf', 'models/textures/wood.png')).toBe(
      'textures/wood.png',
    );
    expect(relativePosixPath('bundle/scene.gltf', 'bundle/textures/wood.png')).toBe(
      'textures/wood.png',
    );
  });

  it('R9-10-T7 深层 LCP 与主文件无目录边界', () => {
    expect(relativePosixPath('a/b/c/scene.gltf', 'a/b/wood.png')).toBe('../wood.png');
    expect(relativePosixPath('a/b/c/scene.gltf', 'a/x.png')).toBe('../../x.png');
    expect(relativePosixPath('scene.gltf', 'textures/wood.png')).toBe('textures/wood.png');
  });
});
