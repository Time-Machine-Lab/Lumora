import { useRef, useState } from 'react';
import {
  createCameraObject,
  createGroupObject,
  createLightObject,
  createPrimitiveObject,
  findObject,
} from '@lumora/core';
import type { Project, SceneEditor, SceneObjectData } from '@lumora/core';
import type { AssetCache } from './asset-cache';
import { importModelFile } from './model-import';
import { showToast } from './toasts';

interface ObjectTreeProps {
  editor: SceneEditor;
  project: Project | null;
  selection: string[];
  cache: AssetCache;
}

const TYPE_LABEL: Record<SceneObjectData['type'], string> = {
  group: '组',
  model: '模型',
  primitive: '几何体',
  light: '灯光',
  camera: '摄像机',
};

const ADD_ITEMS: { label: string; create: () => SceneObjectData }[] = [
  { label: '组', create: () => createGroupObject() },
  { label: '立方体', create: () => createPrimitiveObject('box') },
  { label: '球体', create: () => createPrimitiveObject('sphere') },
  { label: '圆锥体', create: () => createPrimitiveObject('cone') },
  { label: '圆环', create: () => createPrimitiveObject('torus') },
  { label: '平面', create: () => createPrimitiveObject('plane') },
  { label: '平行光', create: () => createLightObject('directional') },
  { label: '点光源', create: () => createLightObject('point') },
  { label: '聚光灯', create: () => createLightObject('spot') },
  { label: '摄像机', create: () => createCameraObject() },
];

