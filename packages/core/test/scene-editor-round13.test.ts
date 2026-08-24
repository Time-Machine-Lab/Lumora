// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor, filterSelectionIds } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project, SceneObjectData } from '../src/scene/types';

/**
 * R13-1（TML-57 第十三轮收敛，修复前必须失败）：
 * validateProject（scene-editor.ts）活动机位段对每个 activeCameraId !== null
 * 的场景调用 isReachableFrom——后者每次全量重建 childrenOf（O(N)）→
 * C 个活动机位场景 O(C·N)，C~N 时平方；stampAndFreeze 在每条提交路径
 * 必经（duplicateSelection→commit / openProject）。
 * 修复：根一致性（各场景子树不相交）下，单次构建「对象 → 归属根」索引
 * （O(N) 摊还路径压缩）+ 场景根集合，activeCameraId 校验收敛 O(1)；
 * 总复杂度 O(N)。
 * RED 格（现 HEAD）：T1/T2 的 Map#set 计数为平方级增长（≈C²），翻倍增长
 * 比 ≈4 超 2.2、绝对计数超 24C 上界；T3-T6 保持语义回归（round4/round6
 * 错误消息同款）。
 * 探针盲区确认（R13-2 设计条件）：R12-1-T6/T7 只计 Array.find/findObject，
 * validateProject 的平方来自 Map#set 重建 childrenOf——在 multiSceneCameraProject
 * 分支上 T6/T7 仍全绿（盲区），由本文件 T1/T2 补位。
 *
 * R13-2（第十三轮收敛，P3 test commit——collect-time 编译红）：
 * R12-1-T8（round11 文件）的 mutant 盲区：其 'ghost' 候选不在可达集，
 * 删除 existingIds.has 后 T8 仍绿。R13-2 提取纯函数
 * filterSelectionIds(project, activeSceneId, ids)（getReachableIds +
 * existingIds 集合 + 内联首次出现去重，R8-8 语义）并让 filterSelection
 * 一行委托；T7 直接把幽灵根放入 rootObjectIds（可达集成员但对象不存在）
 * ——删除 existingIds.has 后幽灵根漏过 → T7 红（P4 mutant self-check 守卫）。
 * T9 跨场景过滤、T10 去重保持顺序、T11 孤儿对象（父引用缺失）过滤。
 * RED 形态（实测，第十三轮复审复核一致）：vitest（esbuild）把命名导入
 * 降级为 CJS 属性访问——实际为运行期红（TypeError: filterSelectionIds is
 * not a function，T7/T9/T10/T11 各一），T1-T6 未暂停、全部保持绿；tsc 侧
 * 严格 TS2305「has no exported member」编译红成立。P4 导出后 10/10 绿 +
 * core full 恢复全绿。
 * 已知备注（记录不修，PM 定案）：T9 未用「函数参数 sceneId 与
 * project.activeSceneId 不同」的夹具，不能杀死忽略显式参数的未来 mutant；
 * 当前实现明确使用传入参数，非现存缺陷。
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

function cameraObject(id: string, parentId: string | null): SceneObjectData {
  return {
    id,
    type: 'camera',
    name: id,
    parentId,
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    camera: {
      projection: 'perspective',
      focalLength: 50,
      fov: 40,
      sensorWidth: 36,
      sensorHeight: 24,
      near: 0.1,
      far: 200,
      aspect: null,
    },
  } as SceneObjectData;
}

/** C 个场景，每个场景一个根 group + 其下活动相机；N = 2C（对齐复审方证据形态） */
function multiSceneCameraProject(sceneCount: number): Project {
  const sample = createSampleProject();
  const objects: SceneObjectData[] = [];
  const scenes: Project['scenes'] = [];
  for (let i = 0; i < sceneCount; i += 1) {
    objects.push(groupObject(`root-${i}`, null));
    objects.push(cameraObject(`camera-${i}`, `root-${i}`));
    scenes.push({
      id: `scene-${i}`,
      name: `场景${i}`,
      rootObjectIds: [`root-${i}`],
      activeCameraId: `camera-${i}`,
    });
  }
  return { ...sample, objects, scenes, activeSceneId: 'scene-0', tracks: [], shots: [] };
}

/** 逆序深链：叶在前、根在后（路径压缩最坏情形——objects[0] 回溯整条链
 *  一次性填充 resolvedRoot，其余节点全部命中缓存 O(1)，摊还 O(N)）；
 *  相机自身为场景根（rootOf('camera-root') = 'camera-root' ∈ sceneRoots） */
