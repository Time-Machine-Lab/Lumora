// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGroupObject } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import { buildTreeOrder } from '../src/components/editor/tree-order';

/**
 * R6-D 对抗测试（TML-57 第六轮复审，修复前必须失败）：
 * - 树序索引：一次 O(n) 遍历构建 childrenOf/rows/rowIndex，查询零遍历
 *   （旧 ObjectTree 每节点 filter → O(n²)）；
 * - 操作计数（scans）为主证据；多规模增长比为辅（16× 规模线性 ≈16×、
 *   平方级 ≈256×，对照复刻旧逻辑证明断言能区分）。
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

  it('R6-D-T3 多规模增长比：索引 16× 规模近似线性（<60× 耗时），旧逐节点 filter 复刻为平方级（>100×）', () => {
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

    // 每规模测量时长 ≥ ~10ms（重复次数随规模缩放），噪声占比可控
    const timeMs = (fn: () => void, reps: number) => {
      fn(); // 预热（JIT）
      const t0 = performance.now();
      for (let i = 0; i < reps; i += 1) fn();
      return (performance.now() - t0) / reps;
    };
    const indexSmall = timeMs(() => buildTreeOrder(small, rootsSmall, {}), 8_000);
    const indexLarge = timeMs(() => buildTreeOrder(large, rootsLarge, {}), 1_000);
    expect(indexLarge / indexSmall).toBeLessThan(60); // 线性 ≈16×，平方级 ≈256×

    // 对照：断言必须能区分平方级实现（旧逻辑复刻 >100×，16× 规模的平方 = 256×）
    const naiveSmall = timeMs(() => naiveRows(small.objects, rootsSmall), 200);
    const naiveLarge = timeMs(() => naiveRows(large.objects, rootsLarge), 1);
    expect(naiveLarge / naiveSmall).toBeGreaterThan(100);
  });
});
