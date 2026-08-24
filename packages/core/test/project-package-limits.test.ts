import { describe, expect, it } from 'vitest';
import { MAX_PACKAGE_TEXT_BYTES, preDecodePayloadFailure } from '../src/project/package';

describe('工程包资源上限先于解码（拒绝解码攻击）', () => {
  it('单资产上限：编码长度上界放行，超出在解码前拒绝', () => {
    // 12 字节上限 → 编码上界 4*ceil(12/3)=16 字符；16 字符解码恰为 12 字节 → 放行
    expect(preDecodePayloadFailure('a'.repeat(16), 12, 100, 0)).toBeNull();
    // 17 字符必然解码 ≥13 字节 → 解码前按编码长度拒绝
    expect(preDecodePayloadFailure('a'.repeat(17), 12, 100, 0)).toContain('编码长度超过单资产上限');
    // 编码长度在界内但解码字节超界（非 3 整倍数）：7 字节上限 → 编码上界 12 字符，
    // 12 字符解码 9 字节 > 7 → 按解码字节数拒绝
    expect(preDecodePayloadFailure('a'.repeat(12), 7, 100, 0)).toContain('解码字节数超过单资产上限');
    // 8 字符解码 6 字节 ≤ 7 → 放行
    expect(preDecodePayloadFailure('a'.repeat(8), 7, 100, 0)).toBeNull();
  });

  it('base64 填充精确换算（O(1) 按尾部 padding 扣减）', () => {
    // 'MTIz'→3 字节、'MTI='→2 字节、'Mg=='→1 字节
    expect(preDecodePayloadFailure('MTIz', 3, 100, 0)).toBeNull();
    expect(preDecodePayloadFailure('MTI=', 3, 100, 0)).toBeNull();
    expect(preDecodePayloadFailure('Mg==', 3, 100, 0)).toBeNull();
    // 2 字节上限：无填充的 3 字节拒绝，1 个 padding 的 2 字节放行
    expect(preDecodePayloadFailure('MTIz', 2, 100, 0)).toContain('解码字节数超过单资产上限');
    expect(preDecodePayloadFailure('MTI=', 2, 100, 0)).toBeNull();
    // 1 字节上限：2 个 padding 的 1 字节放行，其余拒绝
    expect(preDecodePayloadFailure('Mg==', 1, 100, 0)).toBeNull();
    expect(preDecodePayloadFailure('MTI=', 1, 100, 0)).toContain('解码字节数超过单资产上限');
    // 未对齐输入按保守上界（ceil）处理，不误放行：'aaa'→ceil(9/4)=3 字节
    expect(preDecodePayloadFailure('aaa', 3, 100, 0)).toBeNull();
    expect(preDecodePayloadFailure('aaa', 2, 100, 0)).toContain('解码字节数超过单资产上限');
  });

  it('累计上限：剩余预算不足时在解码前拒绝（预算按已解码字节扣减）', () => {
    // 总上限 16，已计 6 → 剩余 10；16 字符解码 12 字节 → 6+12=18 > 16 拒
    expect(preDecodePayloadFailure('a'.repeat(16), 12, 16, 6)).toContain('载荷累计字节数超过上限');
    // 12 字符解码 9 字节 → 6+9=15 ≤ 16 放行
    expect(preDecodePayloadFailure('a'.repeat(12), 12, 16, 6)).toBeNull();
  });

  it('单资产与累计检查的顺序：先单资产后累计', () => {
    // 同时超两个界限时报告单资产超限（先于累计检查）
    expect(preDecodePayloadFailure('a'.repeat(28), 12, 16, 0)).toContain('编码长度超过单资产上限');
    // 编码通过但解码超单资产，同样先于累计报告
    expect(preDecodePayloadFailure('a'.repeat(12), 7, 16, 0)).toContain('解码字节数超过单资产上限');
  });

  it('与真实常量一致（512MiB 单资产 / 1GiB 总上限的编码上界）', () => {
    expect(MAX_PACKAGE_TEXT_BYTES).toBeGreaterThan((1024 * 1024 * 1024 * 4) / 3);
  });
});
