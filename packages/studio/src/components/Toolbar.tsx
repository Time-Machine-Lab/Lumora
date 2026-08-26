import { useRef } from 'react';
import type { RefObject } from 'react';
import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import type { StudioRuntime } from '../runtime/studio-runtime';
import type { EditorState } from '../hooks/use-scene-editor';
import { useEventRefresh } from '../hooks/use-event-refresh';
import type { ContentCache } from './editor/content-cache';
import { importModelFile } from './editor/model-import';
import { showToast } from './editor/toasts';
import { ProjectMenu } from './ProjectMenu';

interface ToolbarProps {
  runtime: StudioRuntime;
  project: Project | null;
  editorState: EditorState;
  cache: ContentCache;
  storyboardOpen: boolean;
  exportOpen: boolean;
  exportButtonRef: RefObject<HTMLButtonElement | null>;
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
  onToggleStoryboard,
  onToggleExport,
  onTogglePlugins,
  onTogglePalette,
}: ToolbarProps) {
  useEventRefresh(runtime.events, ['contribution:changed', 'command:changed']);
  const toolbars = runtime.host.contributions.getToolbars();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const editor = runtime.editor;
  const { canUndo, canRedo, undoLabel, redoLabel } = editorState;

  // 全量文件列表交给导入流程：.gltf 与外部 .bin/纹理一起选中时组成多文件导入
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

  return (
    <header className="lumora-toolbar" data-testid="lumora-toolbar" inert={storyboardOpen || exportOpen || undefined}>
      <span className="lumora-toolbar__brand">Lumora Studio</span>
      <div className="lumora-toolbar__actions">
        <ProjectMenu runtime={runtime} project={project} />
        <button
          type="button"
          className="lumora-button"
          data-testid="open-sample-project"
          onClick={() => {
            // 切换屏障：旧项目未保存变更排空失败时保持旧项目打开
            void runtime.openProject(createSampleProject()).then((result) => {
              if (!result.ok) showToast(`无法打开示例项目：${result.message}`, 'error');
            });
          }}
        >
          打开示例项目
        </button>
        <button
          type="button"
          className="lumora-button"
          data-testid="close-project"
          onClick={() => runtime.closeProject()}
          disabled={!project}
        >
          关闭项目
        </button>
        <span className="lumora-toolbar__sep" />
        <button
          type="button"
          className="lumora-button"
          data-testid="undo"
          disabled={!canUndo || !project}
          title={undoLabel ? `撤销：${undoLabel}` : '撤销'}
          onClick={() => {
            const result = editor.undo();
            if (!result.ok) showToast(result.error.message, 'error');
          }}
        >
          撤销
        </button>
        <button
          type="button"
          className="lumora-button"
          data-testid="redo"
          disabled={!canRedo || !project}
          title={redoLabel ? `重做：${redoLabel}` : '重做'}
          onClick={() => {
            const result = editor.redo();
            if (!result.ok) showToast(result.error.message, 'error');
          }}
        >
          重做
        </button>
        <button
          type="button"
          className="lumora-button lumora-button--import"
          data-testid="import-model"
          disabled={!project}
          onClick={() => fileInputRef.current?.click()}
        >
          导入模型
        </button>
        <button
          type="button"
          className="lumora-button lumora-button--import"
          data-testid="import-model-dir"
          disabled={!project}
          title="整目录选择：.gltf 的外部依赖按目录相对路径导入（嵌套目录/重名文件不丢失路径信息）"
          onClick={() => dirInputRef.current?.click()}
        >
          导入模型目录
        </button>
        <button
          type="button"
          className={`lumora-button${storyboardOpen ? ' lumora-button--active' : ''}`}
          data-testid="open-storyboard-workspace"
          aria-pressed={storyboardOpen}
          disabled={!project}
          onClick={onToggleStoryboard}
        >
          AI 分镜
        </button>
        <button
          ref={exportButtonRef}
          type="button"
          className={`lumora-button${exportOpen ? ' lumora-button--active' : ''}`}
          data-testid="open-export-workspace"
          aria-pressed={exportOpen}
          disabled={!project}
          onClick={onToggleExport}
        >
          导出
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".glb,.gltf,.bin,model/gltf-binary,model/gltf+json,application/octet-stream,image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          data-testid="toolbar-model-file-input"
          onChange={(e) => void handleImportFile(e.target.files)}
        />
        <input
          ref={dirInputRef}
          type="file"
          multiple
          // 目录选择：浏览器为每个文件填充 webkitRelativePath，
          // importModelFile 据此保留嵌套目录相对路径（R6，TML-57 第六轮）
          {...({ webkitdirectory: '' } as Record<string, string>)}
          accept=".glb,.gltf,.bin,model/gltf-binary,model/gltf+json,application/octet-stream,image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          data-testid="toolbar-model-dir-input"
          onChange={(e) => void handleImportFile(e.target.files)}
        />
        {toolbars.map((item) => {
          const command = runtime.host.commands.get(item.commandId);
          return (
            <button
              key={item.id}
              type="button"
              className="lumora-button lumora-button--plugin"
              data-testid={`toolbar-${item.id}`}
              title={item.tooltip ?? item.label}
              disabled={!command}
              onClick={() => void runtime.host.commands.execute(item.commandId)}
            >
              {item.label}
            </button>
          );
        })}
        <button
          type="button"
          className="lumora-button"
          data-testid="open-command-palette"
          onClick={onTogglePalette}
        >
          命令 (Ctrl+K)
        </button>
        <button
          type="button"
          className="lumora-button"
          data-testid="open-plugin-manager"
          onClick={onTogglePlugins}
        >
          插件管理
        </button>
      </div>
      <span className="lumora-toolbar__version">v{runtime.host.hostVersion}</span>
    </header>
  );
}
