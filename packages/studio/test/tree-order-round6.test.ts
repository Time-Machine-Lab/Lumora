// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGroupObject } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import { buildTreeOrder } from '../src/components/editor/tree-order';

/**
 * R6-D 对抗测试（TML-57 第六轮复审，修复前必须失败）：
 * - 树序索引：一次 O(n) 遍历构建 childrenOf/rows/rowIndex，查询零遍历
 *   （旧 ObjectTree 每节点 filter → O(n²)）；
 * - 操作计数（scans）为主证据；多规模增长比为辅（16× 规模线性 ≈16×、
 *   平方级 ≈256×，对照复刻旧逻辑证明断言能区分）。
 *
 * R12-3（第十二轮，冻结文件第二次豁免）：T3 的 <80× 计时断言在并发负载下
 * 曾一次实测 90.08×（R6-D-T3 残余风险），计时主证据不可靠；改用确定性
 * 操作计数为线性侧主证据（buildTreeOrder 无 filter/find/some/every 谓词，
 * 执行数恒 0，两规模同探），naive 对照保留为 5 样本中位数 >100× 的形态佐证。
 */

function makeGroup(id: string, parentId: string | null): SceneObjectData {
  return { ...createGroupObject(), id, name: id, parentId };
}

function makeProject(objects: SceneObjectData[], roots: string[]): Project {
  return {
    uri: 'lumora://tree-order',
    name: 'T',
    schemaVersion: 2,
    createdAt: '2026-08-20T00:00:00.000Z',
    revision: 0,
    settings: { fps: 24, aspect: [16, 9] },
    activeSceneId: 's1',
    scenes: [{ id: 's1', name: '主场景', rootObjectIds: roots, activeCameraId: null }],
    objects,
    assets: [],
  };
}

