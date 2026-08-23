import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import * as THREE from 'three';
import {
  buildProjectPackage,
  createBlankProject,
  createGroupObject,
  createSampleProject,
  serializeProjectPackage,
} from '@lumora/core';
import type { Project } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import type { StudioRuntime } from '../src/runtime/studio-runtime';
import { ProjectStore } from '../src/persistence/project-store';

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

const DB = 'lumora-studio';
const mountPoints: Array<{ handle: React.RefObject<LumoraStudioHandle | null>; unmount: () => void }> = [];

function renderStudio() {
  const handle = createRef<LumoraStudioHandle>();
  const { unmount } = render(<LumoraStudio ref={handle} hostVersion="0.1.0" />);
  mountPoints.push({ handle, unmount });
  return handle;
}

afterEach(async () => {
  // 卸载后延迟执行的 dispose 会关闭 IndexedDB 连接：等它完成再删库，
  // 否则挂起的 deleteDatabase 会无限阻塞后续测试的 open（fake-indexeddb 与真实浏览器一致）
  for (const point of mountPoints) point.unmount();
  mountPoints.length = 0;
  await new Promise((r) => setTimeout(r, 30));
  await ProjectStore.drop(DB);
});

async function waitPersistence(handle: React.RefObject<LumoraStudioHandle | null>): Promise<StudioRuntime> {
  await waitFor(() => expect(handle.current?.runtime.persistence.available).toBe(true));
  return handle.current!.runtime;
}

async function openMenu(): Promise<void> {
  screen.getByTestId('project-menu').click();
  await screen.findByTestId('project-menu-dropdown');
}

async function createProjectViaMenu(name: string): Promise<void> {
  screen.getByTestId('project-new').click();
  const input = await screen.findByTestId('project-name-input');
  fireEvent.change(input, { target: { value: name } });
  screen.getByTestId('project-name-confirm').click();
  await waitFor(() => expect(screen.queryByTestId('project-name-confirm')).not.toBeInTheDocument());
}

/** 等待最近项目列表出现指定名称（首次落盘由 autosaver 打开时触发，防抖 2 秒内完成） */
async function waitRecent(runtime: StudioRuntime, name: string): Promise<void> {
  await waitFor(
    async () => {
      const recent = await runtime.persistence.listRecent();
      expect(recent.map((s) => s.name)).toContain(name);
    },
    { timeout: 4000 },
  );
}

