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
import type { ProjectStorage } from '../src/persistence/project-storage';

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
  // 先捕获 store 引用：卸载后 React 会清空对象 ref（handle.current = null），
  // 届时无法再读取运行时 —— 泄漏的连接必须提前抓取
  const stores = mountPoints.map(
    (point) =>
      (point.handle.current?.runtime?.persistence as unknown as { store: ProjectStorage | null } | undefined)?.store ??
      null,
  );
  // 卸载后延迟执行的 dispose 会关闭 IndexedDB 连接：等它完成再删库，
  // 否则挂起的 deleteDatabase 会无限阻塞后续测试的 open（fake-indexeddb 与真实浏览器一致）
  for (const point of mountPoints) point.unmount();
  // 第二十八轮阻断 4：dispose 冲刷失败（未保存内容/锁存冲突）时不 teardown ——
  // 连接保留供调用方重试；测试隔离要求删库前强制释放，否则挂起的
  // deleteDatabase 永久排队、阻塞后续测试的 open（级联超时）
  await new Promise((r) => setTimeout(r, 30));
  for (const store of stores) store?.close();
  mountPoints.length = 0;
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

  it('导出菜单勾选「包含插件私有设置」后 exportCurrent 收到 includePrivate 与 manifest 原样声明的公开/私有键（第十四轮阻断 1/2 + 第十五轮阻断 1）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    // 注册声明显式公开导出契约（exportableSettings）的插件：ProjectMenu 导出时
    // 直读 manifest.exportableSettings 与 manifest.privateSettings 原样传入
    // publicKeysByPlugin / privateKeysByPlugin —— 宿主不再做减法过滤，重叠与
    // 凭据形态键由 core 端逐条拒绝
    await runtime.host.register({
      manifest: {
        schemaVersion: '1',
        id: 'com.example.aiassistant',
        name: 'AI 助手',
        version: '1.0.0',
        entry: './dist/index.js',
        contributes: [],
        exportableSettings: ['theme'],
      },
      entry: async () => ({ activate: () => undefined }),
    });
    runtime.openProject({
      ...createSampleProject('lumora://project/export', '导出样例'),
      pluginData: {
        'com.example.aiassistant': { theme: 'dark', apiKey: 'sk-x', auth: { token: 't' } },
      },
    } as Project);
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
      // 隐私默认：不勾选 → 默认导出（声明照常读取，仅 pluginData 不进包）
      expect(screen.getByTestId('project-export-include-private')).not.toBeChecked();
      screen.getByTestId('project-export').click();
      await waitFor(() =>
        expect(spy).toHaveBeenCalledWith({
          includePrivate: false,
          publicKeysByPlugin: { 'com.example.aiassistant': ['theme'] },
          privateKeysByPlugin: { 'com.example.aiassistant': [] },
        }),
      );
      // 显式开启：同一显式公开契约（未声明键 apiKey/auth 即使存在也不导出；
      // manifest 未声明 privateSettings → 私有键映射为空数组）
      fireEvent.click(screen.getByTestId('project-export-include-private'));
      expect(screen.getByTestId('project-export-include-private')).toBeChecked();
      screen.getByTestId('project-export').click();
      await waitFor(() =>
        expect(spy).toHaveBeenCalledWith({
          includePrivate: true,
          publicKeysByPlugin: { 'com.example.aiassistant': ['theme'] },
          privateKeysByPlugin: { 'com.example.aiassistant': [] },
        }),
      );
      await new Promise((r) => setTimeout(r, 1100));
    } finally {
      spy.mockRestore();
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('includePrivate 导出：仅 manifest.exportableSettings 显式声明的键进包，未声明键（直接及嵌套凭据）一律排除（NFR-008 + 第十四轮阻断 1）', async () => {
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
        exportableSettings: ['theme'],
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

    // includePrivate：宿主直读 manifest.exportableSettings 原样传入 —— 只有显式
    // 声明的键（theme）进包；未声明键（model/passwd 直接凭据、auth.apiKey 嵌套
    // 凭据）一律排除（修复前减法 allowlist 会把这些键连同整棵 auth 一起导出）
    const privateExport = runtime.persistence.exportCurrent({
      includePrivate: true,
      publicKeysByPlugin: { 'com.example.aiassistant': ['theme'] },
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
    expect(plugin?.model).toBeUndefined();
    expect(plugin?.passwd).toBeUndefined();
    expect(plugin?.auth).toBeUndefined();
    const privateJson = JSON.stringify(privatePkg);
    expect(privateJson).not.toContain('sk-lumora-secret-1234');
    expect(privateJson).not.toContain('claude-sonnet-5');
    expect(privateJson).not.toContain('pw-local-5678');
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
    // 但副本记录无法通过校验（loadCopyForOpen 内 loadProject 失败）—— 修复前
    // 此处静默报成功且 load 的 reject 形成未处理 Promise（第十四轮严重 5）
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
      fingerprint: 'fp-at-create',
    });
    const loadSpy = vi.spyOn(persistence, 'loadProject').mockResolvedValue({
      ok: false,
      message: '本地项目数据校验失败：settings.fps 非法',
    });
    try {
      await openMenu();
      screen.getByTestId('save-saveas').click();
      await waitFor(() => expect(screen.getByText(/无法打开副本/)).toBeInTheDocument());
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

  it('「另存副本」多 fork：只清被消费的当代，历史 fork 保留并继续锁存 recovery-available（第二十九轮阻断 3）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    const persistence = runtime.persistence;
    const store = (persistence as unknown as { store: ProjectStorage | null }).store!;
    const A = 'lumora://project/multifork';
    const base = createSampleProject(A, '多fork项目');
    runtime.openProject(base);
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));

    // A 的保存全部失败：两次「编辑→切换」产生两个内容不同的恢复 fork（base+1 / base+2）
    const realSave = store.save.bind(store);
    store.save = async (p, expected) => {
      if (p.uri === A && p.revision >= 1) {
        return { ok: false, code: 'storage-error', message: '模拟存储错误' };
      }
      return realSave(p, expected);
    };
    runtime.editor.addObject(createGroupObject()); // rev1（内容 base+1）
    runtime.editor.openProject(createSampleProject('lumora://project/multifork-b', 'B'));
    await waitFor(() => expect(persistence.getRecoverySnapshot(A)).not.toBeNull());
    expect(persistence.getRecoverySnapshot(A)!.objects.length).toBe(base.objects.length + 1);

    // 重开 A → 锁存 recovery-available（保存失败徽标 + 解决按钮）
    runtime.editor.openProject(base);
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('保存失败'));
    runtime.editor.addObject(createGroupObject());
    runtime.editor.addObject(createGroupObject()); // rev2（内容 base+2）
    runtime.editor.openProject(createSampleProject('lumora://project/multifork-c', 'C'));
    await waitFor(() => {
      const latest = persistence.getRecoverySnapshot(A);
      expect(latest).not.toBeNull();
      expect(latest!.objects.length).toBe(base.objects.length + 2);
    });

    // 恢复保存；重开 A 呈现最新代 fork 的解决入口
    store.save = realSave;
    runtime.editor.openProject(base);
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('保存失败'));

    // 点击「另存副本」：源 = 最新代 fork（base+2），只清除当代
    screen.getByTestId('save-saveas').click();
    await waitFor(() => expect(screen.getByText(/未保存更改已另存为/)).toBeInTheDocument());
    const copy = runtime.getProject()!;
    expect(copy.name).toBe('多fork项目 副本');
    expect(copy.uri).not.toBe(A);
    expect(copy.objects.length).toBe(base.objects.length + 2);
    // 历史 fork（base+1）保留 —— 修复前 clearRecovery 清空该 uri 全部 fork，
    // 更早保存失败的内容从此沉没
    const remaining = persistence.getRecoverySnapshot(A);
    expect(remaining).not.toBeNull();
    expect(remaining!.objects.length).toBe(base.objects.length + 1);
    await waitFor(
      () => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'),
      { timeout: 4000 },
    );

    // 重新打开 A：历史 fork 仍锁存 recovery-available，可继续恢复
    runtime.editor.openProject(base);
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('保存失败'));
    expect(persistence.getRecoverySnapshot(A)!.objects.length).toBe(base.objects.length + 1);
  });

  it('「最近项目复制」分支：副本写入成功但 loadProject 返回 ok:false → 清理副本并提示错误，绝不报成功（第十二轮一般 #6）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    runtime.openProject(createSampleProject('lumora://project/recent-dup', '最近复制项目'));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));
    await openMenu();
    await screen.findByTestId('recent-project');

    // 普通复制分支：duplicate 成功（副本已写入）但副本记录无法通过 loadProject
    // 校验（ok:false）—— 修复前该分支静默报「已复制为」成功；修复后显式失败
    // 并 CAS 清理损坏副本（第十四轮严重 4：按创建时指纹清理，绝不误删更新后记录）
    const persistence = runtime.persistence;
    const dupSpy = vi.spyOn(persistence, 'duplicateProject').mockResolvedValue({
      ok: true,
      summary: {
        uri: 'lumora://project/recent-dup-copy',
        name: '最近复制项目 副本',
        savedAt: new Date().toISOString(),
        revision: 0,
        schemaVersion: 3,
      },
      fingerprint: 'fp-at-create',
    });
    const loadSpy = vi.spyOn(persistence, 'loadProject').mockResolvedValue({
      ok: false,
      message: '本地项目数据校验失败：settings.fps 非法',
    });
    const store = (persistence as unknown as { store: ProjectStorage | null }).store;
    expect(store).not.toBeNull();
    const cleanupSpy = vi.spyOn(store!, 'removeIfUnchanged');
    try {
      screen.getByTestId('recent-duplicate').click();
      await waitFor(() => expect(screen.getByText(/无法打开副本/)).toBeInTheDocument());
      expect(dupSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      // 损坏副本按创建时指纹 CAS 清理：绝不遗留坏记录，也绝不误删已变化的记录
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith('lumora://project/recent-dup-copy', 'fp-at-create');
      // 绝不报成功：无「已复制为」成功提示
      expect(screen.queryByText(/已复制为/)).not.toBeInTheDocument();
    } finally {
      dupSpy.mockRestore();
      loadSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it('「最近项目复制」分支：副本加载 reject 且清理也 reject → 提示「清理失败，损坏副本记录保留，可手动删除」（第十三轮一般 8）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    runtime.openProject(createSampleProject('lumora://project/recent-dup2', '最近复制项目二'));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));
    await openMenu();
    await screen.findByTestId('recent-project');

    const persistence = runtime.persistence;
    const dupSpy = vi.spyOn(persistence, 'duplicateProject').mockResolvedValue({
      ok: true,
      summary: {
        uri: 'lumora://project/recent-dup-copy-2',
        name: '最近复制项目二 副本',
        savedAt: new Date().toISOString(),
        revision: 0,
        schemaVersion: 3,
      },
      fingerprint: 'fp-at-create-2',
    });
    const loadSpy = vi.spyOn(persistence, 'loadProject').mockRejectedValue(new Error('idb transaction aborted'));
    const store = (persistence as unknown as { store: ProjectStorage | null }).store;
    expect(store).not.toBeNull();
    const cleanupSpy = vi
      .spyOn(store!, 'removeIfUnchanged')
      .mockResolvedValue({ ok: false, message: 'idb transaction aborted' });
    try {
      screen.getByTestId('recent-duplicate').click();
      // 完整消息唯一匹配：toast 为模块级全局数组（4 秒过期），前序测试的
      // 「无法打开副本：…」可能仍在，前缀匹配会命中多条
      await waitFor(() =>
        expect(
          screen.getByText(/无法打开副本（idb transaction aborted）；清理失败，损坏记录保留，可手动删除（idb transaction aborted）/),
        ).toBeInTheDocument(),
      );
      expect(dupSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      // 清理也失败：如实报告记录保留、可手动删除 —— 修复前 load 的 reject 未
      // 捕获（未处理 Promise），坏副本静默残留且无任何提示
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith('lumora://project/recent-dup-copy-2', 'fp-at-create-2');
      expect(screen.getByText(/清理失败，损坏记录保留，可手动删除/)).toBeInTheDocument();
      expect(screen.queryByText(/已复制为/)).not.toBeInTheDocument();
    } finally {
      dupSpy.mockRestore();
      loadSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it('「最近项目复制」分支：清理按 CAS 判定记录已变化（另一会话已保存）→ 提示「已保留」，绝不误删（第十五轮一般 7 四态 UI）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    runtime.openProject(createSampleProject('lumora://project/recent-dup3', '最近复制项目三'));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));
    await openMenu();
    await screen.findByTestId('recent-project');

    const persistence = runtime.persistence;
    const dupSpy = vi.spyOn(persistence, 'duplicateProject').mockResolvedValue({
      ok: true,
      summary: {
        uri: 'lumora://project/recent-dup-copy-3',
        name: '最近复制项目三 副本',
        savedAt: new Date().toISOString(),
        revision: 0,
        schemaVersion: 3,
      },
      fingerprint: 'fp-at-create-3',
    });
    const loadSpy = vi.spyOn(persistence, 'loadProject').mockRejectedValue(new Error('idb transaction aborted'));
    const store = (persistence as unknown as { store: ProjectStorage | null }).store;
    expect(store).not.toBeNull();
    // 清理按创建时指纹 CAS 判定记录已被另一会话更新（outcome 'changed'）：
    // 绝不无条件删除 —— 更新后的合法记录保留并在提示中如实说明
    const cleanupSpy = vi.spyOn(store!, 'removeIfUnchanged').mockResolvedValue({ ok: true, outcome: 'changed' });
    try {
      screen.getByTestId('recent-duplicate').click();
      await waitFor(() =>
        expect(
          screen.getByText(/无法打开副本（idb transaction aborted）；副本记录已变化（可能已被其他会话保存），已保留该记录，可手动删除/),
        ).toBeInTheDocument(),
      );
      expect(dupSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith('lumora://project/recent-dup-copy-3', 'fp-at-create-3');
      expect(screen.getByText(/已保留该记录/)).toBeInTheDocument();
      expect(screen.queryByText(/已复制为/)).not.toBeInTheDocument();
    } finally {
      dupSpy.mockRestore();
      loadSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it('存储故障 toast 回归：刷新/打开/重命名/删除一律 catch 并提示，绝不静默（第十七轮严重 4）', async () => {
    const handle = renderStudio();
    const runtime = await waitPersistence(handle);
    await openMenu();
    await createProjectViaMenu('toast 回归项目');
    await waitRecent(runtime, 'toast 回归项目');
    await runtime.closeProject();
    // 先以真实存储打开一次菜单，让最近项目列表就位（后续刷新故障不影响列表状态）
    await openMenu();
    await screen.findByTestId('recent-project');

    const persistence = runtime.persistence;
    const listSpy = vi.spyOn(persistence, 'listRecent').mockRejectedValue(new Error('locks unavailable'));
    const loadSpy = vi.spyOn(persistence, 'loadProject').mockRejectedValue(new Error('locks unavailable'));
    try {
      // 刷新：toggle 菜单触发 refreshRecent → reject → toast
      screen.getByTestId('project-menu').click(); // 先关闭
      await waitFor(() => expect(screen.queryByTestId('project-menu-dropdown')).not.toBeInTheDocument());
      await openMenu(); // 再打开触发刷新
      await waitFor(() => expect(screen.getByText(/^locks unavailable$/)).toBeInTheDocument());
      // 打开：loadProject reject → catch → 带项目名的上下文 toast
      (document.querySelector('.lumora-project-menu__recent-open') as HTMLButtonElement).click();
      await waitFor(() =>
        expect(screen.getByText(/无法打开「toast 回归项目」：locks unavailable/)).toBeInTheDocument(),
      );
    } finally {
      listSpy.mockRestore();
      loadSpy.mockRestore();
    }

    // 重命名：renameProject reject → catch → toast
    const renameSpy = vi.spyOn(persistence, 'renameProject').mockRejectedValue(new Error('locks unavailable'));
    try {
      screen.getByTestId('recent-rename').click();
      const input = await screen.findByTestId('project-name-input');
      fireEvent.change(input, { target: { value: '改名失败项目' } });
      screen.getByTestId('project-name-confirm').click();
      await waitFor(() =>
        expect(screen.getByText(/重命名失败：locks unavailable/)).toBeInTheDocument(),
      );
    } finally {
      renameSpy.mockRestore();
    }

    // 删除：deleteProject reject → catch → toast（项目已关闭，不经 closeProject 分支）
    const deleteSpy = vi.spyOn(persistence, 'deleteProject').mockRejectedValue(new Error('locks unavailable'));
    try {
      fireEvent.click(await screen.findByTestId('recent-delete'));
      fireEvent.click(await screen.findByTestId('confirm-delete'));
      await waitFor(() =>
        expect(screen.getByText(/删除失败：locks unavailable/)).toBeInTheDocument(),
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });
});
