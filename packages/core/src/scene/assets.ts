/** 资源工具：内容哈希与去重（FR-003：同一文件去重，无引用后释放）。 */

/** FNV-1a 64 位回退哈希（crypto.subtle 不可用时同步可用） */
export function fnv1aHex(data: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= BigInt(data[i]!);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 内容哈希：优先 SHA-256（crypto.subtle），不可用时回退 FNV-1a */
export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const arrayBuffer: ArrayBuffer =
    data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      : data;
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return fnv1aHex(new Uint8Array(arrayBuffer));
}

/**
 * 组合内容哈希（多文件资产唯一标识）：主文件哈希 + 全部依赖分件（按路径排序的
 * `path:hash` 列表），缺任一字节即换哈希。模型导入（model-import）与工程包校验
 * （project/package）必须使用同一算法，否则多文件模型无法从自身导出的包恢复。
 */
export async function compositeContentHash(
  mainHash: string,
  parts: ReadonlyArray<{ path: string; partHash: string }>,
): Promise<string> {
  if (parts.length === 0) return mainHash;
  const partsText = parts
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((p) => `${p.path}:${p.partHash}`)
    .join('|');
  return hashBytes(new TextEncoder().encode(`${mainHash}|${partsText}`));
}
