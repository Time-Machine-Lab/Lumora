// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { AssetData, SceneObjectData, TransformData } from '../src/scene/types';

/**
 * R9-M1 对抗测试（TML-57 第九轮 M1 事务边界，修复前必须失败）：
 * 「捕获 project/session/epoch → 读取/克隆外部值 → 复验 → 提交前再复验」必须封装为
 * 所有 ingress 共用的事务边界，而非逐入口补点。现 HEAD 缺口（审查员实测 + 代码复核）：
 * - addObject：own()（structuredClone 触发输入对象枚举 getter）后无基线复验，
 *   dispose/嵌套 openProject 后仍用捕获前的旧 project 提交 → 项目复活/内层被覆盖；
 * - setTransform/commitTransform：isValidTransform 与 ownTransform（数组展开）读取
 *   外部 transform 值（元素 getter 窗口），同样无复验。
 * 修复：beginIngress → 外部窗口 → guardReentry → commit(baseline)，commitEntry 自身
 * 首句拒绝 disposed/过期基线（背止）；公开写入口全集登记表（新增入口漏登记即红）。
 * T1-T4 为红探针（现 HEAD 失败）；T5-T7 为既有防护覆盖与入口登记（现 HEAD 即绿）。
 */

function primitiveObject(id: string, name = id): SceneObjectData {
  return {
    id,
    type: 'primitive',
    name,
    parentId: null,
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    geometry: { kind: 'box' },
  } as SceneObjectData;
}

function assetData(id: string): AssetData {
  return {
    id,
    kind: 'gltf',
    name: `${id}.glb`,
    mime: 'model/gltf-binary',
    hash: `hash-${id}`,
    size: 3,
    source: 'file',
    storageRef: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 公开 API 全集：新增公开方法必须显式纳入本表（防绕过：新入口漏登记即红） */
const PUBLIC_API_LIST = [
  'addObject',
  'addScene',
  'beginTransform',
  'clearSelection',
  'commitTransform',
  'deleteSelection',
  'dispose',
  'duplicateSelection',
  'getHistoryState',
  'getProject',
  'getSelectedObjects',
  'getSelection',
  'getSessionToken',
  'getView',
  'importModel',
  'isCurrentSession',
  'openProject',
  'redo',
  'registerAsset',
  'reset',
  'setActiveCamera',
  'setActiveScene',
  'setGuide',
  'setLocked',
  'setParent',
  'setSelection',
  'setTransform',
  'setTransformMode',
  'setTransformSpace',
  'setVisible',
  'setViewMode',
  'undo',
  'updateObjectProps',
];

describe('R9-M1 事务边界：外部 getter 副作用入口探针', () => {
  it('R9-M1-T1 addObject 输入对象 getter 内 dispose：提交取消、项目不复活', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const poisoned = primitiveObject('poison-1');
    Object.defineProperty(poisoned, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        editor.dispose();
        return '毒对象';
      },
    });
    const result = editor.addObject(poisoned);
    // RED：现 HEAD own() 后无复验，用旧 project 继续 commit 复活编辑器并返回成功
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });

  it('R9-M1-T2 addObject 输入对象 getter 内嵌套 openProject：外层取消、内层保留', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const inner = { ...createSampleProject(), name: '内层项目' };
    const poisoned = primitiveObject('poison-2');
    Object.defineProperty(poisoned, 'transform', {
      enumerable: true,
      configurable: true,
      get() {
        editor.openProject(inner);
        return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
      },
    });
    const result = editor.addObject(poisoned);
    // RED：现 HEAD 外层用回调前旧快照提交，覆盖内层 openProject 结果
    expect(result.ok).toBe(false);
    expect(editor.getProject()!.name).toBe('内层项目');
    expect(editor.getProject()!.objects.some((o) => o.id === 'poison-2')).toBe(false);
  });

  it('R9-M1-T3 setTransform 数组元素 getter 内 dispose：提交取消、项目不复活', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const transform: TransformData = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    Object.defineProperty(transform.position, '0', {
      enumerable: true,
      configurable: true,
      get() {
        editor.dispose();
        return 0;
      },
    });
    const result = editor.setTransform('sample-cube', transform);
    // RED：现 HEAD isValidTransform/ownTransform 读取外部数组元素后无复验
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });

  it('R9-M1-T4 commitTransform 数组元素 getter 内 dispose：提交取消、项目不复活', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    editor.beginTransform();
    const transform: TransformData = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    Object.defineProperty(transform.scale, '2', {
      enumerable: true,
      configurable: true,
      get() {
        editor.dispose();
        return 1;
      },
    });
    const result = editor.commitTransform('sample-cube', transform);
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });

  it('R9-M1-T5 registerAsset 输入 getter 内 dispose：拒绝且不复活（既有防护覆盖）', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const poisoned = assetData('asset-poison');
    Object.defineProperty(poisoned, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        editor.dispose();
        return '毒资源';
      },
    });
    const result = editor.registerAsset(poisoned);
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });

  it('R9-M1-T6 importModel 输入 getter 内 dispose：拒绝且不复活（既有防护覆盖）', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const poisoned = assetData('asset-poison-2');
    Object.defineProperty(poisoned, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        editor.dispose();
        return '毒资源';
      },
    });
    const result = editor.importModel(poisoned, primitiveObject('poison-3'));
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });

  it('R9-M1-T7 公开写入口全集已登记（新增入口必须显式纳入对抗表）', () => {
    // TS private 在运行时仍出现在原型上：把已知私有实现细节也钉死，
    // 任何新增方法（公开或私有）都必须显式登记 —— 公开入口漏登记即红
    const PRIVATE_API_LIST = [
      'applyHistorySnapshot',
      'assertAlive',
      'beginIngress',
      'captureViewBaseline',
      'commit',
      'commitEntry',
      'dedupeSelection',
      'deriveView',
      'duplicateSubtree',
      'emitHistory',
      'emitProjectEvents',
      'filterSelection',
      'guardReentry',
      'guardViewReentry',
      'isReachableFrom',
      'own',
      'ownTransform',
      'sameTransform',
      'stampAndFreeze',
      'swapState',
      'validateProject',
    ];
    const expected = [...PUBLIC_API_LIST, ...PRIVATE_API_LIST].sort();
    const methods = new Set(
      Object.getOwnPropertyNames(SceneEditor.prototype)
        .filter((k) => k !== 'constructor' && typeof (SceneEditor.prototype as unknown as Record<string, unknown>)[k] === 'function')
        .sort(),
    );
    expect([...methods]).toEqual(expected);
  });
});
