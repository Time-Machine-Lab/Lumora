/** 生成真实可渲染的 .gltf 多文件夹具（三角形 + 外置 .bin + 纹理）。 */

/** 1×1 红色 PNG（GLTFLoader 能解码的最小纹理） */
export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface TriangleGltfFiles {
  /** 主 .gltf JSON */
  gltf: Buffer;
  /** 几何数据 .bin（positions + normals + uvs + indices） */
  bin: Buffer;
}

/**
 * 三角形网格（材质引用纹理）：返回 gltf JSON（buffer.uri 固定 'mesh.bin'，
 * image.uri 由调用方指定）与 .bin 字节。纹理经 baseColorTexture 引用，
 * 加载路径必然触达 image 的 URI 解析。
 */
export function buildTriangleGltf(imageUri: string): TriangleGltfFiles {
  const positions = new Float32Array([
    -0.5, -0.5, 0, //
    0.5, -0.5, 0, //
    0, 0.5, 0,
  ]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = Buffer.alloc(104); // 36 + 36 + 24 + 6，补 2 字节对齐 4
  positions.forEach((v, i) => bin.writeFloatLE(v, i * 4));
  normals.forEach((v, i) => bin.writeFloatLE(v, 36 + i * 4));
  uvs.forEach((v, i) => bin.writeFloatLE(v, 72 + i * 4));
  indices.forEach((v, i) => bin.writeUInt16LE(v, 96 + i * 2));

  const gltf = {
    asset: { version: '2.0', generator: 'e2e-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Tri' }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1] },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 10497, wrapT: 10497 }],
    images: [{ uri: imageUri }],
    buffers: [{ uri: 'mesh.bin', byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 72, byteLength: 24, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 6, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-0.5, -0.5, 0],
        max: [0.5, 0.5, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  return { gltf: Buffer.from(JSON.stringify(gltf), 'utf8'), bin };
}
