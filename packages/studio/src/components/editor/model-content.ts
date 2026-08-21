import { getReachableIds } from '@lumora/core';
import type { Project } from '@lumora/core';

/**
 * 活动场景内 hash → 全部引用它的模型对象 id（M2，TML-57 第五轮）：
 * Ctrl+D 复制/多对象共享同一资源时，内容就绪后必须挂到全部节点，而不是只挂首个。
 * 以活动场景可达集为界：跨场景模型不消费当前视口内容（缓存存活仍由 Project 全量
 * 关系决定，见 ContentCache.sweep）。
 */
export function collectModelObjectIds(project: Project): Map<string, string[]> {
  const reachable = getReachableIds(project, project.activeSceneId);
  const byHash = new Map<string, string[]>();
  for (const object of project.objects) {
    if (object.type !== 'model' || !object.assetId || !reachable.has(object.id)) continue;
    const asset = project.assets.find((a) => a.id === object.assetId);
    if (!asset) continue;
    const ids = byHash.get(asset.hash);
    if (ids) ids.push(object.id);
    else byHash.set(asset.hash, [object.id]);
  }
  return byHash;
}
