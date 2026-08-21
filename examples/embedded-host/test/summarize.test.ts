import { describe, expect, it } from 'vitest';
import { SUMMARY_CHAR_BUDGET, summarize } from '../src/summarize';

describe('summarize：有界事件摘要（TML-87）', () => {
  it('原始值保持可读', () => {
    expect(summarize(null)).toBe('null');
    expect(summarize(undefined)).toBe('undefined');
    expect(summarize(123)).toBe('123');
    expect(summarize(true)).toBe('true');
    expect(summarize(42n)).toBe('42n');
    expect(summarize(Symbol('测试符号'))).toBe('Symbol(测试符号)');
    expect(summarize(() => {})).toBe('[function]');
    expect(summarize('hello')).toBe('"hello"');
    expect(summarize({ a: 1 })).toBe('{a: 1}');
  });

  it('超长字符串截断并标注长度', () => {
    const out = summarize('a'.repeat(5000));
    expect(out).toMatch(/^"a{120}…"\(5000 字符\)$/);
  });

  it('base64 载荷替换为 [base64: N 字符]，不落内容', () => {
    const payload = Buffer.alloc(4096, 0x5a).toString('base64');
    const out = summarize({ payload });
    expect(out).toContain('[base64: 5464 字符]');
    expect(out).not.toContain(payload.slice(0, 100));
  });

  it('非 base64 的长文本仍走截断预览而非掩码', () => {
    const text = Array.from({ length: 300 }, (_, i) => `段落 ${i}`).join('，');
    const out = summarize(text);
    expect(out).toContain('字符');
    expect(out).not.toContain('[base64:');
  });

  it('超长 Error.message 被截断', () => {
    const sentinel = '未截断则出现的哨兵';
    const out = summarize({ error: new Error(`${'x'.repeat(100_000)}${sentinel}`) });
    expect(out.length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET + 1);
    expect(out).toContain('[Error: ');
    expect(out).not.toContain(sentinel);
  });

  it('超长键名被截断', () => {
    const key = 'k'.repeat(5000);
    const out = summarize({ [key]: 1 });
    expect(out.length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET + 1);
    expect(out).not.toContain(key);
  });

  it('深对象在深度上限处折叠', () => {
    let value: unknown = { a: 1 };
    for (let i = 0; i < 50; i++) value = { next: value };
    const out = summarize(value);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET + 1);
    expect(out).toContain('…');
    expect(out).not.toContain('a: 1');
  });

  it('宽对象只显示前 8 个键并标注溢出，不遍历全部键', () => {
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    const out = summarize(wide);
    expect(out).toBe('{k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, …}');
    expect(out).not.toContain('k8:');
  });

  it('数组只显示前 8 项并标注总长', () => {
    const out = summarize(Array.from({ length: 100 }, (_, i) => `项${i}`));
    expect(out).toBe('["项0", "项1", "项2", "项3", "项4", "项5", "项6", "项7", …共 100 项]');
  });

  it('共享字符预算耗尽时整行截断，无单行超限', () => {
    const longText = '长文本'.repeat(200);
    const item = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, longText]));
    const out = summarize({ items: Array.from({ length: 8 }, () => item) });
    expect(out.length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});
