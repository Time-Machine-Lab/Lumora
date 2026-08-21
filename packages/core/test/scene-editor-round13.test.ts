// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
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
  return { ...sample, objects, scenes, activeSceneId: 'scene-0' };
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
});