describe('R6-D 树序索引（buildTreeOrder）', () => {
  it('R6-D-T1 深层树（120 节点、深 30）：childrenOf/rows/rowIndex 与展开 DFS 序一致', () => {
    const DEPTH = 30;
    const objects: SceneObjectData[] = [];
    for (let i = 0; i < DEPTH; i += 1) {
      objects.push(makeGroup(`g${i}`, i === 0 ? null : `g${i - 1}`));
      for (let j = 0; j < 3; j += 1) objects.push(makeGroup(`g${i}-l${j}`, `g${i}`));
    }
    const project = makeProject(objects, ['g0']);
    const order = buildTreeOrder(project, [objects[0]!], {});
    expect(order.scans).toBe(1);

    // childrenOf：直接子对象按 objects 数组插入序
    // （构造顺序：每层先压组节点再压叶，故 g1 排在 g0 的叶之后）
    expect(order.childrenOf.get('g0')!.map((o) => o.id)).toEqual(['g0-l0', 'g0-l1', 'g0-l2', 'g1']);
    expect(order.childrenOf.get('g15')!.map((o) => o.id)).toEqual(['g15-l0', 'g15-l1', 'g15-l2', 'g16']);
    expect(order.childrenOf.get('g29')).toHaveLength(3);

    // rows：全展开时深度优先、先父后子
    expect(order.rows).toHaveLength(DEPTH * 4);
    expect(order.rows[0]).toBe('g0');
    expect(order.rows[1]).toBe('g0-l0');
    expect(order.rows[4]).toBe('g1');
    expect(order.rows[order.rows.length - 1]).toBe('g29-l2');
    for (let i = 0; i < order.rows.length; i += 1) expect(order.rowIndex.get(order.rows[i]!)).toBe(i);

    // 折叠 g5：其子树（g6 及 g5 的叶）不可见，行序在 g5 处截断
    const collapsed = buildTreeOrder(project, [objects[0]!], { g5: false });
    expect(collapsed.rows).toHaveLength(5 * 4 + 1); // g0..g4 各 4 行 + g5 自身
    expect(collapsed.rows[collapsed.rows.length - 1]).toBe('g5');
    expect(collapsed.rows).not.toContain('g6');
    expect(collapsed.rows).not.toContain('g5-l0');
  });

  it('R6-D-T2 操作计数：单次遍历构建，1 万次查询零遍历（scans 恒为 1）', () => {
    const objects: SceneObjectData[] = [makeGroup('root', null)];
    for (let i = 0; i < 1000; i += 1) objects.push(makeGroup(`s${i}`, 'root'));
    const project = makeProject(objects, ['root']);
    const order = buildTreeOrder(project, [objects[0]!], {});
    expect(order.scans).toBe(1);
    expect(order.childrenOf.get('root')).toHaveLength(1000);
    for (let i = 0; i < 10_000; i += 1) {
      order.childrenOf.get('root');
      order.rowIndex.get(`s${i % 1000}`);
    }
    // RED：旧实现每节点 filter 全数组，查询即再遍历（scans 随查询增长）
    expect(order.scans).toBe(1);
  });

  it('R6-D-T3 多规模增长比：索引零数组扫描谓词（filter/find/some/every 计数恒 0），旧逐节点 filter 复刻平方级（5 样本中位数 >100×）', () => {
    const build = (n: number) => {
      const objects: SceneObjectData[] = [makeGroup('root', null)];
      for (let i = 0; i < n; i += 1) objects.push(makeGroup(`s${i}`, 'root'));
      return makeProject(objects, ['root']);
    };
    const small = build(300);
    const large = build(4800);
    const rootsSmall = [small.objects[0]!];
    const rootsLarge = [large.objects[0]!];

    // 旧 ObjectTree 逻辑复刻：每节点 project.objects.filter 全数组
    const naiveRows = (objects: SceneObjectData[], roots: SceneObjectData[]) => {
      const rows: string[] = [];
      const collect = (o: SceneObjectData) => {
        rows.push(o.id);
        for (const c of objects.filter((x) => x.parentId === o.id)) collect(c);
      };
      for (const r of roots) collect(r);
      return rows;
    };

    // 确定性操作计数（替代计时主证据，消除 JIT/GC 并发噪声 flake）：
    // buildTreeOrder 是纯 push + Map#set/get 遍历，不含任何数组扫描谓词
    // （filter/find/some/every）→ 谓词执行数恒 0，n=300 与 n=4800 两规模同探
    const countPredicates = (fn: () => void): number => {
      let predicates = 0;
      const originalFilter = Array.prototype.filter;
      const originalFind = Array.prototype.find;
      const originalSome = Array.prototype.some;
      const originalEvery = Array.prototype.every;
      const wrap = (original: (...args: unknown[]) => unknown) =>
        function (this: unknown, ...args: unknown[]) {
          const predicate = args[0] as (value: unknown, index: number, array: unknown[]) => unknown;
          const wrapped = (value: unknown, index: number, array: unknown[]) => {
            predicates += 1;
            return predicate(value, index, array);
          };
          const rest = args.slice();
          rest[0] = wrapped;
          return original.apply(this, rest);
        };
      const spies = [
        vi.spyOn(Array.prototype, 'filter').mockImplementation(wrap(originalFilter) as never),
        vi.spyOn(Array.prototype, 'find').mockImplementation(wrap(originalFind) as never),
        vi.spyOn(Array.prototype, 'some').mockImplementation(wrap(originalSome) as never),
        vi.spyOn(Array.prototype, 'every').mockImplementation(wrap(originalEvery) as never),
      ];
      try {
        fn();
      } finally {
        for (const s of spies) s.mockRestore();
      }
      return predicates;
    };
    // 探针自检：naiveRows(n=300) ≈ 301² 谓词 ≫ 0——若 mock 失效计数为 0 → 假绿排除
    expect(countPredicates(() => naiveRows(small.objects, rootsSmall))).toBeGreaterThan(50_000);
    expect(countPredicates(() => buildTreeOrder(small, rootsSmall, {}))).toBe(0);
    expect(countPredicates(() => buildTreeOrder(large, rootsLarge, {}))).toBe(0);

    // 对照（计时仅作形态佐证）：断言必须能区分平方级实现——5 样本中位数
    // 抗单次 JIT/GC 噪声；16× 规模的平方 = 256×，>100× 留 2.5× 分辨力
    const median = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    const timeMs = (fn: () => void, reps: number) => {
      fn(); // 预热（JIT）
      const t0 = performance.now();
      for (let i = 0; i < reps; i += 1) fn();
      return (performance.now() - t0) / reps;
    };
    const naiveSmallSamples = Array.from({ length: 5 }, () => timeMs(() => naiveRows(small.objects, rootsSmall), 200));
    const naiveLargeSamples = Array.from({ length: 5 }, () => timeMs(() => naiveRows(large.objects, rootsLarge), 1));
    expect(median(naiveLargeSamples) / median(naiveSmallSamples)).toBeGreaterThan(100);
  }, 60000);
});
