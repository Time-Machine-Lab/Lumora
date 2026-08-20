import { createModelObject, findAssetByHash, genId, hashBytes } from '@lumora/core';
import type { AssetData, Project, SceneEditor } from '@lumora/core';
import type { AssetCache } from './asset-cache';

export type ImportModelResult =
  | { ok: true; objectId: string; asset: AssetData; deduped: boolean }
  | { ok: false; error: Error };

function fail(message: string): ImportModelResult {
  return { ok: false, error: new Error(message) };
}

/** 项目是否已引用某内容哈希（model → asset → hash） */
function projectReferencesHash(project: Project | null, hash: string): boolean {
  if (!project) return false;
  return project.objects.some((object) => {
    if (!object.assetId) return false;
    return project.assets.some((asset) => asset.id === object.assetId && asset.hash === hash);
  });
}

/** 字节 → base64（btoa 需 ASCII 二进制串；分块避免调用栈溢出） */
function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 导入模型文件（GLB/GLTF）：
 * 内容哈希去重 → 解析（解析失败不产生任何历史/资源）→ 资源注册 + 模型对象创建
 * 合并为一步历史（importModel 原子提交；撤销无孤儿资源，重做恢复资源与内容）。
 * 字节以 base64 载荷随项目持久化，重开项目/重做后由 AssetCache 从载荷重建内容。
 * 解析前绑定项目会话与目标场景：解析完成后若会话（打开/关闭项目）或目标场景
 * 已切换，则取消提交并释放缓存内容（缓存引用以项目关系为准，见 AssetCache.sweep）。
 */
export async function importModelFile(
  editor: SceneEditor,
  cache: AssetCache,
  file: File,
): Promise<ImportModelResult> {
  // 在首个 await 前同步绑定会话与目标场景：调用方（文件选择/拖放）执行期间
  // 项目可能已同步切换，异步恢复后校验必须以“导入发起时”的会话为准
  const sessionToken = editor.getSessionToken();
  const session = editor.getProject();
  if (!session) return fail('未打开项目');
  const targetSceneId = session.activeSceneId;
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return fail('无法读取文件内容');
  }
  const hash = await hashBytes(new Uint8Array(bytes));

  try {
    await cache.acquire(hash, file);
  } catch (error) {
    return fail(`模型解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const latest = editor.getProject();
  const sessionLost = !editor.isCurrentSession(sessionToken);
  const sceneLost = !sessionLost && latest !== null && latest.activeSceneId !== targetSceneId;
  if (sessionLost || sceneLost) {
    // 新会话尚未引用该内容时释放缓存条目；已被新会话引用（如同 hash 已重新导入）则保留
    if (!projectReferencesHash(latest, hash)) cache.discard(hash);
    return fail(sessionLost ? '项目已切换，导入已取消' : '目标场景已切换，导入已取消');
  }

  const project = latest!;
  const deduped = !!findAssetByHash(project, hash);
  const asset: AssetData = {
    id: genId('asset'),
    kind: 'gltf',
    name: file.name,
    mime: file.type || 'model/gltf-binary',
    hash,
    size: file.size,
    source: 'file',
    // 文件导入的字节随 payload 持久化；storageRef 是宿主存储引用（运行时 blob URL
    // 随会话失效，写入项目 JSON 会产生不可再打开的悬空引用），这里置空
    storageRef: '',
    payload: toBase64(bytes),
    createdAt: new Date().toISOString(),
  };
  const name = file.name.replace(/\.(glb|gltf)$/i, '') || '模型';
  const created = editor.importModel(asset, createModelObject(asset.id, name));
  if (!created.ok || !created.value) {
    return fail(created.ok ? '创建模型对象失败' : created.error.message);
  }
  const effective = findAssetByHash(editor.getProject()!, hash)!;
  return { ok: true, objectId: created.value, asset: effective, deduped };
}
