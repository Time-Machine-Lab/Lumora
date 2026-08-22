import { describe, expect, it } from 'vitest';
import { MAX_PACKAGE_TEXT_BYTES, preDecodePayloadFailure } from '../src/project/package';

describe('工程包资源上限先于解码（严重项回归：拒绝解码攻击）', () => {
  it('单资产上限：base64 字符数换算上界内放行，超出在解码前拒绝', () => {
    // 12 字节上限 → base64 最多 16 字符（ceil(12*4/3)=16）
    expect(preDecodePayloadFailure(16, 12, 100, 0)).toBeNull();
    expect(preDecodePayloadFailure(17, 12, 100, 0)).toContain('编码长度超过单资产上限');
    // 与真实常量一致（512MiB 上限 → 上限字符数）
    expect(MAX_PACKAGE_TEXT_BYTES).toBeGreaterThan((1024 * 1024 * 1024 * 4) / 3);
  });

  it('累计上限：剩余预算不足时在解码前拒绝（预算按已解码字节扣减）', () => {
    // 总上限 16，已计 6 → 剩余 10；11 字节载荷 base64 16 字符（解码上界 12 > 10）拒
    expect(preDecodePayloadFailure(16, 12, 16, 6)).toContain('载荷累计字节数超过上限');
    // 8 字节载荷 base64 12 字符（解码上界 9 ≤ 10）放行
    expect(preDecodePayloadFailure(12, 12, 16, 6)).toBeNull();
  });

  it('单资产与累计检查的顺序：先单资产后累计', () => {
    // 同时超两个界限时报告单资产超限（先于累计检查）
    expect(preDecodePayloadFailure(28, 12, 16, 0)).toContain('编码长度超过单资产上限');
  });
});
