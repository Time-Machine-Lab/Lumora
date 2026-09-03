import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import {
  Clapperboard,
  Command,
  Download,
  FileInput,
  FolderInput,
  FolderOpen,
  MoreHorizontal,
  Puzzle,
  Redo2,
  Undo2,
  X,
} from 'lucide-react';
import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import type { StudioRuntime } from '../runtime/studio-runtime';
import type { EditorState } from '../hooks/use-scene-editor';
import { useEventRefresh } from '../hooks/use-event-refresh';
import type { ContentCache } from './editor/content-cache';
import { importModelFile } from './editor/model-import';
import { showToast } from './editor/toasts';
import { ProjectMenu } from './ProjectMenu';
import { stopActivationKeyPropagation } from './studio-keyboard-scope';

interface ToolbarProps {
  runtime: StudioRuntime;
  project: Project | null;
  editorState: EditorState;
  cache: ContentCache;
  storyboardOpen: boolean;
  exportOpen: boolean;
  exportButtonRef: RefObject<HTMLButtonElement | null>;
  paletteButtonRef: RefObject<HTMLButtonElement | null>;
  pluginButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleStoryboard: () => void;
  onToggleExport: () => void;
  onTogglePlugins: () => void;
  onTogglePalette: () => void;
}

export function Toolbar({
  runtime,
  project,
  editorState,
  cache,
  storyboardOpen,
  exportOpen,
  exportButtonRef,
  paletteButtonRef,
  pluginButtonRef,
  onToggleStoryboard,
  onToggleExport,
  onTogglePlugins,
  onTogglePalette,
}: ToolbarProps) {
  useEventRefresh(runtime.events, ['contribution:changed', 'command:changed']);
  const toolbars = runtime.host.contributions.getToolbars();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const editor = runtime.editor;
  const { canUndo, canRedo, undoLabel, redoLabel } = editorState;

  useEffect(() => {
    if (!moreOpen) return;
    moreMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || toolbarRef.current?.contains(event.target)) return;
      const targetElement = event.target instanceof Element ? event.target : event.target.parentElement;
      if (targetElement?.closest('.lumora-modal-backdrop')) return;
      setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [moreOpen]);

  const handleImportFile = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const result = await importModelFile(editor, cache, Array.from(files));
    if (result.ok) {
      showToast(`已导入模型「${result.asset.name}」${result.deduped ? '（内容相同，资源已复用）' : ''}`, 'success');
    } else {
      showToast(result.error.message, 'error');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const closeMoreThen = (action: () => void) => {
    setMoreOpen(false);
    action();
  };
  const menuRole = moreOpen ? 'menuitem' : undefined;
  const handleMoreMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!moreOpen || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(
      moreMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
    else if (event.key === 'ArrowDown') next = current < 0 || current === items.length - 1 ? 0 : current + 1;
    items[next]?.focus();
  };

  return (
    <header
      ref={toolbarRef}
      className="lumora-toolbar"
      data-testid="lumora-toolbar"
      inert={storyboardOpen || exportOpen || undefined}
    >
      <span className="lumora-toolbar__brand">Lumora</span>
      <div className="lumora-toolbar__actions">
        <ProjectMenu runtime={runtime} project={project} />
        <button
          type="button"
          className="lumora-button lumora-toolbar__primary-button"
          data-testid="undo"
          disabled={!canUndo || !project}
          aria-label={undoLabel ? `撤销：${undoLabel}` : '撤销'}
          title={undoLabel ? `撤销：${undoLabel}` : '撤销'}
          onClick={() => {
            const result = editor.undo();
            if (!result.ok) showToast(result.error.message, 'error');
          }}
        >
          <Undo2 aria-hidden="true" />
          <span>撤销</span>
        </button>
        <button
          type="button"
          className="lumora-button lumora-toolbar__primary-button"
          data-testid="redo"
          disabled={!canRedo || !project}
          aria-label={redoLabel ? `重做：${redoLabel}` : '重做'}
          title={redoLabel ? `重做：${redoLabel}` : '重做'}
          onClick={() => {
            const result = editor.redo();
            if (!result.ok) showToast(result.error.message, 'error');
          }}
        >
          <Redo2 aria-hidden="true" />
          <span>重做</span>
        </button>
        <button
          type="button"
          className={`lumora-button lumora-toolbar__primary-button${storyboardOpen ? ' lumora-button--active' : ''}`}
          data-testid="open-storyboard-workspace"
          aria-label="AI 分镜"
          aria-pressed={storyboardOpen}
          disabled={!project}
          onClick={onToggleStoryboard}
        >
          <Clapperboard aria-hidden="true" />
          <span>AI 分镜</span>
        </button>
        <button
          ref={exportButtonRef}
          type="button"
          className={`lumora-button lumora-toolbar__primary-button${exportOpen ? ' lumora-button--active' : ''}`}
          data-testid="open-export-workspace"
          aria-label="导出"
          aria-pressed={exportOpen}
          disabled={!project}
          onKeyDown={stopActivationKeyPropagation}
          onClick={onToggleExport}
        >
          <Download aria-hidden="true" />
          <span>导出</span>
        </button>
        <button
          ref={moreButtonRef}
          type="button"
          className="lumora-button lumora-toolbar__more"
          data-testid="toolbar-more"
          aria-label="更多操作"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>

        <div
          ref={moreMenuRef}
          className={`lumora-toolbar__secondary${moreOpen ? ' lumora-toolbar__secondary--open' : ''}`}
          role={moreOpen ? 'menu' : undefined}
          aria-label={moreOpen ? '更多操作' : undefined}
          onKeyDown={handleMoreMenuKeyDown}
        >
          <button
            type="button"
            role={menuRole}
            className="lumora-button"
            data-testid="open-sample-project"
            onClick={() => closeMoreThen(() => {
              void runtime.openProject(createSampleProject()).then((result) => {
                if (!result.ok) showToast(`无法打开示例项目：${result.message}`, 'error');
              });
            })}
          >
            <FolderOpen aria-hidden="true" />
            <span>打开示例项目</span>
          </button>
          <button
            type="button"
            role={menuRole}
            className="lumora-button"
            data-testid="close-project"
            onClick={() => closeMoreThen(() => runtime.closeProject())}
            disabled={!project}
          >
            <X aria-hidden="true" />
            <span>关闭项目</span>
          </button>
          <span className="lumora-toolbar__sep" />
          <button
            type="button"
            role={menuRole}
            className="lumora-button lumora-button--import"
            data-testid="import-model"
            disabled={!project}
            onClick={() => fileInputRef.current?.click()}
          >
            <FileInput aria-hidden="true" />
            <span>导入模型</span>
          </button>
          <button
            type="button"
            role={menuRole}
            className="lumora-button lumora-button--import"
            data-testid="import-model-dir"
            disabled={!project}
            title="整目录选择：.gltf 的外部依赖按目录相对路径导入"
            onClick={() => dirInputRef.current?.click()}
          >
            <FolderInput aria-hidden="true" />
            <span>导入模型目录</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".glb,.gltf,.bin,model/gltf-binary,model/gltf+json,application/octet-stream,image/png,image/jpeg,image/webp,image/gif"
            hidden
            data-testid="toolbar-model-file-input"
            onChange={(event) => void handleImportFile(event.target.files)}
          />
          <input
            ref={dirInputRef}
            type="file"
            multiple
            {...({ webkitdirectory: '' } as Record<string, string>)}
            accept=".glb,.gltf,.bin,model/gltf-binary,model/gltf+json,application/octet-stream,image/png,image/jpeg,image/webp,image/gif"
            hidden
            data-testid="toolbar-model-dir-input"
            onChange={(event) => void handleImportFile(event.target.files)}
          />
          {toolbars.map((item) => {
            const command = runtime.host.commands.get(item.commandId);
            return (
              <button
                key={item.id}
                type="button"
                role={menuRole}
                className="lumora-button lumora-button--plugin"
                data-testid={`toolbar-${item.id}`}
                title={item.tooltip ?? item.label}
                disabled={!command}
                onClick={() => closeMoreThen(() => void runtime.host.commands.execute(item.commandId))}
              >
                {item.label}
              </button>
            );
          })}
          <button
            ref={paletteButtonRef}
            type="button"
            role={menuRole}
            className="lumora-button"
            data-testid="open-command-palette"
            onClick={onTogglePalette}
          >
            <Command aria-hidden="true" />
            <span>命令</span>
            <kbd>Ctrl+K</kbd>
          </button>
          <button
            ref={pluginButtonRef}
            type="button"
            role={menuRole}
            className="lumora-button"
            data-testid="open-plugin-manager"
            onClick={onTogglePlugins}
          >
            <Puzzle aria-hidden="true" />
            <span>插件管理</span>
          </button>
        </div>
      </div>
      <span className="lumora-toolbar__version">v{runtime.host.hostVersion}</span>
    </header>
  );
}
