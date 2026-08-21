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
