// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project, SceneObjectData } from '../src/scene/types';
import * as sceneGraph from '../src/scene/scene-graph';

/**
 * R11-1（TML-57 第十一轮 #7 收敛）对抗测试，修复前必须失败：
 * duplicateSelection 的 roots 筛选（scene-editor.ts）对每个选中 id 调
 * isInActiveScene（getReachableIds 每次重建 childrenOf + DFS，O(n)）+
 * selection.some 内 isInSubtree（每次重建 byId Map，O(n)）→ 平级根全选
 * O(n³)。Map#set 确定性计数实测（审查员）：n=40/80/160 →
 * 62,761 / 506,321 / 4,071,841（翻倍 ≈8×）。
 * 修复：共享 byId/childrenOf/reachable 单次构建 + 单次 DFS 传播
 * 「已有选中祖先」定根 + root→run Map 替代 roots.indexOf。
 * RED 格（现 HEAD 行为）：T1 计数 ≈ n³ ≫ 24n；其余格保持语义回归。
 *
 * R12-1（第十二轮复审缺口收敛）：R11-1-T1 的 Map#set 探针只统计索引构建，
 * 漏掉 filterSelection 对每个候选的 findObject（Array.find，O(N)）数组扫描
 * ——一次复制提交过滤两次（commit 与 swapState）→ 全选平级根 O(k·N)。
 * 新增 T6/T7/T8：完整路径 find 谓词计数（< n 线性上界 + 增长形态）、
 * findObject 调用数归零守卫、幽灵根过滤回归。
 */

function groupObject(id: string, parentId: string | null, name = id): SceneObjectData {
  return {
    id,
    type: 'group',
    name,
    parentId,
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } as SceneObjectData;
}

/** rootCount 个平级根，每个根下挂一个子节点（复制时子树工作量恒为 2/根） */
function multiRootProject(rootCount: number): Project {
  const sample = createSampleProject();
  const objects: SceneObjectData[] = [];
  const rootObjectIds: string[] = [];
  for (let i = 0; i < rootCount; i++) {
    const rootId = `root-${i}`;
    rootObjectIds.push(rootId);
    objects.push(groupObject(rootId, null));
    objects.push(groupObject(`${rootId}-child`, rootId));
  }
  return {
    ...sample,
    objects,
    scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds, activeCameraId: null }],
    tracks: [],
  };
}