describe('ProjectMenu：新建 / 最近项目 / 重命名 / 删除（FR-001）', () => {
  it('新建项目 → 自动保存 → 出现在最近项目列表', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    await openMenu();
    await createProjectViaMenu('片场一号');

    expect(runtime.getProject()!.name).toBe('片场一号');
    expect(screen.queryByTestId('studio-empty-hint')).not.toBeInTheDocument();
    await waitRecent(runtime, '片场一号');
  });

  it('最近项目可重新打开；重命名后名称同步到列表与编辑器', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    await openMenu();
    await createProjectViaMenu('待改名项目');
    await waitRecent(runtime, '待改名项目');

    await runtime.closeProject();
    await openMenu();
    expect(await screen.findByTestId('recent-project')).toHaveTextContent('待改名项目');
    screen.getByTestId('recent-rename').click();
    const input = await screen.findByTestId('project-name-input');
    fireEvent.change(input, { target: { value: '新名字' } });
    screen.getByTestId('project-name-confirm').click();
    await waitFor(() => expect(screen.queryByTestId('project-name-confirm')).not.toBeInTheDocument());

    // 重命名（未打开，走 store 路径）后重新打开的是新名字；
    // 打开按钮在重命名 busy 期间禁用，等可用再点击
    await waitFor(() => {
      const openButton = document.querySelector(
        '.lumora-project-menu__recent-open',
      ) as HTMLButtonElement | null;
      expect(openButton?.disabled).toBe(false);
    });
    (document.querySelector('.lumora-project-menu__recent-open') as HTMLButtonElement).click();
    await waitFor(() => expect(runtime.getProject()?.name).toBe('新名字'));
  });

  it('删除打开中的项目：先关闭再移除，最近列表同步', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    await openMenu();
    await createProjectViaMenu('待删除项目');
    await waitRecent(runtime, '待删除项目');
    const uri = runtime.getProject()!.uri;

    await openMenu();
    fireEvent.click(await screen.findByTestId('recent-delete'));
    fireEvent.click(await screen.findByTestId('confirm-delete'));
    await waitFor(() => expect(runtime.getProject()).toBeNull());
    expect((await runtime.persistence.listRecent()).map((s) => s.uri)).not.toContain(uri);
  });

  it('Escape 关闭菜单：焦点在 trigger（点击后未移入面板）时同样生效（TML-53 第三轮 #11）', async () => {
    const handle = renderStudio();
    await waitPersistence(handle);
    await openMenu();
    const trigger = screen.getByTestId('project-menu');
    // 刚点击「项目」后焦点在 trigger 上：keydown 事件不经过 dropdown，只由根容器接住
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('project-menu-dropdown')).not.toBeInTheDocument());
    // 关闭后面板焦点回到常驻「项目」按钮
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape 在面板内焦点时同样关闭菜单，且关闭后面板焦点回到 trigger', async () => {
    const handle = renderStudio();
    await waitPersistence(handle);
    await openMenu();
    const dropdown = screen.getByTestId('project-menu-dropdown');
    fireEvent.keyDown(dropdown, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('project-menu-dropdown')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId('project-menu'));
  });

  it('删除项目后焦点回到常驻「项目」按钮，不落 BODY（TML-53 第三轮 #12）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    await openMenu();
    await createProjectViaMenu('焦点回退项目');
    await waitRecent(runtime, '焦点回退项目');

    await openMenu();
    fireEvent.click(await screen.findByTestId('recent-delete'));
    fireEvent.click(await screen.findByTestId('confirm-delete'));
    await waitFor(() => expect(runtime.getProject()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('project-menu')));
  });
});

