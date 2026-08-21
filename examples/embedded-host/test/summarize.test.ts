import { describe, expect, it } from 'vitest';
import { formatLogLine, SUMMARY_CHAR_BUDGET } from '../src/summarize';

/**
 * 统一行约束：任何摘要行都 <= 4096 字符且不含真实换行/行分隔符。
 * 复审第 1、4 项：完整日志行（事件名 + payload）在同一预算内；所有文本源转义后单行。
 */
function expectBounded(line: string): void {
  expect(line.length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET);
  expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
}

const sumState = (state: unknown) =>
  formatLogLine('plugin:state-changed', { instanceId: 'i', pluginId: 'p', state, error: undefined });

const sumError = (error: unknown) => formatLogLine('command:executed', { id: 'c', ok: false, error });

describe('formatLogLine：完整日志行共享预算（复审第 1 项）', () => {
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
    // 非已知事件名：payload 为字符串，走统一截断路径，与事件名共享同一预算
    const out = formatLogLine('e'.repeat(SUMMARY_CHAR_BUDGET - 6), 'b'.repeat(100));
    expect(out).toBe('e'.repeat(SUMMARY_CHAR_BUDGET - 6) + ' "bbb…');
    expectBounded(out);
  });
});

describe('formatLogLine：摘要前无无界转换/枚举，节点预算兜底（复审第 2 项）', () => {
  it('超大 BigInt 退化为固定占位，不做无界十进制转换', () => {
    const out = sumState(2n ** 100_000n);
    expect(out).toContain('state: [BigInt]');
    expectBounded(out);
  });

  it('小 BigInt 显示数值', () => {
    expect(sumState(42n)).toContain('state: 42n');
  });

  it('throwing getter：单项 [取值失败]，摘要不抛错', () => {
    const evil = { good: 1, get bad() { throw new Error('boom'); } };
    const out = sumState(evil);
    expect(out).toContain('good: 1');
    expect(out).toContain('bad: [取值失败]');
    expectBounded(out);
  });

  it('ownKeys 抛错的 Proxy 退化为 [对象]', () => {
    const evil = new Proxy({ a: 1 }, { ownKeys() { throw new Error('boom'); } });
    const out = sumState(evil);
    expect(out).toContain('state: [对象]');
    expectBounded(out);
  });

  it('继承宽对象：只枚举自有键，继承键不耗预算', () => {
    const proto: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) proto[`proto${i}`] = i;
    const child = Object.create(proto) as Record<string, unknown>;
    child.own = 1;
    const out = sumState(child);
    expect(out).toContain('{own: 1}');
    expect(out).not.toContain('proto');
    expectBounded(out);
  });

  it('Proxy 宽对象：只读 8 个键的取值，ownKeys 只调用一次', () => {
    let ownKeysCount = 0;
    let getCount = 0;
    const wide = new Proxy(
      Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i])),
      {
        ownKeys(target) {
          ownKeysCount++;
          return Reflect.ownKeys(target);
        },
        get(target, prop, receiver) {
          getCount++;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const out = sumState(wide);
    expect(ownKeysCount).toBe(1);
    expect(getCount).toBe(8);
    expect(out).toContain('…共 10000 个键');
    expect(out).not.toContain('k8');
    expectBounded(out);
  });

  it('Proxy 数组：length 与 3 个下标各取一次，抛错项标 [取值失败]', () => {
    let getCount = 0;
    const arr = new Proxy([1, 2, 3], {
      get(target, prop, receiver) {
        getCount++;
        if (prop === '2') throw new Error('boom');
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = sumState(arr);
    expect(getCount).toBe(4); // length + 三个下标
    expect(out).toContain('[1, 2, [取值失败]]');
    expectBounded(out);
  });

  it('Proxy 数组：length 取值失败退化为 [数组]', () => {
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

  it('节点预算：深宽对象在第 64 个节点截断，而非字符预算', () => {
    let node: unknown = 1;
    for (let i = 0; i < 9; i++) {
      node = Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`k${j}`, node]));
    }
    const out = sumState(node);
    expect(out.length).toBeLessThan(2000); // 字符预算远未耗尽 → 是节点预算触顶
    expect(out.endsWith('…')).toBe(true);
    expectBounded(out);
  });

  it('未知事件的对象 payload 退化为固定占位，不做反射枚举', () => {
    expect(formatLogLine('plugin:custom', { a: 1, b: 2 })).toBe('plugin:custom [对象]');
    expectBounded(formatLogLine('plugin:custom', { a: 1 }));
  });

  it('深度折叠：第 4 层以下的对象不再展开', () => {
    let value: unknown = { leaf: 1 };
    for (let i = 0; i < 20; i++) value = { next: value };
    const out = sumState(value);
    expect(out).toContain('[对象]');
    expect(out).not.toContain('leaf');
    expectBounded(out);
  });

  it('数组只显示前 8 项并标注总长', () => {
    const out = sumState(Array.from({ length: 100 }, (_, i) => `项${i}`));
    expect(out).toContain('["项0", "项1", "项2", "项3", "项4", "项5", "项6", "项7", …共 100 项]');
    expectBounded(out);
  });
});

describe('formatLogLine：base64 内容掩码（复审第 3 项）', () => {
  it('payload 字段按路径直接掩码，不读内容', () => {
    const out = formatLogLine('project:changed', {
      project: { name: 'demo', assets: [{ id: 'a1', payload: 'A'.repeat(2_800_000) }] },
    });
    expect(out).toContain('payload: [base64: 2800000 字符]');
    expect(out).not.toContain('A'.repeat(50));
    expectBounded(out);
  });

  it('payload 字段为非字符串时掩码为 [数据]', () => {
    const out = formatLogLine('project:changed', { project: { payload: { nested: 1 } } });
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

describe('formatLogLine：所有文本源统一转义控制字符（复审第 4 项）', () => {
  it('字符串值中的换行/回车/行分隔符被转义', () => {
    const out = sumState('行1\n行2\r行3\u2028行4\u2029行5');
    expect(out).toContain('行1\\n行2\\r行3\\u2028行4\\u2029行5');
    expectBounded(out);
  });

  it('Error.message 中的换行被转义', () => {
    const out = sumError(new Error('坏\n消息'));
    expect(out).toContain('[Error: 坏\\n消息]');
    expectBounded(out);
  });

  it('对象键名中的换行被转义', () => {
    const out = sumState({ 'bad\nkey': 1 });
    expect(out).toContain('bad\\nkey: 1');
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
