import { PluginHost, SceneEditor } from '@lumora/core';
import type { EventMap, Project } from '@lumora/core';
import { ProjectPersistence } from '../persistence/project-persistence';
import type { ProjectStorage, StorageBackend } from '../persistence/project-storage';

export interface StudioRuntimeOptions {
  hostVersion?: string;
  onError?: (error: unknown) => void;
}

/**
 * LumoraStudio 的运行时句柄：持有插件宿主与核心场景编辑器，封装项目生命周期。
 * 编辑器是项目数据的唯一权威来源：宿主快照与事件总线随编辑器每次变更同步
 * （插件/命令/面板经 host.getProject() 读到的永远是当前项目，而非打开时的旧快照）。
 * dispose() 停用全部插件、清空总线与编辑器 —— 供宿主在卸载组件时释放 WebGL/订阅资源。
 */
export interface StudioRuntime {
  host: PluginHost;
  events: import('@lumora/core').TypedEventEmitter<EventMap>;
  /** 核心场景编辑器：项目数据、选择、视口状态与历史栈（撤销/重做）的唯一持有者 */
  editor: SceneEditor;
  /**
   * 项目持久化门面：IndexedDB 或 OPFS 本地存储（最近项目/重命名/复制/删除）、
   * 2 秒防抖自动保存与 `.lumora` 工程包导入导出。init() 后生效；
   * 存储不可用时静默降级（available = false，仅内存编辑）。
   */
  persistence: ProjectPersistence;
  /**
   * 初始化本地存储并接入自动保存（幂等）。
   * options.storage 选择存储后端（缺省 indexeddb；opfs = Origin Private File System）；
   * options.store 为测试注入（直接使用给定存储实例，跳过按后端创建）。
   */
  init(options?: { debounceMs?: number; dbName?: string; storage?: StorageBackend; store?: ProjectStorage }): Promise<void>;
  /**
   * 打开/切换项目（可等待的类型化切换屏障）：替换编辑器前先稳定排空当前项目的
   * 未保存变更（flushPending 稳定排空）。落盘失败时返回 { ok: false } 且不触碰
   * 编辑器 —— 旧项目保持打开，调用方必须阻止切换（内容仍在编辑器/恢复快照中）。
   * options.flush = false 跳过排空屏障：仅用于「内容已另行保全」的复制/另存流程
   * （副本已落盘，旧项目的未保存快照随后由排空任务尽力保存或转为恢复快照）。
   */
  openProject(project: Project, options?: { flush?: boolean }): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * 关闭项目：等待未保存变更全量落盘（排空屏障）后重置编辑器。
   * 落盘失败时返回 { ok: false } 且不重置编辑器（未保存内容仍在编辑器中），
   * 调用方必须阻止关闭/切换。
   */
  closeProject(): Promise<{ ok: boolean; message?: string }>;
  getProject(): Project | null;
  /** 卸载：冲刷未保存变更后释放全部资源。第二十八轮阻断 4 + 第二十九轮阻断 5：
   *  冲刷失败或仍有未解决恢复 fork 时返回 { ok: false, message } 且不 teardown
   *  —— 编辑器与存储保留，调用方（宿主）可重试或引导用户保全内容（另存副本 /
   *  重试保存），绝不「假装已卸载」丢弃未落盘内容；宿主确需放弃时先显式
   *  persistence.clearRecovery 丢弃恢复快照后再重试。 */
  dispose(): Promise<{ ok: boolean; message?: string }>;
}