describe('ProjectMenu：工程包导出 / 导入（FR-011 / AC1 / AC3）', () => {
  it('导出当前项目：触发 .lumora 下载并提示成功', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn(() => 'blob:mock-download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    try {
      runtime.openProject(createSampleProject('lumora://project/export', '导出样例'));
      await openMenu();
      screen.getByTestId('project-export').click();
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      // 下载文件名 = 项目名 + .lumora
      expect((clickSpy.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toBe('导出样例.lumora');
      expect(await screen.findByText(/已导出工程包/)).toBeInTheDocument();
      // 等下载后的 revoke 定时器在 URL stub 仍然生效时触发
      await new Promise((r) => setTimeout(r, 1100));
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('导出菜单勾选「包含插件私有设置」后 exportCurrent 收到 includePrivate 与插件 privateSettings 声明（第十一轮）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    // 注册声明 privateSettings 的插件：ProjectMenu 导出时从 host 收集声明
    await runtime.host.register({
      manifest: {
        schemaVersion: '1',
        id: 'com.example.aiassistant',
        name: 'AI 助手',
        version: '1.0.0',
        entry: './dist/index.js',
        contributes: [],
        privateSettings: ['auth', 'apiKey'],
      },
      entry: async () => ({ activate: () => undefined }),
    });
    runtime.openProject(createSampleProject('lumora://project/export', '导出样例'));
    const spy = vi.spyOn(runtime.persistence, 'exportCurrent').mockReturnValue({
      ok: true,
      text: '{}',
      filename: '导出样例.lumora',
      bytes: 2,
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn(() => 'blob:mock-download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    try {
      await openMenu();
      // 隐私默认：不勾选 → 默认导出（声明照常收集，仅 pluginData 不进包）
      expect(screen.getByTestId('project-export-include-private')).not.toBeChecked();
      screen.getByTestId('project-export').click();
      await waitFor(() =>
        expect(spy).toHaveBeenCalledWith({
          includePrivate: false,
          privateKeysByPlugin: { 'com.example.aiassistant': ['auth', 'apiKey'] },
        }),
      );
      // 显式开启：仅放行插件私有设置
      fireEvent.click(screen.getByTestId('project-export-include-private'));
      expect(screen.getByTestId('project-export-include-private')).toBeChecked();
      screen.getByTestId('project-export').click();
      await waitFor(() =>
        expect(spy).toHaveBeenCalledWith({
          includePrivate: true,
          privateKeysByPlugin: { 'com.example.aiassistant': ['auth', 'apiKey'] },
        }),
      );
      await new Promise((r) => setTimeout(r, 1100));
    } finally {
      spy.mockRestore();
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('includePrivate 导出：manifest.privateSettings 声明的键被剥离，未声明键完整保留（NFR-008）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    await runtime.host.register({
      manifest: {
        schemaVersion: '1',
        id: 'com.example.aiassistant',
        name: 'AI 助手',
        version: '1.0.0',
        entry: './dist/index.js',
        contributes: [],
        privateSettings: ['auth'],
      },
      entry: async () => ({ activate: () => undefined }),
    });
    const withPrivate: Project = {
      ...createSampleProject('lumora://project/private', '私有设置项目'),
      pluginData: {
        'com.example.aiassistant': {
          theme: 'dark',
          model: 'claude-sonnet-5',
          auth: { apiKey: 'sk-lumora-secret-1234' },
          passwd: 'pw-local-5678',
        },
      },
    };
    await runtime.openProject(withPrivate);

    // 默认导出：pluginData 与其中任何内容都不进包（结构性隔离）
    const defaultExport = runtime.persistence.exportCurrent();
    expect(defaultExport.ok).toBe(true);
    const defaultJson = JSON.stringify(JSON.parse(defaultExport.ok ? defaultExport.text : ''));
    expect(defaultJson).not.toContain('pluginData');
    expect(defaultJson).not.toContain('sk-lumora-secret-1234');

    // includePrivate：声明的 auth 整棵子树被剥离；未声明键（theme/model/passwd）
    // 完整保留 —— 契约不猜测键名（passwd 形态键名不声明即保留）
    const privateExport = runtime.persistence.exportCurrent({
      includePrivate: true,
      privateKeysByPlugin: { 'com.example.aiassistant': ['auth'] },
    });
    expect(privateExport.ok).toBe(true);
    const privatePkg = JSON.parse(privateExport.ok ? privateExport.text : '') as {
      manifest: { includePrivate: boolean };
      project: { pluginData?: Record<string, unknown> };
    };
    expect(privatePkg.manifest.includePrivate).toBe(true);
    const plugin = privatePkg.project.pluginData?.['com.example.aiassistant'] as
      | Record<string, unknown>
      | undefined;
    expect(plugin?.theme).toBe('dark');
    expect(plugin?.model).toBe('claude-sonnet-5');
    expect(plugin?.passwd).toBe('pw-local-5678');
    expect(plugin?.auth).toBeUndefined();
    const privateJson = JSON.stringify(privatePkg);
    expect(privateJson).not.toContain('sk-lumora-secret-1234');
    expect(privateJson).not.toContain('"auth"');
  });

  it('导入工程包：完整恢复并打开；同 uri 已存在时作为副本导入', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    // 本地先占住同一个 uri，验证导入走副本路径（不覆盖本地记录）
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    await store!.save(createBlankProject('lumora://project/import-me', '本地同名项目'));
    store!.close();

    await openMenu();
    const pkg = buildProjectPackage(createSampleProject('lumora://project/import-me', '打包项目'));
    const file = new File([serializeProjectPackage(pkg)], '打包项目.lumora', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('project-import-input'), { target: { files: [file] } });

    await waitFor(() => expect(runtime.getProject()?.name).toBe('打包项目（导入）'));
    expect(runtime.getProject()!.uri).not.toBe('lumora://project/import-me');
    expect(await screen.findByText(/已导入项目/)).toBeInTheDocument();
  });

  it('损坏工程包：导入失败、当前项目保持不变并提示可操作原因（AC3）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    runtime.openProject(createSampleProject('lumora://project/keep', '保留项目'));

    await openMenu();
    const broken = new File(['这不是 JSON {{{'], 'broken.lumora', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('project-import-input'), { target: { files: [broken] } });

    await waitFor(() => expect(screen.getByText(/导入失败/)).toHaveTextContent('JSON'));
    // 失败回滚：当前项目原样（AC3）
    expect(runtime.getProject()!.name).toBe('保留项目');
    expect(runtime.getProject()!.uri).toBe('lumora://project/keep');
  });
});

describe('ProjectMenu：保存状态徽标（AC2 可见性）', () => {
  it('编辑后显示「未保存更改」，防抖保存后转为「已保存」', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    runtime.openProject(createSampleProject('lumora://project/dirty', '脏状态项目'));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));

    runtime.editor.addObject(createGroupObject());
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('未保存更改'));
    await waitFor(
      () => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'),
      { timeout: 4000 },
    );
  });

  it('持久化不可用时明示「仅内存（未持久化）」，不假报「已保存」', async () => {
    const idb = (globalThis as { indexedDB?: unknown }).indexedDB;
    try {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
      const handle = renderStudio();
      await waitFor(() => expect(handle.current).not.toBeNull());
      handle.current!.runtime.openProject(createSampleProject('lumora://project/mem', '内存项目'));
      await waitFor(() =>
        expect(screen.getByTestId('save-state-badge')).toHaveTextContent('仅内存（未持久化）'),
      );
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true });
    }
  });

  it('保存失败徽标提供冲突解决操作：加载较新版本后编辑器切换并恢复已保存', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    runtime.openProject(createSampleProject('lumora://project/conf', '冲突项目'));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));

    // 模拟另一标签页写入了较新内容（revision 5）
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    await store!.save({ ...createSampleProject('lumora://project/conf', '较新内容'), revision: 5 });
    store!.close();

    runtime.editor.addObject(createGroupObject());
    await waitFor(
      () => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('保存失败'),
      { timeout: 4000 },
    );
    // 冲突必须显式解决：三枚操作按钮可见
    expect(screen.getByTestId('save-reload')).toBeInTheDocument();
    expect(screen.getByTestId('save-saveas')).toBeInTheDocument();
    expect(screen.getByTestId('save-retry')).toBeInTheDocument();

    // 加载较新版本：编辑器内容切换到本地较新保存，冲突解除
    screen.getByTestId('save-reload').click();
    await waitFor(() => expect(runtime.getProject()!.name).toBe('较新内容'));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));
  });

  it('「另存副本」存储复制路径：副本校验失败时提示错误，不静默报成功（第十一轮严重 #3）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    runtime.openProject(createSampleProject('lumora://project/dup-ui', '副本UI项目'));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));

    // 制造保存失败（冲突）状态 → 出现「另存副本」解决按钮
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    await store!.save({ ...createSampleProject('lumora://project/dup-ui', '较新内容'), revision: 5 });
    store!.close();
    runtime.editor.addObject(createGroupObject());
    await waitFor(
      () => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('保存失败'),
      { timeout: 4000 },
    );

    // 注入存储复制路径故障：无未保存源（走 duplicate 分支）、duplicate 成功，
    // 但副本记录无法通过校验（loadProject 失败）—— 修复前此处静默报成功
    const persistence = runtime.persistence;
    const sourceSpy = vi.spyOn(persistence, 'resolveSaveAsCopySource').mockReturnValue(null);
    const dupSpy = vi.spyOn(persistence, 'duplicateProject').mockResolvedValue({
      ok: true,
      summary: {
        uri: 'lumora://project/dup-ui-copy',
        name: '副本UI项目 副本',
        savedAt: new Date().toISOString(),
        revision: 0,
        schemaVersion: 3,
      },
    });
    const loadSpy = vi.spyOn(persistence, 'loadProject').mockResolvedValue({
      ok: false,
      message: '本地项目数据校验失败：settings.fps 非法',
    });
    try {
      await openMenu();
      screen.getByTestId('save-saveas').click();
      await waitFor(() => expect(screen.getByText(/副本校验失败/)).toBeInTheDocument());
      expect(dupSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      // 校验失败：菜单不关闭（无成功切换），也不得出现「已另存为」成功提示
      expect(screen.getByTestId('project-menu-dropdown')).toBeInTheDocument();
      expect(screen.queryByText(/已另存为/)).not.toBeInTheDocument();
    } finally {
      sourceSpy.mockRestore();
      dupSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });
});
