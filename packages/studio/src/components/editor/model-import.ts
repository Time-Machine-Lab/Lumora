import { createModelObject, findAssetByHash, genId, hashBytes } from '@lumora/core';
import type { AssetData, AssetPartData, Project, SceneEditor } from '@lumora/core';
import { collectGltfUris, resolveFormat } from './content-cache';
import type { CacheLease, CachePartFile, ContentCache } from './content-cache';

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

/** 格式决议：扩展名优先于浏览器 MIME（application/json/octet-stream 误报时以 .gltf 为准） */
function formatFor(name: string, mime: string): 'gltf' | 'glb' {
  return resolveFormat(name, mime);
}

function isMainName(name: string): boolean {
  return /\.(glb|gltf)$/i.test(name);
}

/** 多文件导入时按目录选择保相对路径（与 gltf JSON 内相对 URI 对应）；单文件选择回退文件名 */
function partPathFor(main: File, part: File): string {
  const raw = (part as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
  const normalized = raw ? raw.replace(/\\/g, '/') : '';
  if (!normalized) return part.name.replace(/\\/g, '/');
  const mainDir = ((main as File & { webkitRelativePath?: string }).webkitRelativePath ?? '').replace(/\\/g, '/');
  const mainDirPrefix = mainDir.includes('/') ? mainDir.slice(0, mainDir.lastIndexOf('/') + 1) : '';
  return mainDirPrefix && normalized.startsWith(mainDirPrefix)
    ? normalized.slice(mainDirPrefix.length)
    : part.name.replace(/\\/g, '/');
}

function uriBase(uri: string): string {
  return uri.split('/').pop() ?? uri;
}

/**
 * 导入模型文件（GLB 单文件 / GLTF 多文件）：
 * 内容哈希去重 → 解析（解析失败不产生任何历史/资源）→ 资源注册 + 模型对象创建
 * 合并为一步历史（importModel 原子提交；撤销无孤儿资源，重做恢复资源与内容）。
 * 字节以 base64 载荷随项目持久化；.gltf 的外部 .bin/纹理作为 parts 一并持久化，
 * 重开项目/重做后由 ContentCache（seed/retain）从载荷按同一规则重建依赖映射。
 * 解析前绑定项目会话与目标场景：解析完成后若会话（打开/关闭项目）或目标场景
 * 已切换，则取消提交并释放缓存内容（缓存引用以项目关系为准，见 ContentCache.sweep）。
 * 多文件支持：传入数组时以首个 .glb/.gltf 为主文件，其余为外部依赖；
 * 依赖缺失立即失败（不触碰缓存）；组合内容哈希覆盖主文件与全部依赖字节。
 */
export async function importModelFile(
  editor: SceneEditor,
  cache: ContentCache,
  file: File | File[],
): Promise<ImportModelResult> {
  // 在首个 await 前同步绑定会话与目标场景：调用方（文件选择/拖放）执行期间
  // 项目可能已同步切换，异步恢复后校验必须以“导入发起时”的会话为准
  const sessionToken = editor.getSessionToken();
  const session = editor.getProject();
  if (!session) return fail('未打开项目');
  const targetSceneId = session.activeSceneId;

  const files = Array.isArray(file) ? file : [file];
  const main = files.find((f) => isMainName(f.name)) ?? files[0];
  if (!main) return fail('未找到主模型文件（.glb/.gltf）');
  const partFiles = files.filter((f) => f !== main);
  const partPaths = partFiles.map((f) => ({ file: f, path: partPathFor(main, f) }));

  let mainBytes: ArrayBuffer;
  try {
    mainBytes = await main.arrayBuffer();
  } catch {
    return fail('无法读取主模型文件内容');
  }
  const mainHash = await hashBytes(new Uint8Array(mainBytes));

  let parts: CachePartFile[] = [];
  let partsText = '';
  if (partPaths.length > 0) {
    if (!/\.gltf$/i.test(main.name)) return fail('仅 .gltf 支持外部依赖文件');
    let required: string[];
    try {
      required = collectGltfUris(mainBytes);
    } catch {
      // JSON.parse 抛错：统一 Result 错误契约，不向调用方泄漏未捕获异常
      return fail('gltf JSON 解析失败（主文件不是有效的 .gltf JSON）');
    }
    const missing = required.filter(
      (uri) => !partPaths.some((p) => p.path === uri || uriBase(p.path) === uriBase(uri)),
    );
    if (missing.length > 0) return fail(`缺少依赖文件：${missing.join('、')}`);
    const loaded: CachePartFile[] = [];
    const hashes: { path: string; partHash: string }[] = [];
    for (const { file: partFile, path } of partPaths) {
      let bytes: ArrayBuffer;
      try {
        bytes = await partFile.arrayBuffer();
      } catch {
        return fail(`无法读取依赖文件：${path}`);
      }
      loaded.push({ path, mime: partFile.type || 'application/octet-stream', bytes });
      hashes.push({ path, partHash: await hashBytes(new Uint8Array(bytes)) });
    }
    parts = loaded;
    partsText = hashes
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((p) => `${p.path}:${p.partHash}`)
      .join('|');
  }

  // 组合内容哈希：主文件 + 全部依赖（按路径排序，确定性），缺任一字节即换哈希
  const hash = partsText
    ? await hashBytes(new TextEncoder().encode(`${mainHash}|${partsText}`))
    : mainHash;

  const format = formatFor(main.name, main.type);
  let lease: CacheLease;
  try {
    lease = cache.acquire(hash, mainBytes, { format, parts });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  try {
    await lease.content;
  } catch (error) {
    lease.release();
    return fail(`模型解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const latest = editor.getProject();
  const sessionLost = !editor.isCurrentSession(sessionToken);
  const sceneLost = !sessionLost && latest !== null && latest.activeSceneId !== targetSceneId;
  if (sessionLost || sceneLost) {
    // 主动放弃 + 判死刑：新会话尚未引用该内容时清理条目；
    // 已被新会话引用（如同 hash 已重新导入，持独立 lease）则条目继续存活
    if (!projectReferencesHash(latest, hash)) cache.discard(lease);
    else lease.release();
    return fail(sessionLost ? '项目已切换，导入已取消' : '目标场景已切换，导入已取消');
  }

  const project = latest!;
  const deduped = !!findAssetByHash(project, hash);
  const assetParts: AssetPartData[] | undefined =
    parts.length > 0
      ? parts.map((p) => ({ path: p.path, mime: p.mime, payload: toBase64(p.bytes) }))
      : undefined;
  const asset: AssetData = {
    id: genId('asset'),
    kind: 'gltf',
    name: main.name,
    mime: format === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary',
    format,
    hash,
    size: main.size + parts.reduce((sum, p) => sum + p.bytes.byteLength, 0),
    source: 'file',
    // 文件导入的字节随 payload 持久化；storageRef 是宿主存储引用（运行时 blob URL
    // 随会话失效，写入项目 JSON 会产生不可再打开的悬空引用），这里置空
    storageRef: '',
    payload: toBase64(mainBytes),
    ...(assetParts ? { parts: assetParts } : {}),
    createdAt: new Date().toISOString(),
  };
  const name = main.name.replace(/\.(glb|gltf)$/i, '') || '模型';
  const created = editor.importModel(asset, createModelObject(asset.id, name));
  if (!created.ok || !created.value) {
    // 提交失败（如会话恰在解析后关闭）：放弃内容，无引用时立即清理
    cache.discard(lease);
    return fail(created.ok ? '创建模型对象失败' : created.error.message);
  }
  // 提交成功：内容已随项目引用存活（sweep 依据 Project 全量关系），导入流程的
  // lease 使命完成——释放它，渲染消费者（SceneContent）在项目变更后自行 retain
  lease.release();
  const effective = findAssetByHash(editor.getProject()!, hash)!;
  return { ok: true, objectId: created.value, asset: effective, deduped };
}
