import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act, createRef } from 'react';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createPrimitiveObject, createSampleProject, SceneEditor } from '@lumora/core';
import type { AssetData, Project, SceneEditor as SceneEditorType } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import { ObjectTree } from '../src/components/editor/ObjectTree';
import { PropertiesPanel } from '../src/components/editor/PropertiesPanel';
import type { CacheLease, ContentCache } from '../src/components/editor/content-cache';
import { importModelFile } from '../src/components/editor/model-import';
import { ToastHost } from '../src/components/editor/toasts';
import { useSceneEditor } from '../src/hooks/use-scene-editor';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-canvas">{children}</div>
  ),
  useThree: (selector?: (state: unknown) => unknown) => {
    const state = {
      scene: new THREE.Group(),
      set: () => undefined,
      camera: new THREE.PerspectiveCamera(),
      gl: { setViewport: () => undefined, setScissor: () => undefined, setScissorTest: () => undefined },
      size: { width: 800, height: 600 },
      viewport: { dpr: 1 },
    };
    return selector ? selector(state) : state;
  },
  useFrame: () => undefined,
}));

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  TransformControls: () => null,
}));

function leaseWith(content: Promise<GLTF>): CacheLease {
  return { hash: 'noop', generation: 0, content, isReleased: false, release: vi.fn() };
}

function noopCache(): ContentCache {
  return {
    acquire: vi.fn(() => leaseWith(Promise.resolve({ scene: new THREE.Group() } as unknown as GLTF))),
    seed: vi.fn(() => leaseWith(Promise.resolve({ scene: new THREE.Group() } as unknown as GLTF))),
    retain: vi.fn(() => null),
    has: vi.fn(() => false),
    isReady: vi.fn(() => false),
    getInfo: vi.fn(() => null),
    discard: vi.fn(),
    sweep: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ContentCache;
}

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

function findObject(editor: SceneEditorType, id: string) {
  return editor.getProject()?.objects.find((o) => o.id === id);
}

function TreeHarness({ editor, cache }: { editor: SceneEditorType; cache: ContentCache }) {
  const state = useSceneEditor(editor);
  return (
    <>
      <ObjectTree editor={editor} project={state.project} selection={state.selection} cache={cache} />
      <ToastHost />
    </>
  );
}

function InspectorHarness({ editor }: { editor: SceneEditorType }) {
  const state = useSceneEditor(editor);
  return (
    <>
      <PropertiesPanel editor={editor} project={state.project} selection={state.selection} />
      <ToastHost />
    </>
  );
}

function StudioHarness({ editor, cache }: { editor: SceneEditorType; cache: ContentCache }) {
  const state = useSceneEditor(editor);
  return (
    <>
      <ObjectTree editor={editor} project={state.project} selection={state.selection} cache={cache} />
      <PropertiesPanel editor={editor} project={state.project} selection={state.selection} />
      <ToastHost />
    </>
  );
}

describe('ObjectTree：对象层级交互', () => {
  it('渲染示例项目层级：组与子对象、灯光、相机均可见', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    expect(screen.getByTestId('tree-row-sample-group')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-sample-cube')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-sample-light')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-sample-camera')).toBeInTheDocument();
  });

  it('点击选择 / 双击重命名；添加菜单创建对象并选中', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);

    fireEvent.click(screen.getByTestId('tree-row-sample-cube'));
    expect(editor.getSelection()).toEqual(['sample-cube']);

    fireEvent.doubleClick(screen.getByTestId('tree-row-sample-cube'));
    const rename = screen.getByTestId('tree-rename-sample-cube');
    fireEvent.change(rename, { target: { value: '红方块' } });
    fireEvent.blur(rename);
    expect(findObject(editor, 'sample-cube')?.name).toBe('红方块');

    fireEvent.click(screen.getByTestId('add-object'));
    fireEvent.click(screen.getByTestId('add-立方体'));
    const added = editor.getSelection()[0]!;
    expect(findObject(editor, added)?.type).toBe('primitive');
    expect(
      editor.getProject()!.scenes.find((s) => s.id === editor.getProject()!.activeSceneId)!.rootObjectIds,
    ).toContain(added);
  });

  it('可见/锁定切换与两步删除；删除携带锁定对象时被拒绝', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);

    expect(screen.getByTestId('tree-visible-sample-cube')).toHaveAccessibleName('隐藏 立方体');
    expect(screen.getByTestId('tree-lock-sample-cube')).toHaveAccessibleName('锁定 立方体');
    expect(screen.getByTestId('tree-move-sample-cube')).toHaveAccessibleName('移动 立方体');
    expect(screen.getByTestId('tree-delete-sample-cube')).toHaveAccessibleName('删除 立方体');

    fireEvent.click(screen.getByTestId('tree-visible-sample-cube'));
    expect(findObject(editor, 'sample-cube')?.visible).toBe(false);
    expect(screen.getByTestId('tree-visible-sample-cube')).toHaveAccessibleName('显示 立方体');
    fireEvent.click(screen.getByTestId('tree-lock-sample-cube'));
    expect(findObject(editor, 'sample-cube')?.locked).toBe(true);
    expect(screen.getByTestId('tree-lock-sample-cube')).toHaveAccessibleName('解锁 立方体');
    // 解锁后两步删除：先点「删」出现「确认?」，再点确认
    fireEvent.click(screen.getByTestId('tree-lock-sample-cube'));
    fireEvent.click(screen.getByTestId('tree-delete-sample-cube'));
    expect(screen.getByTestId('tree-delete-sample-cube')).toHaveAccessibleName('确认删除 立方体');
    fireEvent.click(screen.getByTestId('tree-delete-sample-cube'));
    expect(findObject(editor, 'sample-cube')).toBeUndefined();

    // 锁定 light 后删除被拒绝，数据不变
    fireEvent.click(screen.getByTestId('tree-lock-sample-light'));
    fireEvent.click(screen.getByTestId('tree-delete-sample-light'));
    fireEvent.click(screen.getByTestId('tree-delete-sample-light'));
    expect(findObject(editor, 'sample-light')).toBeDefined();
    expect(screen.getByTestId('lumora-toasts')).toHaveTextContent('锁定');
  });

  it('拖拽重排层级；循环拖拽被拒绝且数据不变', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);

    // 把组拖到自身子树（cube）→ 循环拒绝
    fireEvent.dragStart(screen.getByTestId('tree-row-sample-group'));
    fireEvent.dragOver(screen.getByTestId('tree-row-sample-cube'));
    fireEvent.drop(screen.getByTestId('tree-row-sample-cube'));
    expect(findObject(editor, 'sample-group')?.parentId).toBeNull();

    // 把 cube 拖到 light 下 → 合法重排
    fireEvent.dragStart(screen.getByTestId('tree-row-sample-cube'));
    fireEvent.dragOver(screen.getByTestId('tree-row-sample-light'));
    fireEvent.drop(screen.getByTestId('tree-row-sample-light'));
    expect(findObject(editor, 'sample-cube')?.parentId).toBe('sample-light');
  });
});

