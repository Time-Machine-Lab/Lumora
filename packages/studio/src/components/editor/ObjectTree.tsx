import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  createCameraObject,
  createGroupObject,
  createLightObject,
  createPrimitiveObject,
  findObject,
  getDescendantIds,
} from '@lumora/core';
import type { Project, SceneEditor, SceneObjectData } from '@lumora/core';
import type { ContentCache } from './content-cache';
import { importModelFile } from './model-import';
import { showToast } from './toasts';
import { buildTreeOrder } from './tree-order';

interface ObjectTreeProps {
  editor: SceneEditor;
  project: Project | null;
  selection: string[];
  cache: ContentCache;
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

/** 对象 id 的 aria 关联 id 编码：空白替换为下划线——id 属性不得含空白（R10-M3 #6） */
function enc(id: string): string {
  return id.replace(/\s+/g, '_');
}

/** 对象层级树：选择/可见/锁定/重命名/拖拽重排/删除，顶部提供场景切换与添加菜单 */
export function ObjectTree({ editor, project, selection, cache }: ObjectTreeProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null);
  /** 单一 roving focus：树内任意时刻只有一个 tab 停靠点（最后聚焦/选中的行） */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const moveMenuRef = useRef<HTMLDivElement>(null);

  // 外部选择变化（视口拾取等）时，停靠点跟随选中行——但仅当目标行仍可见：
  // 折叠/跨场景过滤后选择可能含不可见行，跟随前校验，否则回退可见行（树首）
  useEffect(() => {
    // 项目关闭（project=null）后树序不再存在：先清焦点再返回，
    // 避免读取早退 return 之后才初始化的 flatRows（TDZ ReferenceError 会卸载整个 Studio）
    if (!project) {
      setFocusedId(null);
      return;
    }
    if (focusedId !== null && !flatRows.includes(focusedId)) {
      const fallback = selection[0] ?? flatRows[0] ?? null;
      if (fallback !== null && flatRows.includes(fallback)) setFocusedId(fallback);
      else setFocusedId(null);
    } else if (focusedId === null && selection.length > 0 && flatRows.includes(selection[0]!)) {
      setFocusedId(selection[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flatRows 由 project/expanded 推导，依赖以原始状态为准
  }, [selection, focusedId, project, expanded]);

  // 「移动到」菜单打开时焦点进入首项（APG menu button，R8-9）：
  // 键盘 M 打开后即可用方向键导航；否则菜单对键盘用户不可达
  useEffect(() => {
    if (moveMenuId) {
      moveMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [moveMenuId]);

  if (!project) return null;
  const scene = project.scenes.find((s) => s.id === project.activeSceneId) ?? project.scenes[0];
  const roots = scene
    ? scene.rootObjectIds
        .map((id) => findObject(project, id))
        .filter((o): o is SceneObjectData => !!o)
    : [];

  // 默认展开（expanded 未记录时视为 true），首次折叠要翻到 false
  const toggleExpanded = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));

  // 树序索引：单次 O(n) 遍历构建（childrenOf/rows/rowIndex），
  // 键盘导航的可见行顺序与子级查询全部 O(1)（R6-D，取代逐节点 filter 的 O(n²)）
  const order = buildTreeOrder(project, roots, expanded);
  const flatRows = order.rows;

  const focusRow = (id: string) => {
    setFocusedId(id);
    rowRefs.current[id]?.focus();
  };

  const handleRowKeyDown = (object: SceneObjectData, event: React.KeyboardEvent) => {
    const index = order.rowIndex.get(object.id) ?? -1;
    const children = order.childrenOf.get(object.id) ?? [];
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
      // 行内按钮不参与 Tab 顺序（单一 tab 停靠点 = 行本身，APG treeview）；
      // 行动作以快捷键等价提供：V/L 切换可见/锁定（Delete 删除沿用宿主全局快捷键）
      case 'v':
      case 'V': {
        event.preventDefault();
        const visibility = editor.setVisible([object.id], !object.visible);
        if (!visibility.ok) showToast(visibility.error.message, 'error');
        break;
      }
      case 'l':
      case 'L': {
        event.preventDefault();
        const locking = editor.setLocked([object.id], !object.locked);
        if (!locking.ok) showToast(locking.error.message, 'error');
        break;
      }
      case 'm':
      case 'M':
        // 「移动到」（键盘等价；触屏走行内按钮）：候选目标 = 可见行 − 自身 − 后代
        event.preventDefault();
        setMoveMenuId(object.id);
        break;
      default:
        break;
    }
  };

  // 单一 tab 停靠点：最后聚焦的行（未聚焦时回退选中行/树首行，键盘用户可进入）；
  // 停靠点必须落在可见行内——不可见（折叠/跨场景）则沿链回退，避免整树 tabindex=-1
  const rowVisible = (id: string | null | undefined): id is string =>
    id !== null && id !== undefined && flatRows.includes(id);
  const activeRowId = rowVisible(focusedId)
    ? focusedId
    : rowVisible(selection[0])
      ? selection[0]!
      : flatRows[0] ?? null;
  const rowTabIndex = (id: string) => (activeRowId === id ? 0 : -1);

  const handleDrop = (targetId: string) => {
    setDropTargetId(null);
    const dragged = dragId;
    setDragId(null);
    if (!dragged || dragged === targetId) return;
    const result = editor.setParent(dragged, targetId);
    if (!result.ok) showToast(result.error.message, 'error');
  };

  // 「移动到」目标候选：可见行，排除自身与后代（getDescendantIds 走已索引的
  // 可达集，不随候选数增长）；仅菜单打开时计算
  const moveDescendants =
    moveMenuId !== null ? new Set(getDescendantIds(project, moveMenuId)) : new Set<string>();
  const moveCandidates =
    moveMenuId !== null
      ? order.rows
          .filter((id) => id !== moveMenuId && !moveDescendants.has(id))
          .map((id) => order.byId.get(id))
          .filter((o): o is SceneObjectData => !!o)
      : [];

  const commitMove = (targetId: string | null) => {
    if (moveMenuId === null) return;
    const movingId = moveMenuId;
    const result = editor.setParent(movingId, targetId);
    // 层级变更使触发行重建：先 flush 掉菜单关闭与项目更新的渲染，
    // 再落焦点到重建后的行（先落焦点再重建会被丢到 body，R8-9）
    flushSync(() => setMoveMenuId(null));
    if (!result.ok) showToast(result.error.message, 'error');
    focusRow(movingId); // APG：菜单选择后焦点返回触发行
  };

  // 多文件选择：.gltf 与外部 .bin/纹理一起选中；单个文件（工具栏入口）同样适用
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
          onClick={(e) => {
            // 双击隔离：快速双击只开一次菜单，不因第二次点击立即关闭
            if (e.detail > 1) return;
            setAddMenuOpen((open) => !open);
          }}
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
          multiple
          accept=".glb,.gltf,.bin,model/gltf-binary,model/gltf+json,application/octet-stream,image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          data-testid="model-file-input"
          onChange={(e) => void handleImportFile(e.target.files)}
        />
      </div>
      <div className="lumora-tree__list" role="tree" aria-multiselectable="true">
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
            childrenOf={order.childrenOf}
            moveMenuId={moveMenuId}
            setMoveMenuId={setMoveMenuId}
            moveCandidates={moveCandidates}
            commitMove={commitMove}
            moveMenuRef={moveMenuRef}
            rowRefs={rowRefs}
            getRowTabIndex={rowTabIndex}
            onRowKeyDown={handleRowKeyDown}
            setFocusedId={setFocusedId}
            focusRow={focusRow}
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
  childrenOf,
  moveMenuId,
  setMoveMenuId,
  moveCandidates,
  commitMove,
  moveMenuRef,
  rowRefs,
  getRowTabIndex,
  onRowKeyDown,
  setFocusedId,
  focusRow,
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
  childrenOf: Map<string, SceneObjectData[]>;
  moveMenuId: string | null;
  setMoveMenuId: (id: string | null) => void;
  moveCandidates: SceneObjectData[];
  commitMove: (targetId: string | null) => void;
  moveMenuRef: React.RefObject<HTMLDivElement | null>;
  rowRefs: React.RefObject<Record<string, HTMLElement | null>>;
  getRowTabIndex: (id: string) => number;
  onRowKeyDown: (object: SceneObjectData, event: React.KeyboardEvent) => void;
  setFocusedId: (id: string | null) => void;
  focusRow: (id: string) => void;
}) {
  // R10-M3 #6：useId 实例命名空间——同一文档多个树实例时 aria 关联 id 全局唯一
  const instanceNs = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const children = childrenOf.get(object.id) ?? [];
  const isExpanded = expanded[object.id] ?? true;
  const isSelected = selection.includes(object.id);
  const isRenaming = renamingId === object.id;
  const isDeleteConfirming = deleteConfirmId === object.id;
  const isDragOver = dropTargetId === object.id;

  const select = (event: React.MouseEvent) => {
    // 子行点击冒泡至父 treeitem：目标位于本行自己的 group 子容器内时交由子行处理
    const group = (event.currentTarget as HTMLElement).querySelector('.lumora-tree__group');
    if (event.target !== event.currentTarget && group?.contains(event.target as Node)) return;
    setFocusedId(object.id);
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
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      aria-expanded={children.length > 0 ? isExpanded : undefined}
      data-testid={`tree-row-${object.id}`}
      className={`lumora-tree__node${isDragOver ? ' lumora-tree-row--drop-target' : ''}`}
      draggable
      // 行内重命名期间 treeitem 移出 Tab 顺序（APG treeview）：Tab 离开树，
      // 而非跳到下一个 treeitem；提交/取消后恢复停靠点
      tabIndex={isRenaming ? -1 : getRowTabIndex(object.id)}
      ref={(el) => {
        rowRefs.current[object.id] = el;
      }}
      // 行内键盘操作（重命名输入、按钮）不得被行导航拦截：仅行自身按键触发
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) onRowKeyDown(object, event);
      }}
      onClick={select}
      onDoubleClick={(event) => {
        // 与 select 相同的冒泡守卫：子行双击交由子行处理
        const group = (event.currentTarget as HTMLElement).querySelector('.lumora-tree__group');
        if (event.target !== event.currentTarget && group?.contains(event.target as Node)) return;
        if (renamingId === object.id) return;
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
      <div
        className={`lumora-tree-row${isSelected ? ' lumora-tree-row--selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        <button
          type="button"
          className={`lumora-tree-row__chevron${children.length === 0 ? ' lumora-tree-row__chevron--leaf' : ''}`}
          data-testid={`tree-toggle-${object.id}`}
          onClick={(e) => {
            e.stopPropagation();
            if (e.detail > 1) return; // 双击隔离：一次双击只折叠/展开一次
            toggleExpanded(object.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          tabIndex={-1} // 单一 tab 停靠点：行内按钮不进 Tab 顺序（APG treeview）
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
              if (e.detail > 1) return; // 双击隔离：一次双击只切换一次，不产生两步历史
              const result = editor.setVisible([object.id], !object.visible);
              if (!result.ok) showToast(result.error.message, 'error');
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            tabIndex={-1}
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
              if (e.detail > 1) return; // 双击隔离：一次双击只切换一次
              const result = editor.setLocked([object.id], !object.locked);
              if (!result.ok) showToast(result.error.message, 'error');
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            tabIndex={-1}
          >
            {object.locked ? '锁' : '开'}
          </button>
          <button
            type="button"
            className="lumora-icon-button"
            id={`tree-move-trigger-${instanceNs}-${enc(object.id)}`}
            data-testid={`tree-move-${object.id}`}
            title="移动到"
            aria-haspopup="menu"
            aria-expanded={moveMenuId === object.id}
            aria-controls={`tree-move-menu-${instanceNs}-${enc(object.id)}`}
            onClick={(e) => {
              e.stopPropagation();
              setMoveMenuId(object.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            tabIndex={-1}
          >
            移
          </button>
          <button
            type="button"
            className="lumora-icon-button lumora-icon-button--danger"
            data-testid={`tree-delete-${object.id}`}
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              if (e.detail > 1) return; // 双击隔离：双击的第二次点击不绕过确认直接删除
              if (!isDeleteConfirming) {
                setDeleteConfirmId(object.id);
                return;
              }
              setDeleteConfirmId(null);
              editor.setSelection([object.id]);
              const result = editor.deleteSelection();
              if (!result.ok) showToast(result.error.message, 'error');
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            tabIndex={-1}
            onBlur={() => setDeleteConfirmId(null)}
          >
            {isDeleteConfirming ? '确认?' : '删'}
          </button>
        </span>
        {moveMenuId === object.id && (
          <div
            className="lumora-menu lumora-menu--tree"
            role="menu"
            id={`tree-move-menu-${instanceNs}-${enc(object.id)}`}
            aria-labelledby={`tree-move-trigger-${instanceNs}-${enc(object.id)}`}
            data-testid="tree-move-menu"
            ref={moveMenuRef}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              // 焦点离开菜单（点击他处/失焦）即关闭
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setMoveMenuId(null);
            }}
            onKeyDown={(e) => {
              // 菜单打开期间吞噬全部按键：Delete/Backspace 等 Studio 全局
              // 快捷键不落到底层（R8-9）
              e.stopPropagation();
              const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
              const focusedIndex = items.indexOf(document.activeElement as HTMLElement);
              switch (e.key) {
                case 'ArrowDown':
                  e.preventDefault();
                  items[Math.min(focusedIndex + 1, items.length - 1)]?.focus();
                  break;
                case 'ArrowUp':
                  e.preventDefault();
                  items[Math.max(focusedIndex - 1, 0)]?.focus();
                  break;
                case 'Home':
                  e.preventDefault();
                  items[0]?.focus();
                  break;
                case 'End':
                  e.preventDefault();
                  items[items.length - 1]?.focus();
                  break;
                case 'Escape':
                  e.preventDefault();
                  setMoveMenuId(null);
                  if (moveMenuId !== null) focusRow(moveMenuId);
                  break;
                case 'Enter':
                case ' ':
                  // 激活 roving focus 当前项（焦点在菜单外时落在首项）
                  e.preventDefault();
                  (document.activeElement as HTMLElement | null)?.click();
                  break;
                default:
                  break;
              }
            }}
          >
            <button
              type="button"
              className="lumora-menu__item"
              role="menuitem"
              tabIndex={-1} // 单一 tab 停靠点：菜单项不进 Tab 顺序（APG roving focus，R8-9）
              data-testid="tree-move-to-root"
              onClick={() => commitMove(null)}
            >
              根节点（场景）
            </button>
            {moveCandidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="lumora-menu__item"
                role="menuitem"
                tabIndex={-1}
                data-testid={`tree-move-to-${candidate.id}`}
                onClick={() => commitMove(candidate.id)}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {isExpanded && children.length > 0 && (
        <ul role="group" className="lumora-tree__group">
          {children.map((child) => (
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
              childrenOf={childrenOf}
              moveMenuId={moveMenuId}
              setMoveMenuId={setMoveMenuId}
              moveCandidates={moveCandidates}
              commitMove={commitMove}
              moveMenuRef={moveMenuRef}
              rowRefs={rowRefs}
              getRowTabIndex={getRowTabIndex}
              onRowKeyDown={onRowKeyDown}
              setFocusedId={setFocusedId}
              focusRow={focusRow}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
