import { describe, expect, it } from 'vitest';
import { formatLogLine, SUMMARY_CHAR_BUDGET } from '../src/summarize';

/**
 * 统一行约束：任何摘要行都 <= 4096 字符且不含真实换行/行分隔符。
 * 字符类用 fromCharCode 构造，源码不含不可见行分隔符。
 */
const LINE_SEPARATORS = new RegExp(`[\r\n${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);

function expectBounded(line: string): void {
  expect(line.length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET);
  expect(line).not.toMatch(LINE_SEPARATORS);
}

const sumState = (state: unknown) =>
  formatLogLine('plugin:state-changed', { instanceId: 'i', pluginId: 'p', state, error: undefined });

const sumError = (error: unknown) => formatLogLine('command:executed', { id: 'c', ok: false, error });

describe('formatLogLine：完整日志行共享预算', () => {
  it('已知事件按字段摘要，事件名与 payload 在同一行', () => {
    const out = sumState(null);
    expect(out).toBe('plugin:state-changed {instanceId: "i", pluginId: "p", state: null, error: undefined}');
    expectBounded(out);
  });

  it('100KB 事件名：截断预留省略号空间，整行恰为预算上限', () => {
    const out = formatLogLine('e'.repeat(100_000), { project: null });
    expect(out).toBe('e'.repeat(SUMMARY_CHAR_BUDGET - 1) + '…');
    expect(out.length).toBe(SUMMARY_CHAR_BUDGET);
    expectBounded(out);
  });

  it('恰好占满预算的事件名：整行仍不超过预算', () => {
    const out = formatLogLine('e'.repeat(SUMMARY_CHAR_BUDGET), null);
    expect(out.length).toBe(SUMMARY_CHAR_BUDGET);
    expectBounded(out);
  });

  it('事件名与 payload 共享预算：事件名近满时 payload 被截断', () => {
    const out = formatLogLine('e'.repeat(SUMMARY_CHAR_BUDGET - 6), 'b'.repeat(100));
    expect(out).toBe('e'.repeat(SUMMARY_CHAR_BUDGET - 6) + ' "bbb…');
    expectBounded(out);
  });
});

describe('formatLogLine：无通用枚举，仅白名单字段访问（复审第 1、3 项）', () => {
  it('超大 BigInt 退化为固定占位，不做无界十进制转换', () => {
    const out = sumState(2n ** 100_000n);
    expect(out).toContain('state: [BigInt]');
    expectBounded(out);
  });

  it('小 BigInt 显示数值', () => {
    expect(sumState(42n)).toContain('state: 42n');
  });

  it('声明字段的 own getter 抛错：标 [取值失败]，摘要不抛错', () => {
    const evil: Record<string, unknown> = { instanceId: 'i', pluginId: 'p', state: null, error: undefined };
    Object.defineProperty(evil, 'state', { enumerable: true, get() { throw new Error('boom'); } });
    const out = formatLogLine('plugin:state-changed', evil);
    expect(out).toContain('state: [取值失败]');
    expectBounded(out);
  });

  it('继承 getter 不执行：读取声明字段前先做 own-property 检查（复审第 3 项）', () => {
    let leaked = false;
    const payload = Object.create({ get project() { leaked = true; return { x: 1 }; } });
    const out = formatLogLine('project:changed', payload);
    expect(leaked).toBe(false);
    expect(out).toBe('project:changed {}');
    expectBounded(out);
  });

  it('未知嵌套对象固定 [对象]：ownKeys/get/getOwnPropertyDescriptor 零访问（复审第 1 项）', () => {
    let descriptorCount = 0;
    let getCount = 0;
    const wide = new Proxy(
      Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i])),
      {
        getOwnPropertyDescriptor(target, prop) {
          descriptorCount++;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        ownKeys() {
          throw new Error('ownKeys 不应被调用');
        },
        get(target, prop, receiver) {
          getCount++;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const out = sumState(wide);
    expect(descriptorCount).toBe(0);
    expect(getCount).toBe(0);
    expect(out).toContain('state: [对象]');
    expectBounded(out);
  });

  it('大宽度普通对象：摘要为固定占位，工作量与对象宽度无关（复审第 1 项）', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 50_000; i++) wide[`k${i}`] = i;
    const out = sumState(wide);
    expect(out).toContain('state: [对象]');
    expectBounded(out);
  });

  it('继承宽对象：固定 [对象]，不出现任何键', () => {
    const proto: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) proto[`proto${i}`] = i;
    const child = Object.create(proto) as Record<string, unknown>;
    child.own = 1;
    const out = sumState(child);
    expect(out).toContain('state: [对象]');
    expect(out).not.toContain('proto');
    expect(out).not.toContain('own');
    expectBounded(out);
  });

  it('数组：无白名单项时只报长度，不枚举内容', () => {
    const out = sumState(Array.from({ length: 100 }, (_, i) => `项${i}`));
    expect(out).toContain('state: [数组×100]');
    expect(out).not.toContain('项0');
    expectBounded(out);
  });

  it('1 万资产只展开前 8 项，溢出仅标 …，不计算总数（复审第 1 项）', () => {
    const asset = { id: 'a', kind: 'gltf', name: 'n', size: 1, payload: 'A'.repeat(2_800_000) };
    const out = formatLogLine('project:changed', {
      project: { name: 'demo', revision: 2, assets: Array.from({ length: 10_000 }, () => asset) },
    });
    expect(out).toContain(', …]');
    expect(out).not.toContain('共 10000 项');
    expect(out).not.toContain('A'.repeat(50));
    expect(out.length).toBeLessThan(2000);
    expectBounded(out);
  });

  it('未知事件的对象 payload 退化为固定占位，不做反射枚举', () => {
    expect(formatLogLine('plugin:custom', { a: 1, b: 2 })).toBe('plugin:custom [对象]');
    expectBounded(formatLogLine('plugin:custom', { a: 1 }));
  });

  it('事件名命中对象原型键（constructor）时走未知路径，不误读原型', () => {
    expect(formatLogLine('constructor', { a: 1 })).toBe('constructor [对象]');
    expectBounded(formatLogLine('toString', { a: 1 }));
  });
});

describe('formatLogLine：Proxy/异常形状一律不抛错（复审第 2 项）', () => {
  it('revoked Proxy：已知事件路径与未知路径都不抛错', () => {
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();
    expect(() => sumState(proxy)).not.toThrow();
    expect(sumState(proxy)).toBe('plugin:state-changed {instanceId: "i", pluginId: "p", state: [对象], error: undefined}');
    // revoked Proxy 直接作为已知事件 payload：own-property 检查失败按缺失处理，不抛错
    expect(() => formatLogLine('project:changed', proxy)).not.toThrow();
    expect(formatLogLine('project:changed', proxy)).toBe('project:changed {}');
    expect(() => formatLogLine('plugin:custom', proxy)).not.toThrow();
    expect(formatLogLine('plugin:custom', proxy)).toBe('plugin:custom [对象]');
    expectBounded(sumState(proxy));
  });

  it('数组 Proxy 返回 Symbol length：退化为 [数组]，不参与比较/求最小值', () => {
    const weird = new Proxy([1, 2, 3], {
      get(target, prop, receiver) {
        if (prop === 'length') return Symbol('bad');
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(() => sumState(weird)).not.toThrow();
    expect(sumState(weird)).toContain('state: [数组]');
    expectBounded(sumState(weird));
  });

  it('Error Proxy 返回非字符串 message：退化为 [Error]，不进文本路径', () => {
    const bad = new Proxy(new Error('x'), {
      get(target, prop) {
        if (prop === 'message') return Symbol('m');
        return Reflect.get(target, prop);
      },
    });
    expect(() => sumError(bad)).not.toThrow();
    expect(sumError(bad)).toContain('error: [Error]');
    expectBounded(sumError(bad));
  });

  it('length 取值抛错的数组退化为 [数组]', () => {
    const badLen = new Proxy([1, 2], {
      get(target, prop, receiver) {
        if (prop === 'length') throw new Error('boom');
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = sumState(badLen);
    expect(out).toContain('state: [数组]');
    expectBounded(out);
  });

  it('Proxy 数组（白名单项）：length 与各下标只读一次，抛错项标 [取值失败]', () => {
    let getCount = 0;
    const arr = new Proxy([{ id: 'a', payload: 'A'.repeat(500) }, { id: 'b' }, { id: 'c' }], {
      get(target, prop, receiver) {
        getCount++;
        if (prop === '2') throw new Error('boom');
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = formatLogLine('project:changed', { project: { name: 'demo', assets: arr } });
    expect(getCount).toBe(4); // length + 三个下标；项字段走白名单，不经过数组 get
    expect(out).toContain('payload: [base64: 500 字符]');
    expect(out).toContain('[取值失败]');
    expectBounded(out);
  });
});

describe('formatLogLine：base64 内容掩码', () => {
  it('payload 字段按路径直接掩码，不读内容', () => {
    const out = formatLogLine('project:changed', {
      project: { name: 'demo', assets: [{ id: 'a1', payload: 'A'.repeat(2_800_000) }] },
    });
    expect(out).toContain('payload: [base64: 2800000 字符]');
    expect(out).not.toContain('A'.repeat(50));
    expectBounded(out);
  });

  it('payload 字段为非字符串时掩码为 [数据]', () => {
    const out = formatLogLine('project:changed', {
      project: { assets: [{ payload: { nested: 1 } }] },
    });
    expect(out).toContain('payload: [数据]');
    expect(out).not.toContain('nested');
    expectBounded(out);
  });

  it('纯大写 base64（Buffer.alloc 全零字节）被掩码', () => {
    const payload = Buffer.alloc(4096).toString('base64'); // 前缀全为 'A'
    expect(payload).toMatch(/^A{64}/);
    const out = sumState(payload);
    expect(out).toContain('[base64: 5464 字符]');
    expect(out).not.toContain('A'.repeat(50));
    expectBounded(out);
  });

  it('纯小写 base64 被掩码', () => {
    const payload = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(160);
    const out = sumState(payload);
    expect(out).toContain('[base64: 5760 字符]');
    expect(out).not.toContain(payload.slice(0, 100));
    expectBounded(out);
  });

  it('长普通文本（CJK）走截断预览而非掩码', () => {
    const out = sumState('大'.repeat(100_000));
    expect(out).toContain('…(100000 字符)');
    expect(out).not.toContain('[base64:');
    expectBounded(out);
  });

  it('未知事件的长 base64 字符串 payload 同样被掩码', () => {
    const out = formatLogLine('plugin:custom', 'A'.repeat(5000));
    expect(out).toContain('[base64: 5000 字符]');
    expect(out).not.toContain('AAAAA');
    expectBounded(out);
  });

  it('短字符串不做掩码（阈值 200）', () => {
    expect(sumState('a'.repeat(100))).toContain('"a');
    expectBounded(sumState('a'.repeat(100)));
  });
});

describe('formatLogLine：所有文本源统一转义控制字符', () => {
  it('字符串值中的换行/回车/行分隔符被转义', () => {
    const out = sumState('行1\n行2\r行3 行4 行5');
    expect(out).toContain('行1\\n行2\\r行3\\u2028行4\\u2029行5');
    expectBounded(out);
  });

  it('Error.message 中的换行被转义', () => {
    const out = sumError(new Error('坏\n消息'));
    expect(out).toContain('[Error: 坏\\n消息]');
    expectBounded(out);
  });

  it('Symbol 描述中的换行被转义', () => {
    const out = sumState(Symbol('描述\n带换行'));
    expect(out).toContain('[Symbol: 描述\\n带换行]');
    expectBounded(out);
  });

  it('事件名中的换行被转义', () => {
    const out = formatLogLine('foo\nbar', null);
    expect(out).toBe('foo\\nbar null');
    expectBounded(out);
  });

  it('200 个换行的长字符串：截断路径仍保持单行', () => {
    const out = sumState('\n'.repeat(200));
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('…(200 字符)');
    expectBounded(out);
  });
});

describe('formatLogLine：未知事件原始值', () => {
  it('原始值与错误对象', () => {
    expect(formatLogLine('plugin:custom', 42)).toBe('plugin:custom 42');
    expect(formatLogLine('plugin:custom', null)).toBe('plugin:custom null');
    expect(formatLogLine('plugin:custom', () => {})).toBe('plugin:custom [function]');
    expect(formatLogLine('plugin:custom', new Error('磁盘已满'))).toBe('plugin:custom [Error: 磁盘已满]');
  });
});