describe('PropertiesPanel：数值属性编辑', () => {
  it('改名与位置输入提交；非法数值被拒绝并提示', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-cube']);
    render(<InspectorHarness editor={editor} />);

    const name = screen.getByTestId('inspector-name');
    expect(name).toHaveAccessibleName('对象名称');
    fireEvent.change(name, { target: { value: '改名方块' } });
    fireEvent.blur(name);
    expect(findObject(editor, 'sample-cube')?.name).toBe('改名方块');

    const x = screen.getByTestId('inspector-axis-0');
    fireEvent.change(x, { target: { value: '2.5' } });
    fireEvent.blur(x);
    expect(findObject(editor, 'sample-cube')?.transform.position[0]).toBe(2.5);

    fireEvent.change(x, { target: { value: 'abc' } });
    fireEvent.blur(x);
    expect(findObject(editor, 'sample-cube')?.transform.position[0]).toBe(2.5);
    expect(screen.getByTestId('lumora-toasts')).toHaveTextContent('数值非法');
  });

  it('旋转以角度制显示/提交；摄像机焦距与 FOV 联动', async () => {
    const editor = makeEditor();
    editor.setSelection(['sample-cube']);
    render(<InspectorHarness editor={editor} />);

    const rotationX = screen.getByTestId('inspector-rotation-0');
    fireEvent.change(rotationX, { target: { value: '90' } });
    fireEvent.blur(rotationX);
    const cube = findObject(editor, 'sample-cube')!;
    expect(cube.transform.rotation[0]).toBeCloseTo(Math.PI / 2, 5);

    editor.setSelection(['sample-camera']);
    const focal = await waitFor(() => screen.getByTestId('inspector-focal-length'));
    fireEvent.change(focal, { target: { value: '35' } });
    fireEvent.blur(focal);
    const camera = findObject(editor, 'sample-camera')!.camera!;
    expect(camera.focalLength).toBe(35);
    expect(camera.fov).toBeCloseTo(37.85, 1);
  });
});