function deepChainProject(nodeCount: number): Project {
  const sample = createSampleProject();
  const objects: SceneObjectData[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    objects.push(groupObject(`node-${i}`, i === nodeCount - 1 ? null : `node-${i + 1}`));
  }
  objects.push(cameraObject('camera-root', null));
  const chainRoot = `node-${nodeCount - 1}`;
  return {
    ...sample,
    objects,
    scenes: [{
      id: 'scene-1',
      name: '主场景',
      rootObjectIds: [chainRoot, 'camera-root'],
      activeCameraId: 'camera-root',
    }],
    activeSceneId: 'scene-1',
    tracks: [],
    shots: [],
  };
}

describe('R13-1 validateProject 多场景机位校验 O(C·N)→O(N)', () => {
  it('R13-1-T1 多场景提交路径 Map#set 计数：翻倍增长比 ≤ 2.2（C=10/20/40/80，RED）', () => {
    // 确定性操作计数（替代计时）：spy 全程 Map#set——validateProject 的平方
    // 特征正是 childrenOf 每场景重建的 Map#set（R12-1-T6/T7 的 find 探针盲区）。
    // 只复制 root-0 单根：复制路径 Map#set 恒定，增长全部来自校验路径。
    // 探针自检：counts[0] > 0（防 mock 失效假绿）。
    const counts: number[] = [];
    for (const c of [10, 20, 40, 80]) {
      const project = multiSceneCameraProject(c); // fixture 先构建，spy 后安装
      const editor = new SceneEditor();
      const spy = vi.spyOn(Map.prototype, 'set');
      editor.openProject(project);
      editor.setSelection(['root-0']);
      const result = editor.duplicateSelection();
      const sets = spy.mock.calls.length;
      spy.mockRestore();

      expect(result.ok).toBe(true);
      counts.push(sets);
    }
    // RED：每场景 isReachableFrom 重建 childrenOf → ≈8C²+22C，翻倍比 ≈4；
    // 修复后单次归属索引 → ≈32C，翻倍比 ≈2
    expect(counts[0]!).toBeGreaterThan(0);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]! / counts[i - 1]!).toBeLessThanOrEqual(2.2);
    }
  }, 60000);

  it('R13-1-T2 openProject 路径 Map#set 绝对上界 < 24C（C=10/20/40/80，RED）', () => {
    // openProject 单路径（不叠加复制路径 set）：validateProject 主体。
    // RED：≈4C²+8C ≫ 24C；修复后 ≈13C（byId 2N + 三色 2N + 根一致性 2N +
    // rootOf/resolved 2N + sceneRoots C），24C 留 ~1.8× 裕度
    for (const c of [10, 20, 40, 80]) {
      const project = multiSceneCameraProject(c);
      const editor = new SceneEditor();
      const spy = vi.spyOn(Map.prototype, 'set');
      editor.openProject(project);
      const sets = spy.mock.calls.length;
      spy.mockRestore();

      expect(sets).toBeLessThan(24 * c);
    }
  }, 60000);

  it('R13-1-T3 合法多场景活动机位 openProject 成功：C 场景各相机可检索', () => {
    const project = multiSceneCameraProject(3);
    const editor = new SceneEditor();
    expect(() => editor.openProject(project)).not.toThrow();
    const p = editor.getProject()!;
    for (let i = 0; i < 3; i += 1) {
      const cam = p.objects.find((o) => o.id === `camera-${i}`);
      expect(cam).toBeDefined();
      expect(cam!.type).toBe('camera');
    }
  });

  it('R13-1-T4 跨场景机位拒绝：场景 B 的机位指向场景 A 的相机', () => {
    const project = multiSceneCameraProject(2);
    project.scenes[1]!.activeCameraId = 'camera-0'; // scene-1 的机位指向 scene-0 相机
    const editor = new SceneEditor();
    expect(() => editor.openProject(project)).toThrow(/场景「场景1」的机位不属于该场景/);
    expect(editor.getProject()).toBeNull();
  });

  it('R13-1-T5 机位非相机拒绝：activeCameraId 指向 group 对象', () => {
    const project = multiSceneCameraProject(1);
    project.scenes[0]!.activeCameraId = 'root-0'; // group 非相机
    const editor = new SceneEditor();
    expect(() => editor.openProject(project)).toThrow(/场景「场景0」的机位不存在或不是相机/);
    expect(editor.getProject()).toBeNull();
  });

  it('R13-1-T6 非活动场景机位可达接受 / 不可达拒绝（round6 同语义）', () => {
    const okProject = multiSceneCameraProject(2);
    const editor = new SceneEditor();
    expect(() => editor.openProject(okProject)).not.toThrow(); // scene-1 机位本场景可达

    const badProject = multiSceneCameraProject(2);
    badProject.scenes[1]!.activeCameraId = 'camera-0'; // 存在且是相机但跨场景
    const editor2 = new SceneEditor();
    expect(() => editor2.openProject(badProject)).toThrow(/机位不属于该场景/);
    expect(editor2.getProject()).toBeNull();
  });

  it('R13-1-T7 深链线性探针：逆序深链 200/400/800 节点 Map#set 增长比 ≤2.1（路径压缩摊还 O(N) 固化）', () => {
    // 第十三轮复审独立实测：1205/2405/4805，增长比 1.996/1.998（≈6N+5 线性）。
    // 固化动机：未固化的复杂度结论会回归（R11-1 探针盲区、R13-1 平方分支）。
    // 若 resolvedRoot 缓存退化（每对象回溯全链）→ ≈N²/2 set → 增长比 ≈4 → 红。
    // spy 全程覆盖 openProject 的 validateProject 单路径。
    const counts: number[] = [];
    for (const n of [200, 400, 800]) {
      const project = deepChainProject(n); // fixture 先构建，spy 后安装
      const editor = new SceneEditor();
      const spy = vi.spyOn(Map.prototype, 'set');
      editor.openProject(project);
      counts.push(spy.mock.calls.length);
      spy.mockRestore();

      expect(editor.getProject()).not.toBeNull(); // 合法深链（含相机自身为根）正常打开
    }
    expect(counts[0]!).toBeGreaterThan(0); // 探针自检：防 mock 失效假绿
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]! / counts[i - 1]!).toBeLessThanOrEqual(2.1);
    }
  }, 60000);
});

