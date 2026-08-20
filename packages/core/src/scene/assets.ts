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