describe('属性名称输入与键盘可用性（G-9/G-10）', () => {
  it('名称输入不串对象：编辑草稿未提交即切换选择，草稿不回写到任何对象', () => {
    const editor = makeEditor();
    render(<StudioHarness editor={editor} cache={noopCache()} />);
    fireEvent.click(screen.getByTestId('tree-row-sample-cube'));
    const name = screen.getByTestId('inspector-name');
    fireEvent.change(name, { target: { value: '草稿名字' } });
    // 未 blur 直接切换选择：输入框随选择重置为当前对象名称，旧草稿未提交
    fireEvent.click(screen.getByTestId('tree-row-sample-light'));
    expect(screen.getByTestId('inspector-name')).toHaveValue('主光');
    expect(findObject(editor, 'sample-cube')?.name).toBe('立方体');
    expect(findObject(editor, 'sample-light')?.name).toBe('主光');
  });

  it('切换对象时未提交草稿不串对象：数值相同的对象间切换，草稿随对象重置', () => {
    const editor = makeEditor();
    const resultA = editor.addObject(createPrimitiveObject('box', 'A'));
    const resultB = editor.addObject(createPrimitiveObject('box', 'B'));
    if (!resultA.ok || !resultB.ok) throw new Error('unexpected');
    const a = resultA.value!;
    const b = resultB.value!;
    render(<StudioHarness editor={editor} cache={noopCache()} />);
    fireEvent.click(screen.getByTestId(`tree-row-${a}`));
    const x = screen.getByTestId('inspector-axis-0');
    fireEvent.change(x, { target: { value: '9' } }); // 未 blur：草稿未提交
    // 两对象位置相同（均为 [0,0,0]）：key={object.id} 保证草稿不跨对象泄漏
    fireEvent.click(screen.getByTestId(`tree-row-${b}`));
    expect(screen.getByTestId('inspector-axis-0')).toHaveValue(0);
    expect(findObject(editor, a)!.transform.position[0]).toBe(0);
    expect(findObject(editor, b)!.transform.position[0]).toBe(0);
  });

  it('名称输入 Escape 取消草稿：不提交、输入框恢复当前名称', () => {
    const editor = makeEditor();
    render(<StudioHarness editor={editor} cache={noopCache()} />);
    fireEvent.click(screen.getByTestId('tree-row-sample-cube'));
    const name = screen.getByTestId('inspector-name');
    fireEvent.change(name, { target: { value: '改名试试' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(findObject(editor, 'sample-cube')?.name).toBe('立方体');
    expect(screen.getByTestId('inspector-name')).toHaveValue('立方体');
  });

  it('对象树键盘导航：方向键移动选择与焦点，折叠/展开，F2 重命名 Esc 取消', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    // 扁平行序：组、立方体、球体、圆锥、地面、主光、主摄像机、俯拍机位
    const cube = screen.getByTestId('tree-row-sample-cube');
    cube.focus();
    fireEvent.keyDown(cube, { key: 'ArrowDown' });
    expect(editor.getSelection()).toEqual(['sample-sphere']);
    expect(screen.getByTestId('tree-row-sample-sphere')).toHaveFocus();

    fireEvent.keyDown(screen.getByTestId('tree-row-sample-sphere'), { key: 'ArrowUp' });
    expect(editor.getSelection()).toEqual(['sample-cube']);
    expect(screen.getByTestId('tree-row-sample-cube')).toHaveFocus();

    // 子行 ArrowLeft → 移到父级（组），再次 ArrowLeft → 折叠组
    fireEvent.keyDown(screen.getByTestId('tree-row-sample-cube'), { key: 'ArrowLeft' });
    expect(editor.getSelection()).toEqual(['sample-group']);
    fireEvent.keyDown(screen.getByTestId('tree-row-sample-group'), { key: 'ArrowLeft' });
    expect(screen.queryByTestId('tree-row-sample-cube')).not.toBeInTheDocument();
    expect(screen.getByTestId('tree-row-sample-group')).toHaveAttribute('aria-expanded', 'false');

    // 展开后子行重新可见
    fireEvent.keyDown(screen.getByTestId('tree-row-sample-group'), { key: 'ArrowRight' });
    expect(screen.getByTestId('tree-row-sample-cube')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-sample-group')).toHaveAttribute('aria-expanded', 'true');

    // F2 进入重命名，Escape 取消不改名
    fireEvent.keyDown(screen.getByTestId('tree-row-sample-cube'), { key: 'F2' });
    const rename = screen.getByTestId('tree-rename-sample-cube');
    fireEvent.change(rename, { target: { value: '改名' } });
    fireEvent.keyDown(rename, { key: 'Escape' });
    expect(screen.queryByTestId('tree-rename-sample-cube')).not.toBeInTheDocument();
    expect(findObject(editor, 'sample-cube')?.name).toBe('立方体');

    // Enter 选中当前行；Home/End 跳到首/末行
    fireEvent.keyDown(screen.getByTestId('tree-row-sample-cube'), { key: 'Home' });
    expect(editor.getSelection()).toEqual(['sample-group']);
    fireEvent.keyDown(screen.getByTestId('tree-row-sample-group'), { key: 'End' });
    expect(editor.getSelection()).toEqual(['sample-camera-2']);
  });
});

describe('EditorViewport 集成：相机视图与 Gizmo 模式', () => {
  it('切到相机视图出现辅助线；切回导演视图消失；Gizmo 模式可切换', async () => {
    render(<LumoraStudio hostVersion="0.1.0" />);
    await screen.findByTestId('lumora-studio');
    fireEvent.click(screen.getByTestId('open-sample-project'));
    await waitFor(() => expect(screen.getByTestId('view-mode-select')).not.toBeDisabled());
    expect(screen.getByTestId('scene-switcher')).toHaveAccessibleName('活动场景');
    expect(screen.getByTestId('view-mode-select')).toHaveAccessibleName('视图模式');

    expect(screen.queryByTestId('lumora-guides')).not.toBeInTheDocument();
    const modeSelect = screen.getByTestId('view-mode-select');
    fireEvent.change(modeSelect, { target: { value: 'sample-camera' } });
    await waitFor(() => expect(screen.getByTestId('lumora-guides')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('gizmo-mode-rotate'));
    expect(screen.getByTestId('gizmo-mode-rotate')).toHaveClass('lumora-toolbutton--active');

    fireEvent.change(modeSelect, { target: { value: 'director' } });
    await waitFor(() => expect(screen.queryByTestId('lumora-guides')).not.toBeInTheDocument());
  });
});

describe('模型导入', () => {
  const gltfLike = { scene: new THREE.Group() } as unknown as GLTF;

  afterEach(() => vi.unstubAllGlobals());

  // jsdom 未实现 Blob.arrayBuffer（Not implemented），在测试中提供读取实现
  function makeFile(name: string, bytes: number[], type = 'model/gltf-binary'): File {
    const file = new File([new Uint8Array(bytes)], name, { type });
    file.arrayBuffer = async () => new Uint8Array(bytes).buffer as ArrayBuffer;
    return file;
  }

  function stubCache(overrides: Partial<ContentCache> = {}): ContentCache {
    const cache = noopCache();
    return { ...cache, ...overrides } as unknown as ContentCache;
  }

  // jsdom 的 crypto.subtle 会拒绝 jsdom 领域的 ArrayBuffer（跨 realm instanceof），
  // 关闭 subtle 让 hashBytes 走确定性的 FNV-1a 回退路径
  function useFnvHash(): void {
    vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: undefined });
  }

  it('导入成功：注册资源、创建模型对象，对象引用与资产一致', async () => {
    useFnvHash();
    const editor = makeEditor();
    const cache = stubCache({
      acquire: vi.fn(() => leaseWith(Promise.resolve(gltfLike))),
    });
    const file = makeFile('hero.glb', [1, 2, 3]);

    const result = await importModelFile(editor, cache, file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const project = editor.getProject()!;
    expect(project.assets).toHaveLength(1);
    expect(project.assets[0]!.name).toBe('hero.glb');
    const model = project.objects.find((o) => o.id === result.objectId)!;
    expect(model.type).toBe('model');
    expect(model.assetId).toBe(project.assets[0]!.id);
    expect(result.deduped).toBe(false);
    expect(editor.getSelection()).toEqual([result.objectId]);
  });

  it('解析失败：不产生资源与对象，返回错误', async () => {
    useFnvHash();
    const editor = makeEditor();
    const cache = stubCache({
      acquire: vi.fn(() =>
        leaseWith(Promise.reject(new Error('GLTFLoader: 无法解析'))),
      ),
    });
    const file = makeFile('bad.glb', [0]);

    const result = await importModelFile(editor, cache, file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('模型解析失败');
    expect(editor.getProject()!.assets).toHaveLength(0);
    expect(editor.getProject()!.objects.filter((o) => o.type === 'model')).toHaveLength(0);
  });

  it('多文件 .gltf 主文件 JSON 损坏：以 Result 失败返回，不触碰缓存', async () => {
    useFnvHash();
    const editor = makeEditor();
    const acquire = vi.fn(() => leaseWith(Promise.resolve(gltfLike)));
    const cache = stubCache({ acquire });
    // `{"` 未闭合：collectGltfUris 的 JSON.parse 抛错必须包装为 Result（统一错误契约）
    const gltfFile = makeFile('broken.gltf', [0x7b, 0x22], 'model/gltf+json');
    const binFile = makeFile('mesh.bin', [1, 2], 'application/octet-stream');

    const result = await importModelFile(editor, cache, [gltfFile, binFile]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('gltf JSON 解析失败');
    expect(editor.getProject()!.assets).toHaveLength(0);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('相同内容重复导入：资源去重，两个对象统一引用同一资产', async () => {
    useFnvHash();
    const editor = makeEditor();
    const cache = stubCache({
      acquire: vi.fn(() => leaseWith(Promise.resolve(gltfLike))),
    });
    const file = makeFile('hero.glb', [1, 2, 3]);

    const first = await importModelFile(editor, cache, file);
    const second = await importModelFile(editor, cache, file);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;
    const project = editor.getProject()!;
    expect(project.assets).toHaveLength(1);
    const models = project.objects.filter((o) => o.type === 'model');
    expect(models).toHaveLength(2);
    // P0-1：不同 assetId 的同 hash 导入 → 对象统一引用有效资源
    expect(models[0]!.assetId).toBe(models[1]!.assetId);
    expect(models[0]!.assetId).toBe(project.assets[0]!.id);
    expect(second.deduped).toBe(true);
    expect(first.deduped).toBe(false);
  });
});

describe('Toolbar 撤销/重做：一次操作一步历史（AC3）', () => {
  it('添加对象后撤销移除、重做恢复，按钮随历史可用', async () => {
    render(<LumoraStudio hostVersion="0.1.0" />);
    await screen.findByTestId('lumora-studio');
    fireEvent.click(screen.getByTestId('open-sample-project'));
    await waitFor(() => expect(screen.getByTestId('tree-row-sample-group')).toBeInTheDocument());

    const countRows = () => screen.getAllByTestId(/^tree-row-/).length;
    const before = countRows();
    const undoBtn = screen.getByTestId('undo');
    const redoBtn = screen.getByTestId('redo');
    expect(undoBtn).toBeDisabled();

    fireEvent.click(screen.getByTestId('add-object'));
    fireEvent.click(screen.getByTestId('add-立方体'));
    expect(countRows()).toBe(before + 1);
    expect(undoBtn).toBeEnabled();

    fireEvent.click(undoBtn);
    await waitFor(() => expect(countRows()).toBe(before));
    expect(redoBtn).toBeEnabled();

    fireEvent.click(redoBtn);
    await waitFor(() => expect(countRows()).toBe(before + 1));
  });
});

describe('项目序列化往返（Studio 接入）', () => {
  it('示例项目 JSON 往返后编辑器可打开且对象一致', () => {
    const editor = makeEditor();
    editor.setTransform('sample-cube', {
      position: [5, 2, 1],
      rotation: [0.5, 0, 0],
      scale: [2, 1, 1],
    });
    const serialized = JSON.parse(JSON.stringify(editor.getProject())) as Project;
    const reopened = new SceneEditor();
    reopened.openProject(serialized);
    expect(reopened.getProject()!.objects.find((o) => o.id === 'sample-cube')!.transform.position).toEqual([5, 2, 1]);
    expect(reopened.getProject()!.settings.aspect).toEqual([16, 9]);
  });
});

describe('资源释放（无引用释放）', () => {
  it('删除最后一个模型对象后资源从项目移除', () => {
    const editor = makeEditor();
    const asset: AssetData = {
      id: 'asset-hero',
      kind: 'gltf',
      name: 'hero.glb',
      mime: 'model/gltf-binary',
      hash: 'hash-hero',
      size: 10,
      source: 'file',
      storageRef: 'blob:hero',
      createdAt: '2026-01-01',
    };
    const modelId = editor.importModel(asset, {
      id: 'model-hero',
      type: 'model',
      name: 'hero',
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      assetId: 'asset-hero',
    });
    expect(modelId.ok).toBe(true);
    expect(editor.getProject()!.assets).toHaveLength(1);
    editor.setSelection(['model-hero']);
    editor.deleteSelection();
    expect(editor.getProject()!.assets).toHaveLength(0);
  });
});

describe('第二轮修复：Inspector 同步与 ARIA 树（P1-10/P1-11）', () => {
  it('P1-10 外部改名/撤销后名称框同步；编辑中草稿被外部变更丢弃', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-cube']);
    render(<InspectorHarness editor={editor} />);

    // 外部改名（树内重命名/命令面板等非面板路径）→ 面板回显新名称
    act(() => {
      editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: '外部改名' }), '重命名');
    });
    expect(screen.getByTestId('inspector-name')).toHaveValue('外部改名');

    // 撤销改名 → 面板回退为旧名称
    act(() => {
      editor.undo();
    });
    expect(screen.getByTestId('inspector-name')).toHaveValue('立方体');

    // 输入草稿后外部改名：草稿被丢弃，回显最新名称（受控草稿随对象名称同步）
    fireEvent.change(screen.getByTestId('inspector-name'), { target: { value: '我的草稿' } });
    act(() => {
      editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: '再次改名' }), '重命名');
    });
    expect(screen.getByTestId('inspector-name')).toHaveValue('再次改名');
    expect(findObject(editor, 'sample-cube')?.name).toBe('再次改名');
  });

  it('P1-11 对象树：多选容器、层级、单一 roving focus 与 group 结构', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);

    const tree = screen.getByRole('tree');
    expect(tree).toHaveAttribute('aria-multiselectable', 'true');
    expect(screen.getByTestId('tree-row-sample-group')).toHaveAttribute('aria-level', '1');
    expect(screen.getByTestId('tree-row-sample-cube')).toHaveAttribute('aria-level', '2');

    // 单一 roving focus：有且仅有一个 tabindex=0 的停靠行
    const tabStops = () =>
      screen.getAllByRole('treeitem').filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabStops()).toHaveLength(1);

    // 点击行 → 停靠点跟随该行
    fireEvent.click(screen.getByTestId('tree-row-sample-sphere'));
    expect(screen.getByTestId('tree-row-sample-sphere')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('tree-row-sample-group')).toHaveAttribute('tabindex', '-1');
    expect(tabStops()).toHaveLength(1);

    // 子行容器是 role=group（完整 ARIA 层级：tree > treeitem > group > treeitem）
    expect(screen.getAllByRole('group').length).toBeGreaterThanOrEqual(1);

    // 键盘焦点移动与 roving 停靠一致
    screen.getByTestId('tree-row-sample-cube').focus();
    fireEvent.keyDown(screen.getByTestId('tree-row-sample-cube'), { key: 'ArrowDown' });
    expect(screen.getByTestId('tree-row-sample-sphere')).toHaveFocus();
    expect(screen.getByTestId('tree-row-sample-sphere')).toHaveAttribute('tabindex', '0');
  });
});

describe('P1-9 切场景资源释放', () => {
  it('切换场景释放旧场景节点资源（几何 dispose）', async () => {
    const handleRef = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handleRef} hostVersion="0.1.0" />);
    await screen.findByTestId('lumora-studio');
    fireEvent.click(screen.getByTestId('open-sample-project'));
    await waitFor(() => expect(screen.getByTestId('tree-row-sample-group')).toBeInTheDocument());
    const editor = handleRef.current!.runtime.editor;

    // 立方体几何已随场景树挂载；切换场景时旧树整体释放
    const disposeSpy = vi.spyOn(THREE.BoxGeometry.prototype, 'dispose');
    act(() => {
      editor.addScene('场景 B');
    });
    await waitFor(() => expect(disposeSpy).toHaveBeenCalled());
  });
});