describe('R11-1 #7 复制根筛选收敛：多根全选 O(n³)→O(n)', () => {
  it('R11-1-T1 多根增长探针：Map#set 确定性计数 < 24n 线性上界（n=40/80/160，RED）', () => {
    for (const n of [40, 80, 160]) {
      const editor = new SceneEditor();
      editor.openProject(multiRootProject(n));
      editor.setSelection(Array.from({ length: n }, (_, i) => `root-${i}`));
      // 确定性操作计数（替代计时/谓词计数）：spy 期间所有 Map#set 均为
      // 索引构建与复制路径工作量的直接度量
      const spy = vi.spyOn(Map.prototype, 'set');
      const result = editor.duplicateSelection();
      const sets = spy.mock.calls.length;
      spy.mockRestore();

      expect(result.ok).toBe(true);
      // RED：现 HEAD roots 筛选每对 (id, other) 重建 byId Map →
      // Map#set ≈ n³（n=160 ≈ 409 万）；修复后共享索引一次构建 ≈ 7n
      //（childrenOf 2n + byId 2n + reachable 2n + runsByRoot n），24n 上界留 3× 裕度
      expect(sets).toBeLessThan(24 * n);
    }
  }, 60000);

  it('R11-1-T2 多根复制正确性：副本紧跟原对象、子树完整、原对象不动、根列表追加', () => {
    const editor = new SceneEditor();
    editor.openProject(multiRootProject(3));
    editor.setSelection(['root-0', 'root-1', 'root-2']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const project = editor.getProject()!;
    const scene = project.scenes.find((s) => s.id === project.activeSceneId)!;
    // 3 个副本根，顺序与选择一致
    expect(result.value!.ids).toHaveLength(3);
    expect(scene.rootObjectIds).toEqual(['root-0', 'root-1', 'root-2', ...result.value!.ids]);
    const copyIds = result.value!.ids;
    const objects = project.objects;
    copyIds.forEach((copyId, i) => {
      const originalIndex = objects.findIndex((o) => o.id === `root-${i}`);
      const copyIndex = objects.findIndex((o) => o.id === copyId);
      // 副本紧随原对象之后插入
      expect(copyIndex).toBe(originalIndex + 1);
      // 副本根无父，子副本挂其下
      const copy = objects[copyIndex]!;
      expect(copy.parentId).toBeNull();
      const childCopy = objects.filter((o) => o.parentId === copyId);
      expect(childCopy).toHaveLength(1);
      expect(childCopy[0]!.name).toBe(`root-${i}-child 副本`);
    });
    // 原对象数量不变（3 根 + 3 子）
    expect(objects).toHaveLength(12);
    expect(objects.filter((o) => o.id === 'root-0')).toHaveLength(1);
  });

  it('R11-1-T3 混合层级：选中父+子只复制顶层；平级多根全部复制', () => {
    const editor = new SceneEditor();
    editor.openProject(multiRootProject(2));
    // 选中父 root-0、其子 root-0-child 与平级 root-1 → 只复制两个顶层根
    editor.setSelection(['root-0', 'root-0-child', 'root-1']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const ids = result.value!.ids;
    // 只有顶层两个根被复制；子对象副本不进返回列表（后代不重复复制）
    expect(ids).toHaveLength(2);
    const copyNames = ids.map((id) => editor.getProject()!.objects.find((o) => o.id === id)!.name);
    expect(copyNames).not.toContain('root-0-child 副本');
  });

  it('R11-1-T4 过滤语义保持：不存在 id 与跨场景对象不复制（R8-8 回归）', () => {
    const editor = new SceneEditor();
    const sample = createSampleProject();
    const project: Project = {
      ...sample,
      objects: [groupObject('root-a', null), groupObject('other-x', null)],
      scenes: [
        { id: 'scene-1', name: '主场景', rootObjectIds: ['root-a'], activeCameraId: null },
        { id: 'scene-2', name: '次场景', rootObjectIds: ['other-x'], activeCameraId: null },
      ],
      activeSceneId: 'scene-1',
      tracks: [],
    };
    editor.openProject(project);
    editor.setSelection(['root-a', 'other-x', 'ghost']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value!.ids).toHaveLength(1);
    expect(editor.getProject()!.objects.filter((o) => o.id === 'other-x')).toHaveLength(1);
  });

  it('R11-1-T5 空选择与仅不可复制项：返回空列表（不变式保持）', () => {
    const editor = new SceneEditor();
    editor.openProject(multiRootProject(2));
    editor.setSelection(['ghost-only']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value!.ids).toEqual([]);
  });

  it('R12-1-T6 完整复制路径 find 谓词计数：< n 线性上界 + 翻倍增长比 ≤ 2.2（n=40/80/160/320，RED）', () => {
    // 确定性操作计数（替代计时）：包装 Array.prototype.find 的谓词执行，
    // 度量 duplicateSelection 全程（含 commit 与 swapState 两次过滤）的全部
    // 数组扫描——补 R11-1-T1 只统计 Map#set 而漏掉的 findObject O(N) 扫描。
    // RED：现 HEAD 两次过滤各 k 候选 × O(N) 数组 → ≈ 4n²（n=320 ≈ 40.9 万）；
    // 修复后仅 scenes.find 常数次 → < n 留 40× 裕度。
    const originalFind = Array.prototype.find;
    const counts: number[] = [];
    for (const n of [40, 80, 160, 320]) {
      const editor = new SceneEditor();
      editor.openProject(multiRootProject(n));
      editor.setSelection(Array.from({ length: n }, (_, i) => `root-${i}`));
      let predicates = 0;
      const spy = vi
        .spyOn(Array.prototype, 'find')
        .mockImplementation((function (
          this: unknown[],
          predicate: (value: unknown, index: number, array: unknown[]) => unknown,
          thisArg?: unknown,
        ) {
          const wrapped = (value: unknown, index: number, array: unknown[]) => {
            predicates += 1;
            return predicate(value, index, array);
          };
          return originalFind.call(this, wrapped, thisArg);
        }) as never);
      const result = editor.duplicateSelection();
      spy.mockRestore();

      expect(result.ok).toBe(true);
      expect(predicates).toBeLessThan(n);
      counts.push(predicates);
    }
    // 探针自检：计数非零（包装确实拦截并执行了谓词，防 mock 失效假绿）
    expect(counts[0]!).toBeGreaterThan(0);
    // 增长形态：n 翻倍增长比 ≤ 2.2（线性特征；平方级 ≈4×）
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]! / counts[i - 1]!).toBeLessThanOrEqual(2.2);
    }
  }, 60000);

  it('R12-1-T7 findObject 调用数归零守卫：完整复制路径无对象数组扫描（RED）', () => {
    const editor = new SceneEditor();
    editor.openProject(multiRootProject(40));
    editor.setSelection(Array.from({ length: 40 }, (_, i) => `root-${i}`));
    const spy = vi.spyOn(sceneGraph, 'findObject');
    // 探针自检：spy 确实拦截模块导出（防 mock 失效假绿）
    sceneGraph.findObject(editor.getProject()!, 'root-0');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();

    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    // RED：现 HEAD filterSelection 每候选一次 findObject（两次过滤 ≥ 2n）；
    // 修复后存在性判定为预建集合，全路径零调用
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('R12-1-T8 幽灵根不变量核验：getReachableIds 可达集可含不存在 id → 存在性检查不可省', () => {
    // 不经 openProject（validateProject 会拒绝幽灵根，编辑器合法状态无幽灵
    // 根）——直接对公共导出 getReachableIds 断言：rootObjectIds 中的不存在
    // id 被原样加入可达集，故 filterSelection 不能依赖「reachable 成员 ⇒
    // 真实对象」不变量删除存在性检查，必须保留 O(1) existingIds 判定
    const project: Project = {
      ...createSampleProject(),
      objects: [groupObject('root-a', null)],
      scenes: [
        { id: 'scene-1', name: '主场景', rootObjectIds: ['root-a', 'ghost-root'], activeCameraId: null },
      ],
      activeSceneId: 'scene-1',
      tracks: [],
    };
    const reachable = sceneGraph.getReachableIds(project, 'scene-1');
    expect(reachable.has('root-a')).toBe(true);
    expect(reachable.has('ghost-root')).toBe(true); // 幽灵根确实进入可达集
    // 编辑器侧复验：selection 含不存在 id 仍被剔除（T4/T5 语义）
    const editor = new SceneEditor();
    editor.openProject({
      ...project,
      scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: ['root-a'], activeCameraId: null }],
      tracks: [],
    });
    editor.setSelection(['root-a', 'ghost']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value!.ids).toHaveLength(1);
  });
});
