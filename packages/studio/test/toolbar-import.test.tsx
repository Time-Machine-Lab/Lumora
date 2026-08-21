import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { LumoraStudio } from '../src/components/LumoraStudio';

// P3 集成契约：Toolbar 把全量文件列表交给导入流程（.gltf 多文件依赖共享同一入口）
vi.mock('../src/components/editor/model-import', () => ({
  importModelFile: vi.fn(async () => ({ ok: false, error: new Error('stub') })),
}));

import { importModelFile } from '../src/components/editor/model-import';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-canvas">{children}</div>
  ),
  useThree: (selector?: (state: unknown) => unknown) => {
    const state = {
      scene: new THREE.Group(),
      set: () => undefined,
      camera: new THREE.PerspectiveCamera(),
      gl: { setViewport: () => undefined, setScissor: () => undefined, setScissorTest: () => undefined },
      size: { width: 800, height: 600 },
      viewport: { dpr: 1 },
    };
    return selector ? selector(state) : state;
  },
  useFrame: () => undefined,
}));

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  TransformControls: () => null,
}));

describe('Toolbar：全量文件列表契约（P3）', () => {
  beforeEach(() => {
    vi.mocked(importModelFile).mockClear();
  });

  it('导入入口把多选文件整体交给 importModelFile（.gltf + 外部依赖），不是首文件截断', async () => {
    render(<LumoraStudio hostVersion="0.1.0" />);
    await screen.findByTestId('lumora-studio');
    fireEvent.click(screen.getByTestId('open-sample-project'));
    await waitFor(() => expect(screen.getByTestId('tree-row-sample-group')).toBeInTheDocument());

    const input = screen.getByTestId('toolbar-model-file-input') as HTMLInputElement;
    const gltf = new File([new Uint8Array([1])], 'car.gltf', { type: 'model/gltf+json' });
    const bin = new File([new Uint8Array([2])], 'mesh.bin', { type: 'application/octet-stream' });
    const png = new File([new Uint8Array([3])], 'diffuse.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [gltf, bin, png] });
    fireEvent.change(input);

    await waitFor(() => expect(vi.mocked(importModelFile)).toHaveBeenCalledTimes(1));
    const files = vi.mocked(importModelFile).mock.calls[0]![2];
    expect(Array.isArray(files)).toBe(true);
    expect((files as File[]).map((f) => f.name)).toEqual(['car.gltf', 'mesh.bin', 'diffuse.png']);
  });
});
