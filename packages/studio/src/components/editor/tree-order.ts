import type { Project, SceneObjectData } from '@lumora/core';

export interface TreeOrder {
  /** 直接子对象（保持插入序）——构建时一次遍历填充，查询 O(1) */
  childrenOf: Map<string, SceneObjectData[]>;
  /** 可见行（深度优先、先父后子，按展开状态过滤） */
  rows: string[];
  /** 行 id → rows 下标，O(1) */
  rowIndex: Map<string, number>;
  /** id → 对象，O(1) */
  byId: Map<string, SceneObjectData>;
  /** 构建期间对 objects 全数组的遍历次数（恒为 1；查询零遍历） */
  scans: number;
}

/**
 * 树序索引：单次 O(n) 遍历构建 childrenOf 映射 + 展开 DFS 可见行。
 * 取代 ObjectTree 原先「每节点 project.objects.filter」的 O(n²) 构建，
 * 查询（子级/行序/对象）全部 O(1)。
 */
export function buildTreeOrder(
  project: Project,
  roots: SceneObjectData[],
  expanded: Record<string, boolean>,
): TreeOrder {
  const childrenOf = new Map<string, SceneObjectData[]>();
  const byId = new Map<string, SceneObjectData>();
  let scans = 0;
  scans += 1;
  for (const object of project.objects) {
    byId.set(object.id, object);
    if (object.parentId === null) continue;
    const list = childrenOf.get(object.parentId);
    if (list) list.push(object);
    else childrenOf.set(object.parentId, [object]);
  }
  const rows: string[] = [];
  const rowIndex = new Map<string, number>();
  const visit = (object: SceneObjectData) => {
    rowIndex.set(object.id, rows.length);
    rows.push(object.id);
    if (expanded[object.id] ?? true) {
      const children = childrenOf.get(object.id);
      if (children) for (const child of children) visit(child);
    }
  };
  for (const root of roots) visit(root);
  return { childrenOf, rows, rowIndex, byId, scans };
}
