// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { ViewMode } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { AssetData, Project, SceneObjectData } from '../src/scene/types';

/**
 * R10-M1 统一事务版本（TML-57 第十轮，修复前 RED 探针）：
 * project/selection/view 三类状态写共用可复验 mutationVersion；所有公开写入口
 * 统一「捕获基线 → own 输入（getter 副作用在此发生）→ guard 复验 → 快路判定
 * （任何返回必已复验）→ 写 → 版本递增 → emit」。
 * 矩阵逐入口 × 快路：正常写 / 同值或空命中 no-op 快路 / dispose 后 / 输入 getter
 * 副作用（Proxy 输入在 own/读取期间 dispose）/ 事务内嵌套写取消外层（内层保留）。
 * RED 格（现 HEAD 行为）：T4/T5/T8/T10/T13/T20/T21 断言新行为，旧实现违反。
 */

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

function makeCameraProject(): Project {
  const sample = createSampleProject();
  const camera: SceneObjectData = {
    id: 'cam-1',
    type: 'camera',
    name: '机位',
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    camera: {
      projection: 'perspective',
      focalLength: 50,
      fov: 40,
      sensorWidth: 36,
      sensorHeight: 24,
      near: 0.1,
      far: 1000,
      aspect: null,
    },
  };
  return {
    ...sample,
    objects: [...sample.objects, camera],
    scenes: sample.scenes.map((s) => ({ ...s, rootObjectIds: [...s.rootObjectIds, 'cam-1'] })),
  };
}

