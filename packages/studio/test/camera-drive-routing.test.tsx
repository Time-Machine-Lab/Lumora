import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import { CameraDrive } from '../src/components/editor/camera-drive';
import { findNode } from '../src/components/editor/scene-builder';

const r3fHarness = vi.hoisted(() => ({ scenes: [] as unknown[] }));

vi.mock('@react-three/fiber', async () => {
  const React = await import('react');
  const Three = await import('three');
  type State = {
    scene: THREE.Group;
    set: () => void;
    camera: THREE.PerspectiveCamera;
    gl: Record<string, () => void>;
    size: { width: number; height: number };
    viewport: { dpr: number };
  };
  const Context = React.createContext<State | null>(null);
  return {
    Canvas: ({ children }: { children?: React.ReactNode }) => {
      const stateRef = React.useRef<State | null>(null);
      if (!stateRef.current) {
        stateRef.current = {
          scene: new Three.Group(),
          set: () => undefined,
          camera: new Three.PerspectiveCamera(),
          gl: {
            setViewport: () => undefined,
            setScissor: () => undefined,
            setScissorTest: () => undefined,
          },
          size: { width: 800, height: 600 },
          viewport: { dpr: 1 },
        };
        r3fHarness.scenes.push(stateRef.current.scene);
      }
      return (
        <Context.Provider value={stateRef.current}>
          <div data-testid="mock-canvas">{children}</div>
        </Context.Provider>
      );
    },
    useThree: (selector?: (state: State) => unknown) => {
      const state = React.useContext(Context);
      if (!state) throw new Error('useThree called outside Canvas');
      return selector ? selector(state) : state;
    },
    useFrame: () => undefined,
  };
});

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  TransformControls: () => null,
}));

