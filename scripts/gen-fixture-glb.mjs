// 生成测试夹具：含嵌套节点与材质的真实 GLB（CarRoot → BodyMesh + 4×WheelMesh）
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mkdirSync, writeFileSync } from 'node:fs';

// GLTFExporter 的 writeAsync 用 FileReader 把 Blob 转 ArrayBuffer（浏览器 API，Node 无）
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};

const exporter = new GLTFExporter();
const car = new THREE.Group();
car.name = 'CarRoot';
const body = new THREE.Mesh(
  new THREE.BoxGeometry(2, 0.6, 1),
  new THREE.MeshStandardMaterial({ color: 0xd9480f, roughness: 0.4, metalness: 0.1 }),
);
body.name = 'BodyMesh';
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x212529, roughness: 0.8 });
for (let i = 0; i < 4; i += 1) {
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12), wheelMat);
  wheel.name = `WheelMesh${i + 1}`;
  wheel.position.set(i < 2 ? -0.7 : 0.7, -0.4, i % 2 === 0 ? 0.55 : -0.55);
  car.add(wheel);
}
car.add(body);
const gltf = await exporter.parseAsync(car, { binary: true });
const bytes = new Uint8Array(gltf);
mkdirSync('packages/studio/test/fixtures', { recursive: true });
writeFileSync('packages/studio/test/fixtures/nested-mesh.glb', bytes);
console.log('fixture bytes:', bytes.length);