function asset(id: string, hash: string): AssetData {
  return {
    id,
    kind: 'gltf',
    name: id,
    mime: 'model/gltf+json',
    hash,
    size: 1,
    source: 'file',
    storageRef: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 每次属性读取触发 onRead：模拟输入对象 getter 副作用（R9-M1 模式） */
function sideEffectProxy<T extends object>(target: T, onRead: () => void): T {
  return new Proxy(target, {
    get(target, prop) {
      onRead();
      return Reflect.get(target, prop);
    },
  });
}

describe('R10-M1 统一事务版本：逐入口 × 快路行为矩阵', () => {
  describe('setSelection', () => {
    it('T1 正常写：选中并 emit', () => {
      const editor = makeEditor();
      const listener = vi.fn();
      editor.events.on('selection:changed', listener);
      editor.setSelection(['sample-cone']);
      expect(editor.getSelection()).toEqual(['sample-cone']);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]![0]!.ids).toEqual(['sample-cone']);
    });

    it('T2 同值 no-op：不写不 emit', () => {
      const editor = makeEditor();
      editor.setSelection(['sample-cube']);
      const listener = vi.fn();
      editor.events.on('selection:changed', listener);
      editor.setSelection(['sample-cube']);
      expect(listener).not.toHaveBeenCalled();
      expect(editor.getSelection()).toEqual(['sample-cube']);
    });

    it('T3 dispose 后：静默 no-op，selection 不被覆盖', () => {
      const editor = makeEditor();
      editor.dispose();
      expect(() => editor.setSelection(['sample-cone'])).not.toThrow();
      expect(editor.getSelection()).toEqual([]);
    });

    it('T4 输入 getter 副作用（Proxy ids 在读取期间 dispose）：不写、不 emit（RED）', () => {
      const editor = makeEditor();
      editor.setSelection(['sample-cube']);
      const listener = vi.fn();
      editor.events.on('selection:changed', listener);
      const ids = sideEffectProxy(['sample-cone'], () => editor.dispose());
      editor.setSelection(ids);
      // RED：现 HEAD 无 own/guard，dispose 后仍直写 selection 并 emit
      expect(editor.getSelection()).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
    });

    it('T5 updater 内嵌套 setSelection：外层事务取消、内层选择保留（RED）', () => {
      const editor = makeEditor();
      const before = editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name;
      const result = editor.updateObjectProps(
        'sample-cube',
        (o) => {
          editor.setSelection(['sample-cone']);
          return { ...o, name: '改名' };
        },
        '改名',
      );
      // RED：现 HEAD 选择写不参与事务版本 → 外层提交成功（覆盖内层选择）
      expect(result.ok).toBe(false);
      expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe(before);
      expect(editor.getSelection()).toEqual(['sample-cone']);
    });
  });

  describe('setVisible / setLocked', () => {
    it('T6 setVisible 正常写并提交', () => {
      const editor = makeEditor();
      const result = editor.setVisible(['sample-cube'], false);
      expect(result.ok).toBe(true);
      expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.visible).toBe(false);
    });

    it('T7 setVisible 空命中快路：ok:true 且无提交', () => {
      const editor = makeEditor();
      const before = editor.getProject();
      const result = editor.setVisible(['missing-id'], true);
      expect(result.ok).toBe(true);
      expect(editor.getProject()).toBe(before);
    });

    it('T8 setVisible 输入 getter 副作用（Proxy ids 读取期间 dispose）：failure 而非 ok:true（RED）', () => {
      const editor = makeEditor();
      const ids = sideEffectProxy(['missing-id'], () => editor.dispose());
      // RED：现 HEAD 空命中快路在 guard 前返回 ok:true
      const result = editor.setVisible(ids, true);
      expect(result.ok).toBe(false);
    });

    it('T9 dispose 后：failure', () => {
      const editor = makeEditor();
      editor.dispose();
      expect(editor.setVisible(['sample-cube'], true).ok).toBe(false);
      expect(editor.setLocked(['sample-cube'], true).ok).toBe(false);
    });

    it('T10 setLocked 同构：正常写 + 副作用 failure（RED）', () => {
      const editor = makeEditor();
      const result = editor.setLocked(['sample-cube'], true);
      expect(result.ok).toBe(true);
      expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.locked).toBe(true);
      const editor2 = makeEditor();
      const ids = sideEffectProxy(['missing-id'], () => editor2.dispose());
      expect(editor2.setLocked(ids, true).ok).toBe(false);
    });
  });

  describe('registerAsset', () => {
    it('T11 新资源提交', () => {
      const editor = makeEditor();
      const result = editor.registerAsset(asset('a-new', 'hash-new'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value!.deduped).toBe(false);
      expect(editor.getProject()!.assets.map((a) => a.id)).toContain('a-new');
    });

    it('T12 dedupe 快路：ok:true,deduped:true 且引用已有资源', () => {
      const editor = makeEditor();
      editor.registerAsset(asset('a1', 'hash-same'));
      const result = editor.registerAsset(asset('a2', 'hash-same'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value!.deduped).toBe(true);
      expect(result.value!.asset.id).toBe('a1');
    });

    it('T13 输入 getter 副作用（hash getter dispose）：failure 而非 dedupe ok:true（RED）', () => {
      const editor = makeEditor();
      editor.registerAsset(asset('a1', 'hash-same'));
      const proxyAsset = sideEffectProxy(asset('a2', 'hash-same'), () => editor.dispose());
      // RED：现 HEAD 在 own/guard 前读取 asset.hash → dedupe 快路在已释放编辑器上返回 ok:true
      const result = editor.registerAsset(proxyAsset);
      expect(result.ok).toBe(false);
    });

    it('T14 dispose 后：failure', () => {
      const editor = makeEditor();
      editor.dispose();
      expect(editor.registerAsset(asset('a-new', 'h')).ok).toBe(false);
    });
  });

  describe('view setters（setTransformMode/Space/setViewMode/setGuide）', () => {
    it('T15 setTransformMode 正常写并 emit / 同值 no-op', () => {
      const editor = makeEditor();
      const listener = vi.fn();
      editor.events.on('view:changed', listener);
      editor.setTransformMode('scale');
      expect(editor.getView().transformMode).toBe('scale');
      expect(listener).toHaveBeenCalledTimes(1);
      editor.setTransformMode('scale');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('T16 setTransformSpace 正常写并 emit / 同值 no-op', () => {
      const editor = makeEditor();
      const listener = vi.fn();
      editor.events.on('view:changed', listener);
      editor.setTransformSpace('world');
      expect(editor.getView().transformSpace).toBe('world');
      expect(listener).toHaveBeenCalledTimes(1);
      editor.setTransformSpace('world');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('T17 setViewMode 正常写（机位）/ 同值 no-op / 非法机位回退 director', () => {
      const editor = new SceneEditor();
      editor.openProject(makeCameraProject());
      const listener = vi.fn();
      editor.events.on('view:changed', listener);
      editor.setViewMode({ cameraObjectId: 'cam-1' });
      expect(editor.getView().viewMode).toEqual({ cameraObjectId: 'cam-1' });
      expect(listener).toHaveBeenCalledTimes(1);
      editor.setViewMode({ cameraObjectId: 'cam-1' });
      expect(listener).toHaveBeenCalledTimes(1);
      editor.setViewMode({ cameraObjectId: 'no-such-camera' });
      expect(editor.getView().viewMode).toBe('director');
    });

    it('T18 setGuide 正常写并 emit', () => {
      const editor = makeEditor();
      const listener = vi.fn();
      editor.events.on('view:changed', listener);
      editor.setGuide('thirds', true);
      expect(editor.getView().guides.thirds).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('T19 dispose 后：静默 no-op，view 不被覆盖', () => {
      const editor = makeEditor();
      editor.setTransformMode('scale');
      editor.dispose();
      editor.setTransformMode('rotate');
      editor.setTransformSpace('world');
      editor.setViewMode({ cameraObjectId: 'sample-cube' } as ViewMode);
      editor.setGuide('safeFrame', false);
      // dispose 重置视图为 fresh 默认（safeFrame 默认为 true），
      // dispose 后任何 setter 都不得改变它
      expect(editor.getView().transformMode).toBe('translate');
      expect(editor.getView().transformSpace).toBe('local');
      expect(editor.getView().viewMode).toBe('director');
      expect(editor.getView().guides.safeFrame).toBe(true);
    });

    it('T20 setViewMode 输入 getter 副作用（Proxy mode 读取期间嵌套 setViewMode）：外层写取消、内层保留（RED）', () => {
      const editor = new SceneEditor();
      editor.openProject(makeCameraProject());
      editor.setViewMode({ cameraObjectId: 'cam-1' });
      const listener = vi.fn();
      editor.events.on('view:changed', listener);
      const mode = sideEffectProxy({ cameraObjectId: 'cam-1' }, () => {
        // 内层：非法机位 → 回退 director 并写入/emit（改变视图状态）
        editor.setViewMode({ cameraObjectId: 'no-such-camera' });
      });
      editor.setViewMode(mode as unknown as ViewMode);
      // RED：现 HEAD 无 own/guard，内层写入后外层仍用旧 mode 覆盖 → viewMode 回到 cam-1 且多 emit 一次
      expect(editor.getView().viewMode).toBe('director');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('T21 updater 内嵌套 setTransformMode：外层事务取消、内层视图写保留（RED）', () => {
      const editor = makeEditor();
      const before = editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name;
      const result = editor.updateObjectProps(
        'sample-cube',
        (o) => {
          editor.setTransformMode('scale');
          return { ...o, name: '改名' };
        },
        '改名',
      );
      // RED：现 HEAD 视图写不参与事务版本 → 外层提交成功
      expect(result.ok).toBe(false);
      expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe(before);
      expect(editor.getView().transformMode).toBe('scale');
    });
  });
});
