import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { MAX_PACKAGE_TEXT_BYTES, genId } from '@lumora/core';
import type { Project } from '@lumora/core';
import type { StudioRuntime } from '../runtime/studio-runtime';
import type { AutosaveState } from '../persistence/autosave';
import type { ProjectSummary } from '../persistence/project-store';
import { showToast } from './editor/toasts';

interface ProjectMenuProps {
  runtime: StudioRuntime;
  project: Project | null;
}

type ModalState = { kind: 'create' } | { kind: 'rename'; uri: string; initial: string };

/** 保存状态 → 状态徽标文案 */
function saveBadge(state: AutosaveState): { text: string; tone: 'clean' | 'dirty' | 'error' | 'memory' } | null {
  switch (state.status) {
    case 'idle':
      return null;
    case 'clean':
      return { text: '已保存', tone: 'clean' };
    case 'dirty':
      return { text: '未保存更改', tone: 'dirty' };
    case 'saving':
      return { text: '保存中…', tone: 'dirty' };
    case 'error':
      return { text: '保存失败', tone: 'error' };
    case 'memory':
      return { text: '仅内存（未持久化）', tone: 'memory' };
  }
}

/** Tab 焦点圈闭（模态对话框）：焦点在首/末元素时循环，不逃逸到背景 */
function trapTabFocus(event: React.KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter(
    (element) => !('disabled' in element && (element as HTMLInputElement).disabled) && element.offsetParent !== null,
  );
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 读取文件为文本：jsdom/部分 WebView 无 Blob.text()，统一走 FileReader */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('无法读取文件内容'));
    reader.readAsText(file);
  });
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ProjectMenu({ runtime, project }: ProjectMenuProps) {
  const persistence = runtime.persistence;
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [saveState, setSaveState] = useState<AutosaveState>({ status: 'idle' });
  const [modal, setModal] = useState<ModalState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // 窄屏下面板为 fixed 定位，垂直位置按按钮实测（视口坐标系）设置
  const [dropdownTop, setDropdownTop] = useState<number | null>(null);

  useEffect(() => {
    const unsubscribe = persistence.events.on('save-state', ({ state }) => setSaveState(state));
    return () => {
      unsubscribe.dispose();
    };
  }, [persistence]);

  const refreshRecent = async () => {
    setRecent(await persistence.listRecent());
  };

  const toggleMenu = () => {
    const next = !open;
    if (next) {
      void refreshRecent();
      const button = menuButtonRef.current;
      if (button) setDropdownTop(button.getBoundingClientRect().bottom + 6);
    }
    setOpen(next);
  };

  const openRecent = async (summary: ProjectSummary) => {
    setBusy(true);
    try {
      const loaded = await persistence.loadProject(summary.uri);
      if (!loaded.ok) {
        showToast(loaded.message, 'error');
        void refreshRecent();
        return;
      }
      runtime.openProject(loaded.project);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (name: string) => {
    setModal(null);
    setOpen(false);
    runtime.openProject(persistence.createProject(name));
    menuButtonRef.current?.focus();
    showToast(`已新建项目「${name}」`, 'success');
  };

  const renameProject = async (uri: string, name: string) => {
    setModal(null);
    setBusy(true);
    try {
      const result = await persistence.renameProject(uri, name);
      if (result.ok) {
        showToast(`已重命名为「${name.trim()}」`, 'success');
        void refreshRecent();
      } else {
        showToast(result.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const duplicateProject = async (uri: string) => {
    setBusy(true);
    try {
      const result = await persistence.duplicateProject(uri);
      if (!result.ok) {
        showToast(result.message, 'error');
        return;
      }
      const loaded = await persistence.loadProject(result.summary.uri);
      if (loaded.ok) runtime.openProject(loaded.project);
      showToast(`已复制为「${result.summary.name}」`, 'success');
      void refreshRecent();
    } finally {
      setBusy(false);
    }
  };

  const deleteProject = async (summary: ProjectSummary) => {
    setPendingDelete(null);
    setBusy(true);
    try {
      if (project?.uri === summary.uri) {
        // 关闭即丢弃未保存内容：落盘失败时必须中止删除（内容仍在编辑器/恢复快照中）
        const closed = await runtime.closeProject();
        if (!closed.ok) {
          showToast(`无法删除：${closed.message ?? '未保存更改落盘失败'}`, 'error');
          return;
        }
      }
      await persistence.deleteProject(summary.uri);
      showToast(`已删除「${summary.name}」`, 'success');
      void refreshRecent();
    } finally {
      setBusy(false);
    }
  };

  const exportCurrent = async () => {
    const exported = persistence.exportCurrent();
    if (!exported.ok) {
      showToast(exported.message, 'error');
      return;
    }
    const estimate = await persistence.estimateQuota();
    if (estimate && exported.bytes > estimate.quota - estimate.usage) {
      showToast('导出大小接近本地存储配额上限，建议尽快迁移备份', 'error');
    }
    downloadText(exported.text, exported.filename);
    showToast(`已导出工程包「${exported.filename}」`, 'success');
  };

  const importPackage = async (file: File) => {
    if (importInputRef.current) importInputRef.current.value = '';
    // 先于读取的字节量预检（与解析端的文本长度上限一致，拒绝超长文件解码攻击）
    if (file.size > MAX_PACKAGE_TEXT_BYTES) {
      showToast(`文件过大（${Math.ceil(file.size / 1024 / 1024)} MB），无法导入`, 'error');
      return;
    }
    setBusy(true);
    try {
      const text = await readFileText(file);
      const imported = await persistence.importPackage(text);
      if (!imported.ok) {
        // 可操作错误明细：损坏原因 + 处理建议（AC3）
        showToast(`导入失败：${imported.error.message}`, 'error');
        return;
      }
      let restored = imported.project;
      // 本地已存在同 uri 项目：视为副本导入，避免后续自动保存覆盖本地记录
      if (await persistence.hasLocal(restored.uri)) {
        restored = { ...restored, uri: `lumora://project/${genId('p')}`, name: `${restored.name}（导入）` };
      }
      runtime.openProject(restored);
      setOpen(false);
      menuButtonRef.current?.focus();
      if (imported.warnings.length > 0) {
        const names = imported.warnings.map((w) => w.name).join('、');
        showToast(`已导入；${imported.warnings.length} 个资产内容缺失（${names}）`, 'error');
      } else {
        showToast(`已导入项目「${restored.name}」`, 'success');
      }
    } catch (error) {
      showToast(`读取文件失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 冲突解决「加载较新版本」：以本地保存内容为基线重开（显式丢弃未保存更改） */
  const resolveConflict = async () => {
    setBusy(true);
    try {
      const result = await persistence.reloadOpenProject();
      if (!result.ok) {
        showToast(result.message, 'error');
        return;
      }
      showToast('已加载本地较新版本', 'success');
    } finally {
      setBusy(false);
    }
  };

  /** 冲突/恢复解决「另存副本」：未保存内容另存为新项目并打开 */
  const saveAsCopy = async () => {
    if (!project) return;
    setBusy(true);
    try {
      // 恢复快照可用时以恢复快照为准（切换/关闭时保存失败被保留的内容）；
      // 否则以当前编辑器内容为准（冲突/配额失败时的现场）
      const recovery = persistence.getRecoverySnapshot(project.uri);
      if (recovery) {
        const saved = await persistence.saveSnapshotAsNew(recovery);
        if (!saved.ok) {
          showToast(saved.message, 'error');
          return;
        }
        persistence.clearRecovery(project.uri);
        runtime.openProject(saved.project);
        setOpen(false);
        showToast(`未保存更改已另存为「${saved.project.name}」`, 'success');
        void refreshRecent();
        return;
      }
      const dup = await persistence.duplicateProject(project.uri);
      if (!dup.ok) {
        showToast(dup.message, 'error');
        return;
      }
      const loaded = await persistence.loadProject(dup.summary.uri);
      if (loaded.ok) runtime.openProject(loaded.project);
      setOpen(false);
      showToast(`未保存更改已另存为「${dup.summary.name}」`, 'success');
      void refreshRecent();
    } finally {
      setBusy(false);
    }
  };

  const badge = saveBadge(saveState);
  const currentUri = project?.uri ?? null;

  return (
    <div className="lumora-project-menu">
      <button
        ref={menuButtonRef}
        type="button"
        className="lumora-button"
        data-testid="project-menu"
        aria-expanded={open}
        onClick={toggleMenu}
      >
        项目
      </button>
      {badge && (
        <span className={`lumora-project-menu__badge lumora-project-menu__badge--${badge.tone}`} data-testid="save-state-badge">
          {badge.text}
          {saveState.status === 'error' && (
            <span className="lumora-project-menu__error-actions">
              <button
                type="button"
                className="lumora-project-menu__retry"
                data-testid="save-reload"
                title="以本地较新保存内容为准，丢弃未保存更改"
                onClick={() => void resolveConflict()}
              >
                加载较新版本
              </button>
              <button
                type="button"
                className="lumora-project-menu__retry"
                data-testid="save-saveas"
                title="将当前未保存内容另存为新项目"
                onClick={() => void saveAsCopy()}
              >
                另存副本
              </button>
              <button
                type="button"
                className="lumora-project-menu__retry"
                data-testid="save-retry"
                onClick={() => {
                  if (saveState.status === 'error' && saveState.code === 'recovery-available' && project) {
                    void persistence.retryRecovery(project.uri).then((result) => {
                      showToast(result.ok ? '恢复快照已重新保存' : `重试失败：${result.message}`, result.ok ? 'success' : 'error');
                    });
                  } else {
                    void persistence.flushPending().then((result) => {
                      if (!result.ok) showToast(`保存失败：${result.message}`, 'error');
                    });
                  }
                }}
              >
                重试
              </button>
            </span>
          )}
        </span>
      )}
      {open && (
        <div
          className="lumora-project-menu__dropdown"
          data-testid="project-menu-dropdown"
          style={dropdownTop !== null ? ({ '--lumora-menu-top': `${dropdownTop}px` } as CSSProperties) : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              menuButtonRef.current?.focus();
            }
          }}
        >
          <div className="lumora-project-menu__actions">
            <button type="button" className="lumora-button" data-testid="project-new" onClick={() => setModal({ kind: 'create' })}>
              新建项目
            </button>
            <button
              type="button"
              className="lumora-button"
              data-testid="project-import"
              disabled={busy}
              onClick={() => importInputRef.current?.click()}
            >
              导入工程包…
            </button>
            <button
              type="button"
              className="lumora-button"
              data-testid="project-export"
              disabled={!project}
              onClick={() => void exportCurrent()}
            >
              导出工程包…
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".lumora,application/json"
              style={{ display: 'none' }}
              data-testid="project-import-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importPackage(file);
              }}
            />
          </div>
          <div className="lumora-project-menu__recent">
            <div className="lumora-project-menu__recent-title">最近项目</div>
            {recent.length === 0 && <div className="lumora-project-menu__recent-empty">暂无本地项目</div>}
            {recent.map((summary) => (
              <div key={summary.uri} className="lumora-project-menu__recent-item" data-testid="recent-project">
                <button
                  type="button"
                  className="lumora-project-menu__recent-open"
                  disabled={busy || summary.uri === currentUri}
                  title={summary.uri === currentUri ? '当前打开中' : undefined}
                  onClick={() => void openRecent(summary)}
                >
                  <span className="lumora-project-menu__recent-name">{summary.name}</span>
                  <span className="lumora-project-menu__recent-meta">
                    {new Date(summary.savedAt).toLocaleString()} · r{summary.revision}
                  </span>
                </button>
                <button
                  type="button"
                  className="lumora-project-menu__recent-rename"
                  data-testid="recent-rename"
                  title="重命名"
                  onClick={() => setModal({ kind: 'rename', uri: summary.uri, initial: summary.name })}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="lumora-project-menu__recent-dup"
                  data-testid="recent-duplicate"
                  title="复制"
                  onClick={() => void duplicateProject(summary.uri)}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="lumora-project-menu__recent-del"
                  data-testid="recent-delete"
                  title="删除"
                  onClick={() => setPendingDelete(summary)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {modal && (
        <ProjectNameModal
          title={modal.kind === 'create' ? '新建项目' : '重命名项目'}
          initial={modal.kind === 'rename' ? modal.initial : '未命名项目'}
          confirmLabel={modal.kind === 'create' ? '新建' : '重命名'}
          busy={busy}
          onCancel={() => setModal(null)}
          onConfirm={(name) => {
            if (modal.kind === 'create') void createProject(name);
            else void renameProject(modal.uri, name);
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          name={pendingDelete.name}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteProject(pendingDelete)}
        />
      )}
    </div>
  );
}

interface ProjectNameModalProps {
  title: string;
  initial: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

function ProjectNameModal({ title, initial, confirmLabel, busy, onCancel, onConfirm }: ProjectNameModalProps) {
  const titleId = useId();
  const inputId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);
  const trimmed = name.trim();
  return (
    <div className="lumora-project-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="project-dialog">
      <div className="lumora-project-dialog__box" ref={boxRef} onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // 对话框内 Escape 自行消化：不得冒泡到全局键处理（会误清编辑器选择）
          e.stopPropagation();
          e.preventDefault();
          onCancel();
          return;
        }
        trapTabFocus(e, boxRef.current);
      }}>
        <div className="lumora-project-dialog__title" id={titleId}>{title}</div>
        <label className="lumora-project-dialog__label" htmlFor={inputId}>项目名称</label>
        <input
          ref={inputRef}
          id={inputId}
          className="lumora-project-dialog__input"
          data-testid="project-name-input"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed) onConfirm(name);
          }}
        />
        <div className="lumora-project-dialog__actions">
          <button type="button" className="lumora-button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="lumora-button"
            data-testid="project-name-confirm"
            disabled={!trimmed || busy}
            onClick={() => onConfirm(name)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmDeleteDialogProps {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDeleteDialog({ name, busy, onCancel, onConfirm }: ConfirmDeleteDialogProps) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);
  return (
    <div className="lumora-project-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="delete-dialog">
      <div className="lumora-project-dialog__box" ref={boxRef} onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // 对话框内 Escape 自行消化：不得冒泡到全局键处理（会误清编辑器选择）
          e.stopPropagation();
          e.preventDefault();
          onCancel();
          return;
        }
        trapTabFocus(e, boxRef.current);
      }}>
        <div className="lumora-project-dialog__title" id={titleId}>删除项目</div>
        <p className="lumora-project-dialog__body">
          确定删除「{name}」吗？本地保存的数据将被移除，此操作不可撤销。
        </p>
        <div className="lumora-project-dialog__actions">
          <button ref={cancelRef} type="button" className="lumora-button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="lumora-button lumora-button--danger"
            data-testid="confirm-delete"
            disabled={busy}
            onClick={onConfirm}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
