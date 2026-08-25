import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import * as THREE from 'three';
import { createModelObject, createSampleProject, SceneEditor } from '@lumora/core';
import type { Project, SceneEditor as SceneEditorType } from '@lumora/core';
import { EditorViewport } from '../src/components/editor/EditorViewport';
import type { CacheLease, ContentCache } from '../src/components/editor/content-cache';
import { findNode } from '../src/components/editor/scene-builder';
import { useSceneEditor } from '../src/hooks/use-scene-editor';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * R8-4 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 视口连续 openProject 复用场景/对象 ID 时保留旧节点（EditorViewport SceneContent）：
 * 旧实现只比较 activeSceneId（两个项目相同）→ 走增量同步 → 同 ID 换 type 的对象
 * 复用旧类型节点。修复：按编辑器会话令牌（openProject/reset 自增）强制全量重建。
 */

const mockScene = vi.hoisted(() => ({ scene: null as unknown as THREE.Group }));

vi.mock('@react-three/fiber', async () => {
  const { Group, PerspectiveCamera } = await import('three');
  return {
    Canvas: ({ children }: { children?: React.ReactNode }) => <div data-testid="mock-canvas">{children}</div>,
    useThree: (selector?: (s: unknown) => unknown) => {
      if (!mockScene.scene) mockScene.scene = new Group();
      const state = {
        scene: mockScene.scene,
        set: () => undefined,
        camera: new PerspectiveCamera(),
        gl: { setViewport: () => undefined, setScissor: () => undefined, setScissorTest: () => undefined },
        size: { width: 800, height: 600 },
        viewport: { dpr: 1 },
      };
      return selector ? selector(state) : state;
    },
    useFrame: () => undefined,
  };
});

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  TransformControls: () => null,
}));

/** 每个测试独立的场景组：模拟 r3f 场景按用例隔离，避免跨用例残留旧树 */
beforeEach(() => {
  mockScene.scene = null as unknown as THREE.Group;
});

function leaseWith(content: Promise<unknown>): CacheLease {
  // 缓存内容类型为 Promise<GLTF>：该 stub 不参与模型解析，仅需满足形状
  return { hash: 'noop', generation: 0, content: content as Promise<GLTF>, isReleased: false, release: vi.fn() };
}

function noopCache(): ContentCache {
  return {
    acquire: vi.fn(() => leaseWith(Promise.resolve())),
    seed: vi.fn(() => leaseWith(Promise.resolve())),
    retain: vi.fn(() => null),
    has: vi.fn(() => false),
    isReady: vi.fn(() => false),
    getInfo: vi.fn(() => null),
    discard: vi.fn(),
    sweep: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ContentCache;
}

/** 同一项目结构，仅把 sample-cube 从立方体改为点光源（ID/场景 ID 全部复用） */
function lightForkProject(project: Project): Project {
  return {
    ...project,
    objects: project.objects.map((o) =>
      o.id === 'sample-cube'
        ? { ...o, type: 'light' as const, light: { kind: 'point' as const, color: '#ffffff', intensity: 2 } }
        : o,
    ),
  };
}

function ViewportHarness({ editor }: { editor: SceneEditorType }) {
  const state = useSceneEditor(editor);
  return (
    <EditorViewport
      editor={editor}
      project={state.project}
      selection={state.selection}
      view={state.view}
      cache={noopCache()}
    />
  );
}

describe('R8-4 视口连续 openProject：按会话代强制重建', () => {
  it('R8-4-V1 同场景 ID 连续打开两个项目：同 ID 对象换 type → 节点重建为点光源', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    render(<ViewportHarness editor={editor} />);
    expect(findNode(mockScene.scene, 'sample-cube')).not.toBeNull();

    act(() => {
      editor.openProject(lightForkProject(createSampleProject()));
    });

    // RED：旧实现只比较 activeSceneId（相同）→ 增量同步 → 旧 Mesh 节点被复用
    const cube = findNode(mockScene.scene, 'sample-cube');
    expect(cube).not.toBeNull();
    expect(cube).toBeInstanceOf(THREE.PointLight);
    expect(cube!.userData.type).toBe('light');
  });

  it('R8-4-V2 同会话内提交仍走增量同步：节点实例复用，不重建场景', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    render(<ViewportHarness editor={editor} />);
    const before = findNode(mockScene.scene, 'sample-cube');
    expect(before).not.toBeNull();

    act(() => {
      editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: '改名立方体' }), '改名');
    });

    const after = findNode(mockScene.scene, 'sample-cube');
    expect(after).toBe(before);
    expect(after!.name).toBe('改名立方体');
  });

  it('publishes a new render-content generation after a deferred model lease attaches', async () => {
    let resolveContent!: (value: GLTF) => void;
    const content = new Promise<GLTF>((resolve) => {
      resolveContent = resolve;
    });
    const lease = leaseWith(content);
    const cache = noopCache();
    vi.mocked(cache.seed).mockReturnValue(lease);
    const base = createSampleProject();
    const model = { ...createModelObject('asset-deferred', 'Deferred model'), id: 'model-deferred' };
    const project: Project = {
      ...base,
      assets: [
        {
          id: 'asset-deferred',
          kind: 'gltf',
          name: 'deferred.glb',
          format: 'glb',
          mime: 'model/gltf-binary',
          hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          size: 4,
          source: 'file',
          storageRef: 'blob:deferred',
          payload: 'AAAA',
          createdAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      objects: [...base.objects, model],
      scenes: base.scenes.map((scene) => ({
        ...scene,
        rootObjectIds: [...scene.rootObjectIds, model.id],
      })),
    };
    const editor = new SceneEditor();
    editor.openProject(project);
    const onRenderContentChange = vi.fn();
    render(
      <EditorViewport
        editor={editor}
        project={editor.getProject()}
        selection={[]}
        view={editor.getView()}
        cache={cache}
        onRenderContentChange={onRenderContentChange}
      />,
    );
    const beforeSettlement = onRenderContentChange.mock.calls.length;

    await act(async () => {
      resolveContent({ scene: new THREE.Group() } as GLTF);
      await content;
    });

    expect(onRenderContentChange.mock.calls.length).toBeGreaterThan(beforeSettlement);
  });
});