function drivableProject(uri: string): Project {
  const sample = createSampleProject();
  return {
    ...sample,
    uri,
    tracks: sample.tracks.map((track) =>
      track.objectId === 'sample-camera' ? { ...track, disabled: true } : track,
    ),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mountStudio(uri: string): Promise<{
  handle: React.RefObject<LumoraStudioHandle | null>;
  root: HTMLElement;
  scene: THREE.Group;
}> {
  const handle = createRef<LumoraStudioHandle>();
  const before = r3fHarness.scenes.length;
  render(<LumoraStudio ref={handle} initialProject={drivableProject(uri)} />);
  await waitFor(() => expect(handle.current?.runtime.editor.getProject()?.uri).toBe(uri));
  await waitFor(() => expect(r3fHarness.scenes.length).toBeGreaterThan(before));
  const roots = screen.getAllByTestId('lumora-studio');
  return {
    handle,
    root: roots[roots.length - 1]!,
    scene: r3fHarness.scenes[before] as THREE.Group,
  };
}

beforeEach(() => {
  r3fHarness.scenes = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('camera drive keyboard routing', () => {
  it('a drive key inside Studio A moves only A when two Studio instances are mounted', async () => {
    const a = await mountStudio('lumora://drive-a');
    const b = await mountStudio('lumora://drive-b');
    act(() => {
      a.handle.current!.runtime.editor.setSelection(['sample-camera']);
      b.handle.current!.runtime.editor.setSelection(['sample-camera']);
    });
    const cameraA = findNode(a.scene, 'sample-camera')!;
    const cameraB = findNode(b.scene, 'sample-camera')!;
    await act(async () => delay(60));
    const beforeA = cameraA.position.clone();
    const beforeB = cameraB.position.clone();

    fireEvent.keyDown(a.root, { key: 's', code: 'KeyS' });
    await act(async () => delay(120));
    fireEvent.keyUp(a.root, { key: 's', code: 'KeyS' });

    expect(cameraA.position.distanceTo(beforeA)).toBeGreaterThan(0.01);
    expect(cameraB.position.distanceTo(beforeB)).toBeLessThan(1e-9);
  });

  it('a drive key release inside Studio A is consumed only by A', async () => {
    const a = await mountStudio('lumora://drive-keyup-a');
    await mountStudio('lumora://drive-keyup-b');
    const releaseSpy = vi.spyOn(CameraDrive.prototype, 'release');

    fireEvent.keyUp(a.root, { key: 's', code: 'KeyS' });

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith('KeyS');
  });

  it('pointer interaction transfers keyboard drive ownership to the clicked Studio viewport', async () => {
    const a = await mountStudio('lumora://drive-focus-a');
    const b = await mountStudio('lumora://drive-focus-b');
    act(() => {
      a.handle.current!.runtime.editor.setSelection(['sample-camera']);
      b.handle.current!.runtime.editor.setSelection(['sample-camera']);
    });
    const cameraA = findNode(a.scene, 'sample-camera')!;
    const cameraB = findNode(b.scene, 'sample-camera')!;
    await act(async () => delay(60));
    const beforeA = cameraA.position.clone();
    const beforeB = cameraB.position.clone();
    within(a.root).getByTestId('timeline-play').focus();
    expect(a.root.contains(document.activeElement)).toBe(true);

    const viewportB = within(b.root).getByTestId('lumora-viewport');
    fireEvent.pointerDown(viewportB, { button: 0, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(document.activeElement).toBe(viewportB);
    fireEvent.keyDown(document.activeElement!, { key: 's', code: 'KeyS' });
    await act(async () => delay(120));
    fireEvent.keyUp(document.activeElement!, { key: 's', code: 'KeyS' });

    expect(cameraA.position.distanceTo(beforeA)).toBeLessThan(1e-9);
    expect(cameraB.position.distanceTo(beforeB)).toBeGreaterThan(0.01);
  });

  it('transferring focus while a drive key is held stops the previous Studio without a stuck key', async () => {
    const a = await mountStudio('lumora://drive-held-a');
    const b = await mountStudio('lumora://drive-held-b');
    act(() => {
      a.handle.current!.runtime.editor.setSelection(['sample-camera']);
      b.handle.current!.runtime.editor.setSelection(['sample-camera']);
    });
    const cameraA = findNode(a.scene, 'sample-camera')!;
    await act(async () => delay(60));
    const viewportA = within(a.root).getByTestId('lumora-viewport');
    const viewportB = within(b.root).getByTestId('lumora-viewport');
    fireEvent.pointerDown(viewportA, { button: 0, ctrlKey: true, clientX: 0, clientY: 0 });
    fireEvent.keyDown(viewportA, { key: 's', code: 'KeyS' });
    await act(async () => delay(120));

    fireEvent.pointerDown(viewportB, { button: 0, ctrlKey: true, clientX: 0, clientY: 0 });
    const atTransfer = cameraA.position.clone();
    fireEvent.keyUp(viewportB, { key: 's', code: 'KeyS' });
    await act(async () => delay(160));

    expect(cameraA.position.distanceTo(atTransfer)).toBeLessThan(1e-9);

    fireEvent.pointerDown(viewportA, { button: 0, ctrlKey: true, clientX: 0, clientY: 0 });
    fireEvent.keyDown(viewportA, { key: 's', code: 'KeyS' });
    await act(async () => delay(120));
    fireEvent.keyUp(viewportA, { key: 's', code: 'KeyS' });
    expect(cameraA.position.distanceTo(atTransfer)).toBeGreaterThan(0.01);
  });

  it('overwrite confirmation clears existing momentum and blocks drive keys from portal controls', async () => {
    const studio = await mountStudio('lumora://drive-modal');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const camera = findNode(studio.scene, 'sample-camera')!;
    await act(async () => delay(60));

    fireEvent.keyDown(studio.root, { key: 's', code: 'KeyS' });
    await act(async () => delay(100));
    expect(camera.position.z).not.toBeCloseTo(8, 3);
    fireEvent.click(within(studio.root).getByTestId('timeline-record'));
    const confirm = await screen.findByText('覆盖录制');
    const atOpen = camera.position.clone();

    await act(async () => delay(160));
    expect(camera.position.distanceTo(atOpen)).toBeLessThan(1e-9);
    fireEvent.keyUp(window, { key: 's', code: 'KeyS' });
    fireEvent.keyDown(confirm, { key: 'w', code: 'KeyW' });
    fireEvent.keyDown(confirm, { key: 'ArrowLeft', code: 'ArrowLeft' });
    await act(async () => delay(120));

    expect(camera.position.distanceTo(atOpen)).toBeLessThan(1e-9);
    expect(screen.getByTestId('overwrite-confirm')).toBeInTheDocument();
  });
});