describe('R13-2 filterSelectionIds 纯函数（幽灵根/跨场景/去重/孤儿）', () => {
  it('R13-2-T7 幽灵根过滤主守卫：rootObjectIds 含不存在的根，候选须被存在性判定剔除', () => {
    // getReachableIds 把幽灵根原样加入可达集（scene-graph.ts：栈内 rootObjectIds
    // 元素无条件 add）→ 「reachable 成员 ⇒ 真实对象」不成立，必须靠 existingIds
    // 挡下。R12-1-T8 的 'ghost' 候选不在可达集（mutant 盲区）；本测试幽灵根
    // 在可达集内，删除 existingIds.has 后幽灵根漏过 → 本测试红（P4 self-check）
    const project: Project = {
      ...createSampleProject(),
      objects: [groupObject('root-a', null)],
      scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: ['root-a', 'ghost-root'], activeCameraId: null }],
      activeSceneId: 'scene-1',
    };
    expect(filterSelectionIds(project, 'scene-1', ['root-a', 'ghost-root'])).toEqual(['root-a']);
  });

  it('R13-2-T9 跨场景过滤：候选属于其他场景可达集，不在活动场景可达集 → 剔除', () => {
    const project: Project = {
      ...createSampleProject(),
      objects: [groupObject('a-root', null), groupObject('b-root', null)],
      scenes: [
        { id: 'scene-a', name: '场景A', rootObjectIds: ['a-root'], activeCameraId: null },
        { id: 'scene-b', name: '场景B', rootObjectIds: ['b-root'], activeCameraId: null },
      ],
      activeSceneId: 'scene-a',
    };
    expect(filterSelectionIds(project, 'scene-a', ['a-root', 'b-root'])).toEqual(['a-root']);
  });

  it('R13-2-T10 首次出现去重：重复候选只保留首个（R8-8 顺序语义）', () => {
    const project: Project = {
      ...createSampleProject(),
      objects: [groupObject('root-a', null)],
      scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: ['root-a'], activeCameraId: null }],
      activeSceneId: 'scene-1',
    };
    expect(filterSelectionIds(project, 'scene-1', ['root-a', 'root-a'])).toEqual(['root-a']);
  });

  it('R13-2-T11 孤儿对象过滤：父引用缺失的对象不在任何场景可达集 → 剔除', () => {
    const project: Project = {
      ...createSampleProject(),
      objects: [groupObject('root-a', null), groupObject('orphan', 'missing-parent')],
      scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: ['root-a'], activeCameraId: null }],
      activeSceneId: 'scene-1',
    };
    expect(filterSelectionIds(project, 'scene-1', ['root-a', 'orphan'])).toEqual(['root-a']);
  });
});
