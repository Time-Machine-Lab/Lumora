import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { Project, SceneObjectData, SceneObjectKind } from '@lumora/core';

function SceneObjectMesh({ data }: { data: SceneObjectData }) {
  return (
    <mesh position={data.position} rotation={data.rotation} scale={data.scale}>
      <Geometry kind={data.kind} />
      <meshStandardMaterial color={data.color} />
    </mesh>
  );
}

function Geometry({ kind }: { kind: SceneObjectKind }) {
  switch (kind) {
    case 'box':
      return <boxGeometry args={[1, 1, 1]} />;
    case 'sphere':
      return <sphereGeometry args={[0.6, 24, 24]} />;
    case 'cone':
      return <coneGeometry args={[0.5, 1, 24]} />;
    case 'torus':
      return <torusGeometry args={[0.5, 0.2, 16, 32]} />;
    case 'plane':
      return <planeGeometry args={[1, 1]} />;
  }
}

/** Three.js 场景视口：渲染当前项目中的对象；挂载/卸载由 R3F 管理 WebGL 资源 */
export function SceneView({ project }: { project: Project | null }) {
  return (
    <div className="lumora-scene" data-testid="lumora-scene">
      <Canvas camera={{ position: [7, 5, 7], fov: 45 }} dpr={[1, 2]}>
        <color attach="background" args={['#14161f']} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[6, 10, 4]} intensity={1.4} />
        <gridHelper args={[20, 20, '#3a3f52', '#2a2e3d']} />
        <OrbitControls makeDefault enableDamping />
        {project?.objects.map((object) => (
          <SceneObjectMesh key={object.id} data={object} />
        ))}
      </Canvas>
    </div>
  );
}
