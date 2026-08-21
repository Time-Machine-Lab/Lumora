import { readFileSync } from 'node:fs';

/** 生成最小合法 GLB（仅 JSON chunk，无缓冲）：{asset, scenes, nodes} */
export function buildGlb(json: Record<string, unknown>): Buffer {
  const jsonText = JSON.stringify(json);
  const pad = (4 - (jsonText.length % 4)) % 4;
  const jsonBytes = Buffer.concat([Buffer.from(jsonText, 'utf8'), Buffer.alloc(pad, 0x20)]);
  const total = 12 + 8 + jsonBytes.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonBytes.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  return Buffer.concat([header, chunkHeader, jsonBytes]);
}

export const MINIMAL_GLB = buildGlb({
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'EmptyRoot' }],
});

/** 在仓库已验证的 nested-mesh.glb 夹具基础上膨胀 BIN 缓冲到目标大小（TML-87 大载荷夹具） */
export function buildGlbWithBin(targetSize = 2 * 1024 * 1024): Buffer {
  const source = readFileSync(new URL('../../packages/studio/test/fixtures/nested-mesh.glb', import.meta.url));
  const jsonChunkLen = source.readUInt32LE(12);
  const jsonEnd = 12 + 8 + jsonChunkLen;
  const binStart = jsonEnd + 8;
  const binChunkLen = source.readUInt32LE(jsonEnd);
  const oldJson = source.subarray(20, jsonEnd).toString('utf8');
  const json = JSON.parse(oldJson) as { buffers: { byteLength: number }[] };
  const newBinLen = Math.max(binChunkLen, Math.ceil((targetSize - (source.length - binChunkLen)) / 4) * 4);
  json.buffers[0].byteLength = newBinLen;
  const jsonText = JSON.stringify(json);
  const jsonChunk = Buffer.concat([
    Buffer.from(jsonText, 'utf8'),
    Buffer.alloc((4 - (jsonText.length % 4)) % 4, 0x20),
  ]);
  const bin = Buffer.concat([source.subarray(binStart), Buffer.alloc(newBinLen - binChunkLen, 0xab)]);
  const chunk = (data: Buffer, type: number): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(data.length, 0);
    header.writeUInt32LE(type, 4);
    return Buffer.concat([header, data]);
  };
  const binChunk = chunk(bin, 0x004e4942); // 'BIN\0'
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + binChunk.length, 8);
  return Buffer.concat([header, chunk(jsonChunk, 0x4e4f534a), binChunk]); // 'JSON'
}