export function createStudioRuntime(options: StudioRuntimeOptions = {}): StudioRuntime {
  const host = new PluginHost({
    hostVersion: options.hostVersion,
    onError: options.onError,
  });
  const editor = new SceneEditor();
  const persistence = new ProjectPersistence(editor);
  let disposed = false;
  let initialized = false;
  // 第三十一轮严重 3：dispose 幂等合并（single-flight）—— 并发调用共享同一
  // in-flight 执行，成功后永久复用结果；失败 settle 后清空缓存允许重试
  let disposePromise: Promise<{ ok: boolean; message?: string }> | null = null;
  // 第三十二轮严重 4：init 幂等合并 —— 并发 init 共享同一 in-flight 执行
  // （修复前 initialized 在 await 前置位，并发 init 重复创建存储；存储创建
  // 挂起期间 dispose 先成功时，晚到的 persistence.init 会把 store 挂到已销毁
  // 的 persistence，连接泄漏）
  let initPromise: Promise<void> | null = null;
  // 编辑器每次变更（提交/撤销/重做/打开/关闭）都同步宿主快照并广播给插件
  const unsubscribe = editor.events.on('project:changed', ({ project }) => {
    if (disposed) return;
    host.setProject(project);
    host.events.emit('project:changed', { project });
  });
  return {
    host,
    editor,
    persistence,
    get events() {
      return host.events;
    },
    init(options): Promise<void> {
      if (initialized || disposed) return Promise.resolve();
      if (initPromise) return initPromise;
      // 完成标记在 persistence.init 成功后写入（第三十二轮严重 4）：修复前
      // initialized 在 await 前置位 —— 存储创建挂起期间 dispose 先成功时，
      // 晚到的 init 仍标记「已初始化」；持久化层自行关闭晚到 store，此处
      // 以 persistence.init 完成（而非开始）作为真实完成点
      initPromise = (async (): Promise<void> => {
        await persistence.init(options);
        initialized = true;
      })();
      const inFlight = initPromise;
      void inFlight.then(() => {
        if (initPromise === inFlight) initPromise = null;
      });
      return inFlight;
    },
    async openProject(project, options = {}) {
      // 切换屏障：替换编辑器前稳定排空当前项目的未保存变更。失败时旧项目保持打开，
      // 不触碰编辑器（未保存内容仍在编辑器与恢复快照中，调用方必须阻止切换）
      if (options.flush !== false) {
        const current = host.getProject();
        if (current) {
          const outcome = await persistence.flushPending();
          if (!outcome.ok) {
            return { ok: false, message: outcome.message ?? '未保存更改落盘失败' };
          }
        }
      }
      // 编辑器先校验并取得 owned immutable 快照（深克隆 + 冻结），宿主/插件只能拿到
      // 编辑器持有的快照，调用方传入的项目此后与编辑器完全解耦
      editor.openProject(project);
      const owned = editor.getProject()!;
      host.setProject(owned);
      host.events.emit('project:opened', { uri: owned.uri, name: owned.name, project: owned });
      return { ok: true };
    },
    async closeProject() {
      const current = host.getProject();
      if (current) {
        // 先等待未保存变更全量落盘（排空屏障，含在途保存）：失败时保留编辑器
        // 与未保存内容，放行关闭即丢失（恢复快照也不替代「仍在编辑器」的现场）
        const outcome = await persistence.flushPending();
        if (!outcome.ok) return { ok: false, message: outcome.message };
        host.setProject(null);
        host.events.emit('project:closed', { uri: current.uri });
      }
      editor.reset();
      return { ok: true };
    },
    getProject: () => editor.getProject(),
    dispose(): Promise<{ ok: boolean; message?: string }> {
      // 第三十一轮严重 3：成功后永久复用同一成功结果对象（重复调用不再触碰
      // persistence/编辑器/宿主）
      if (disposed) return disposePromise ?? Promise.resolve({ ok: true });
      // 第三十一轮严重 3：幂等合并 —— 并发调用共享同一 in-flight 执行
      // （修复前并发调用都在 disposed 置位前越过守卫，重复冲刷/重复 teardown）；
      // 非 async 直接返回缓存 promise，并发调用拿到同一对象（与 close() 同型）
      if (disposePromise) return disposePromise;
      disposePromise = (async (): Promise<{ ok: boolean; message?: string }> => {
        try {
          // 第二十八轮阻断 4：先冲刷自动保存（flush 需读取未销毁的编辑器），
          // 失败时如实返回且不 teardown —— 不置 disposed/不移监听/不销毁
          // 编辑器与宿主，调用方可重试或引导用户「另存副本」保全未保存内容
          const outcome = await persistence.dispose();
          if (!outcome.ok) return { ok: false, message: outcome.message };
          // 第三十二轮阻断 2：终态释放「可失败者先行」—— 插件停用（可能抛错）
          // 在编辑器销毁前执行。修复前 editor 先销毁、host 后停用：host 失败时
          // 返回 {ok:false} 的「编辑器保留可重试」契约与现场不符（编辑器已销毁），
          // 且插件停用期读到的编辑器已是死实例。全部步骤幂等，完成标记
          // （disposed）在最后写入 —— 失败重试只补做未完成步骤
          await host.dispose();
          unsubscribe.dispose();
          editor.dispose();
          disposed = true;
          return { ok: true };
        } catch (error) {
          // 第三十一轮严重 3：意外拒绝归一为类型化失败 —— 绝不把 unhandled
          // rejection 交给 close() 调用方；失败后 disposed 未置位，可重试
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      })();
      const inFlight = disposePromise;
      // 失败：清空缓存允许重试 —— 仅当 ref 仍指向本次结果（并发调用共享同一
      // promise，慢成员 settle 时不得清掉已在重试的新一轮）
      void inFlight.then((outcome) => {
        if (!outcome.ok && disposePromise === inFlight) disposePromise = null;
      });
      return inFlight;
    },
  };
}
