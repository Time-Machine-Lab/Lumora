export type SceneObjectKind = 'box' | 'sphere' | 'cone' | 'torus' | 'plane';

export interface SceneObjectData {
  id: string;
  kind: SceneObjectKind;
  name?: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  color: string;
}

export interface Project {
  uri: string;
  name: string;
  objects: SceneObjectData[];
  createdAt: string;
}

/** 内置示例项目：三个基础图元，用于验证场景渲染与 project 事件 */
export function createSampleProject(
  uri = 'lumora://sample-project',
  name = '示例项目',
): Project {
  return {
    uri,
    name,
    createdAt: new Date().toISOString(),
    objects: [
      { id: 'sample-cube', kind: 'box', name: '立方体', position: [-2.5, 0.5, 0], color: '#ff6b6b' },
      { id: 'sample-sphere', kind: 'sphere', name: '球体', position: [0, 0.5, 0], color: '#4dabf7' },
      { id: 'sample-cone', kind: 'cone', name: '圆锥', position: [2.5, 0.5, 0], color: '#69db7c' },
    ],
  };
}
