/** 资源工具：内容哈希与去重（FR-003：同一文件去重，无引用后释放）。 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 纯 JS SHA-256（FIPS 180-4）：与 crypto.subtle 产出完全相同的摘要 ——
 *  内容哈希在任何环境（含无 WebCrypto 的受限 WebView）都确定一致，
 *  工程包跨环境校验不依赖环境差异。 */
export function sha256Hex(data: Uint8Array): string {
  const lengthBits = data.length * 8;
  const blocks = Math.ceil((data.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(blocks * 64 - 8, Math.floor(lengthBits / 0x100000000));
  view.setUint32(blocks * 64 - 4, lengthBits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/** 内容哈希：恒为 SHA-256（crypto.subtle 可用时走 WebCrypto，失败/不可用
 *  回退纯 JS 实现 —— 两种实现产出同一摘要，任何环境结果确定一致）。 */
export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      // TS 5.7 起 BufferSource 要求 ArrayBuffer 背板：完整视图复用原缓冲（零拷贝），
      // 带偏移视图复制片段后送入 digest（解码路径均为完整视图，走零拷贝分支）
      const source: ArrayBuffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : new Uint8Array(bytes).buffer;
      const digest = await subtle.digest('SHA-256', source);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // WebCrypto 异常（受限环境）：回退纯 JS 实现，摘要不变
    }
  }
  return sha256Hex(bytes);
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
