// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolvePartPath } from '../src/components/editor/content-cache';

/**
 * R10-M3 #10 对抗测试（TML-57 第十轮 M3，修复前必须失败）：
 * URI/实体两侧规范化把前导 '..' 当作普通上级段吞掉（if (out.length > 0)
 * out.pop()）——相对路径是「自 main 目录上溯」的形态（partPathFor 经
 * relativePosixPath 产出），深度信息在归并中丢失：'../../textures/wood.png'
 * 与 '../textures/wood.png'、'textures/wood.png' 归一后全等 → resolvePartPath
 * 错误精确命中（数组首位），两级上溯 URI 无法与一级上溯实体区分。
 * 修复：'..' 归并改为 stack-preserving（RFC 3986 §5.2.4 的栈语义，对
 * 相对路径形式有意偏离——前导 '..' 链是真实深度，必须保留）：栈顶为普通段
 * 时消费，栈顶为 '..' 或栈空时保留；内部 '..' 行为不变（仍消费前一段）。
 * RED 格（现 HEAD 行为）：T1 两级 URI 对 0/1 级实体错误 exact；T2 两级 URI
 * 对 1/2 级实体命中一级；T5 单级 URI 对 0 级实体错误 exact（修复后归入
 * unique-basename，解析结果不变——行为演进，测试注释登记）。
 */

function part(path: string): { path: string } {
  return { path };
}

describe('R10-M3 #10 前导 .. 深度保留：resolvePartPath', () => {
  it('R10-10-T1 深度区分：两级上溯 URI 不得精确命中 0/1 级相对路径（RED → 歧义失败）', () => {
    // RED：现 HEAD 两侧归并吞掉前导 .. → 三个归一结果全等 → 错误 exact 命中
    // parts[0]；修复后无精确命中 → basename 'wood.png' 双候选 → ambiguous
    const resolution = resolvePartPath('../../textures/wood.png', [
      part('textures/wood.png'),
      part('../textures/wood.png'),
    ]);
    expect(resolution.kind).toBe('ambiguous');
  });

  it('R10-10-T2 精确深度命中：两级上溯 URI 只命中两级相对路径（RED）', () => {
    // RED：现 HEAD 双候选归一相等 → exact 命中 parts[0]（一级上溯，错误）；
    // 修复后深度参与精确比较 → 命中二级上溯者
    const resolution = resolvePartPath('../../textures/wood.png', [
      part('../textures/wood.png'),
      part('../../textures/wood.png'),
    ]);
    expect(resolution.kind).toBe('exact');
    if (resolution.kind === 'exact') {
      expect(resolution.part.path).toBe('../../textures/wood.png');
    }
  });

  it('R10-10-T3 候选逆序不变性：深度命中与候选顺序无关（回归）', () => {
    const resolution = resolvePartPath('../../textures/wood.png', [
      part('../../textures/wood.png'),
      part('../textures/wood.png'),
    ]);
    expect(resolution.kind).toBe('exact');
    if (resolution.kind === 'exact') {
      expect(resolution.part.path).toBe('../../textures/wood.png');
    }
  });

  it('R10-10-T4 混合深度候选：深度精确者优先于 basename 兜底，不误入歧义', () => {
    // 0/1/2 级上溯三个候选；uri 两级 → 唯一深度精确命中（不得走 basename 歧义）
    const resolution = resolvePartPath('../../textures/wood.png', [
      part('textures/wood.png'),
      part('../textures/wood.png'),
      part('../../textures/wood.png'),
    ]);
    expect(resolution.kind).toBe('exact');
    if (resolution.kind === 'exact') {
      expect(resolution.part.path).toBe('../../textures/wood.png');
    }
  });

  it('R10-10-T5 单级上溯行为演进登记：exact 转为 unique-basename，解析结果不变（RED）', () => {
    // 行为演进（已登记，§5 矩阵）：旧实现把 '..' 吞掉 → 与 0 级实体 exact 命中
    //（深度被抹平）；修复后深度不匹配 → 由唯一 basename 兜底——同一 part、
    // 归属分支变化。可接受：相对路径含 '..' 时深度优先是正确语义
    const resolution = resolvePartPath('../textures/wood.png', [part('textures/wood.png')]);
    expect(resolution.kind).toBe('unique-basename');
    if (resolution.kind === 'unique-basename') {
      expect(resolution.part.path).toBe('textures/wood.png');
    }
  });

  it('R10-10-T6 段内归并保持：内部 .. 仍消费前一段（防过度修复）', () => {
    expect(resolvePartPath('sub/../sub/mesh.bin', [part('sub/mesh.bin')])).toEqual({
      kind: 'exact',
      part: part('sub/mesh.bin'),
    });
    expect(resolvePartPath('x/../mesh.bin', [part('mesh.bin')]).kind).toBe('exact');
    expect(resolvePartPath('sub/./mesh.bin', [part('sub/mesh.bin')]).kind).toBe('exact');
    expect(resolvePartPath('other/name.png', [part('textures/wood.png')]).kind).toBe('missing');
  });

  it('R10-10-T7 深度一致时仍精确：uri 与实体同为一级上溯（两侧保留对称性）', () => {
    const resolution = resolvePartPath('../textures/wood.png', [part('../textures/wood.png')]);
    expect(resolution.kind).toBe('exact');
    if (resolution.kind === 'exact') {
      expect(resolution.part.path).toBe('../textures/wood.png');
    }
  });
});