/** 对象层级树：选择/可见/锁定/重命名/拖拽重排/删除，顶部提供场景切换与添加菜单 */
export function ObjectTree({ editor, project, selection, cache }: ObjectTreeProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  if (!project) return null;
  const scene = project.scenes.find((s) => s.id === project.activeSceneId) ?? project.scenes[0];
  const roots = scene
    ? scene.rootObjectIds
        .map((id) => findObject(project, id))
        .filter((o): o is SceneObjectData => !!o)
    : [];

  // 默认展开（expanded 未记录时视为 true），首次折叠要翻到 false
  const toggleExpanded = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));

  // 键盘导航用的可见行扁平顺序（roving tabindex 的邻居计算）
  const flatRows: string[] = [];
  const collectVisible = (object: SceneObjectData): void => {
    flatRows.push(object.id);
    if (expanded[object.id] ?? true) {
      for (const child of project.objects.filter((o) => o.parentId === object.id)) collectVisible(child);
    }
  };
  for (const root of roots) collectVisible(root);

  const focusRow = (id: string) => rowRefs.current[id]?.focus();

  const handleRowKeyDown = (object: SceneObjectData, event: React.KeyboardEvent) => {
    const index = flatRows.indexOf(object.id);
    const children = project.objects.filter((o) => o.parentId === object.id);
    const isExpanded = expanded[object.id] ?? true;
    const moveTo = (id: string) => {
      editor.setSelection([id]);
      focusRow(id);
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (index < flatRows.length - 1) moveTo(flatRows[index + 1]!);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (index > 0) moveTo(flatRows[index - 1]!);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (children.length > 0 && !isExpanded) toggleExpanded(object.id);
        else if (children.length > 0 && index < flatRows.length - 1) moveTo(flatRows[index + 1]!);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (children.length > 0 && isExpanded) toggleExpanded(object.id);
        else if (object.parentId) moveTo(object.parentId);
        break;
      case 'Home':
        event.preventDefault();
        if (flatRows.length > 0) moveTo(flatRows[0]!);
        break;
      case 'End':
        event.preventDefault();
        if (flatRows.length > 0) moveTo(flatRows[flatRows.length - 1]!);
        break;
      case 'F2':
        event.preventDefault();
        setRenamingId(object.id);
        break;
      case 'Enter':
        event.preventDefault();
        editor.setSelection([object.id]);
        break;
      default:
        break;
    }
  };

  // 行内无选择时树首行也作为 tab 停靠点，键盘用户可进入
  const rowTabIndex = (id: string) =>
    selection.includes(id) ? 0 : selection.length === 0 && flatRows[0] === id ? 0 : -1;

  const handleDrop = (targetId: string) => {
    setDropTargetId(null);
    const dragged = dragId;
    setDragId(null);
    if (!dragged || dragged === targetId) return;
    const result = editor.setParent(dragged, targetId);
    if (!result.ok) showToast(result.error.message, 'error');
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    const result = await importModelFile(editor, cache, file);
    if (result.ok) {
      showToast(`已导入模型「${result.asset.name}」${result.deduped ? '（内容相同，资源已复用）' : ''}`, 'success');
    } else {
      showToast(result.error.message, 'error');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <aside className="lumora-tree" data-testid="lumora-tree" aria-label="对象层级">
      <div className="lumora-tree__header">
        <select
          className="lumora-select"
          data-testid="scene-switcher"
          value={project.activeSceneId}
          onChange={(e) => {
            const result = editor.setActiveScene(e.target.value);
            if (!result.ok) showToast(result.error.message, 'error');
          }}
        >
          {project.scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="lumora-button lumora-button--add"
          data-testid="add-object"
          onClick={() => setAddMenuOpen((open) => !open)}
        >
          ＋ 添加
        </button>
        {addMenuOpen && (
          <div className="lumora-menu" data-testid="add-menu">
            {ADD_ITEMS.map((item) => (
              <button
                key={item.label}
                type="button"
                className="lumora-menu__item"
                data-testid={`add-${item.label}`}
                onClick={() => {
                  setAddMenuOpen(false);
                  const result = editor.addObject(item.create());
                  if (!result.ok) showToast(result.error.message, 'error');
                }}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              className="lumora-menu__item"
              data-testid="add-import-model"
              onClick={() => {
                setAddMenuOpen(false);
                fileInputRef.current?.click();
              }}
            >
              导入模型 (GLB/GLTF)…
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
          style={{ display: 'none' }}
          data-testid="model-file-input"
          onChange={(e) => void handleImportFile(e.target.files?.[0])}
        />
      </div>
      <div className="lumora-tree__list" role="tree">
        {roots.length === 0 && (
          <div className="lumora-tree__empty" data-testid="tree-empty">
            场景为空 —— 点击「＋ 添加」创建对象
          </div>
        )}
        {roots.map((object) => (
          <TreeNode
            key={object.id}
            editor={editor}
            project={project}
            object={object}
            depth={0}
            selection={selection}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            deleteConfirmId={deleteConfirmId}
            setDeleteConfirmId={setDeleteConfirmId}
            setDragId={setDragId}
            dropTargetId={dropTargetId}
            setDropTargetId={setDropTargetId}
            handleDrop={handleDrop}
            rowRefs={rowRefs}
            getRowTabIndex={rowTabIndex}
            onRowKeyDown={handleRowKeyDown}
          />
        ))}
      </div>
    </aside>
  );
}

function TreeNode({
  editor,
  project,
  object,
  depth,
  selection,
  expanded,
  toggleExpanded,
  renamingId,
  setRenamingId,
  deleteConfirmId,
  setDeleteConfirmId,
  setDragId,
  dropTargetId,
  setDropTargetId,
  handleDrop,
  rowRefs,
  getRowTabIndex,
  onRowKeyDown,
}: {
  editor: SceneEditor;
  project: Project;
  object: SceneObjectData;
  depth: number;
  selection: string[];
  expanded: Record<string, boolean>;
  toggleExpanded: (id: string) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  deleteConfirmId: string | null;
  setDeleteConfirmId: (id: string | null) => void;
  setDragId: (id: string | null) => void;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  handleDrop: (targetId: string) => void;
  rowRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
  getRowTabIndex: (id: string) => number;
  onRowKeyDown: (object: SceneObjectData, event: React.KeyboardEvent) => void;
}) {
  const children = project.objects.filter((o) => o.parentId === object.id);
  const isExpanded = expanded[object.id] ?? true;
  const isSelected = selection.includes(object.id);
  const isRenaming = renamingId === object.id;
  const isDeleteConfirming = deleteConfirmId === object.id;
  const isDragOver = dropTargetId === object.id;

  const select = (event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(editor.getSelection());
      if (next.has(object.id)) next.delete(object.id);
      else next.add(object.id);
      editor.setSelection([...next]);
    } else {
      editor.setSelection([object.id]);
    }
  };

  const commitRename = (value: string) => {
    setRenamingId(null);
    const name = value.trim();
    if (!name || name === object.name) return;
    const result = editor.updateObjectProps(object.id, (o) => ({ ...o, name }), '重命名');
    if (!result.ok) showToast(result.error.message, 'error');
  };

  return (
    <div className="lumora-tree__node-wrap">
      <div
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={children.length > 0 ? isExpanded : undefined}
        data-testid={`tree-row-${object.id}`}
        className={`lumora-tree-row${isSelected ? ' lumora-tree-row--selected' : ''}${isDragOver ? ' lumora-tree-row--drop-target' : ''}`}
        style={{ paddingLeft: 6 + depth * 16 }}
        draggable
        tabIndex={getRowTabIndex(object.id)}
        ref={(el) => {
          rowRefs.current[object.id] = el;
        }}
        onKeyDown={(event) => onRowKeyDown(object, event)}
        onClick={select}
        onDoubleClick={() => {
          setRenamingId(object.id);
        }}
        onDragStart={(e) => {
          e.stopPropagation();
          setDragId(object.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropTargetId(object.id);
        }}
        onDragLeave={() => {
          if (dropTargetId === object.id) setDropTargetId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleDrop(object.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropTargetId(null);
        }}
      >
        <button
          type="button"
          className={`lumora-tree-row__chevron${children.length === 0 ? ' lumora-tree-row__chevron--leaf' : ''}`}
          data-testid={`tree-toggle-${object.id}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(object.id);
          }}
          aria-label={isExpanded ? '折叠' : '展开'}
        >
          {children.length > 0 && (isExpanded ? '▾' : '▸')}
        </button>
        <span className={`lumora-tree-row__type lumora-tree-row__type--${object.type}`}>
          {TYPE_LABEL[object.type]}
        </span>
        {isRenaming ? (
          <input
            className="lumora-tree-row__rename"
            defaultValue={object.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
            data-testid={`tree-rename-${object.id}`}
          />
        ) : (
          <span className="lumora-tree-row__name" title={object.name}>
            {object.name}
          </span>
        )}
        <span className="lumora-tree-row__actions">
          <button
            type="button"
            className="lumora-icon-button"
            data-testid={`tree-visible-${object.id}`}
            title={object.visible ? '隐藏' : '显示'}
            onClick={(e) => {
              e.stopPropagation();
              const result = editor.setVisible([object.id], !object.visible);
              if (!result.ok) showToast(result.error.message, 'error');
            }}
          >
            {object.visible ? '显' : '隐'}
          </button>
          <button
            type="button"
            className={`lumora-icon-button${object.locked ? ' lumora-icon-button--active' : ''}`}
            data-testid={`tree-lock-${object.id}`}
            title={object.locked ? '解锁' : '锁定'}
            onClick={(e) => {
              e.stopPropagation();
              const result = editor.setLocked([object.id], !object.locked);
              if (!result.ok) showToast(result.error.message, 'error');
            }}
          >
            {object.locked ? '锁' : '开'}
          </button>
          <button
            type="button"
            className="lumora-icon-button lumora-icon-button--danger"
            data-testid={`tree-delete-${object.id}`}
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              if (!isDeleteConfirming) {
                setDeleteConfirmId(object.id);
                return;
              }
              setDeleteConfirmId(null);
              editor.setSelection([object.id]);
              const result = editor.deleteSelection();
              if (!result.ok) showToast(result.error.message, 'error');
            }}
            onBlur={() => setDeleteConfirmId(null)}
          >
            {isDeleteConfirming ? '确认?' : '删'}
          </button>
        </span>
      </div>
      {isExpanded &&
        children.map((child) => (
          <TreeNode
            key={child.id}
            editor={editor}
            project={project}
            object={child}
            depth={depth + 1}
            selection={selection}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            deleteConfirmId={deleteConfirmId}
            setDeleteConfirmId={setDeleteConfirmId}
            setDragId={setDragId}
            dropTargetId={dropTargetId}
            setDropTargetId={setDropTargetId}
            handleDrop={handleDrop}
            rowRefs={rowRefs}
            getRowTabIndex={getRowTabIndex}
            onRowKeyDown={onRowKeyDown}
          />
        ))}
    </div>
  );
}
