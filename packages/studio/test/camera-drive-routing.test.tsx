import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import { CameraDrive } from '../src/components/editor/camera-drive';
import { flushOrbitControlsPendingState } from '../src/components/editor/EditorViewport';
import { findNode } from '../src/components/editor/scene-builder';

const r3fHarness = vi.hoisted(() => ({
  scenes: [] as unknown[],
  states: [] as Array<{ camera: THREE.PerspectiveCamera }>,
  orbitProps: [] as Array<{ enabled?: boolean }>,
}));

vi.mock('@react-three/fiber', async () => {
  const React = await import('react');
  const Three = await import('three');
  type State = {
    scene: THREE.Group;
    set: (next: Partial<State>) => void;
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
          set: (next) => {
            if (next.camera) stateRef.current!.camera = next.camera;
          },
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
        r3fHarness.states.push(stateRef.current);
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
  OrbitControls: (props: { enabled?: boolean }) => {
    r3fHarness.orbitProps.push(props);
    return null;
  },
  TransformControls: () => null,
}));

function drivableProject(uri: string, includeDisabledOverwriteTrack = false): Project {
  const sample = createSampleProject();
  return {
    ...sample,
    uri,
    tracks: sample.tracks
      .filter((track) => track.objectId !== 'sample-camera' || includeDisabledOverwriteTrack)
      .map((track) => track.objectId === 'sample-camera' ? { ...track, disabled: true } : track),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mountStudio(projectOrUri: Project | string, includeDisabledOverwriteTrack = false): Promise<{
  handle: React.RefObject<LumoraStudioHandle | null>;
  root: HTMLElement;
  scene: THREE.Group;
}> {
  const handle = createRef<LumoraStudioHandle>();
  const before = r3fHarness.scenes.length;
  const project = typeof projectOrUri === 'string'
    ? drivableProject(projectOrUri, includeDisabledOverwriteTrack)
    : projectOrUri;
  render(<LumoraStudio ref={handle} initialProject={project} />);
  await waitFor(() => expect(handle.current?.runtime.editor.getProject()?.uri).toBe(project.uri));
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
  r3fHarness.states = [];
  r3fHarness.orbitProps = [];
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('camera drive keyboard routing', () => {
  it('flushes OrbitControls damping without changing the authoritative camera pose', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(4, 3, 8);
    camera.lookAt(0, 1, 0);
    const target = new THREE.Vector3(0, 1, 0);
    const initialPosition = camera.position.clone();
    const initialQuaternion = camera.quaternion.clone();
    const initialTarget = target.clone();
    const update = vi.fn(() => {
      camera.position.set(1, 2, 3);
      camera.lookAt(9, 8, 7);
      target.set(9, 8, 7);
    });
    flushOrbitControlsPendingState({
      object: camera,
      target,
      update,
      enableDamping: true,
      autoRotate: false,
    } as never);

    expect(update).toHaveBeenCalledTimes(1);
    expect(camera.position.distanceTo(initialPosition)).toBeLessThan(1e-9);
    expect(camera.quaternion.angleTo(initialQuaternion)).toBeLessThan(1e-9);
    expect(target.distanceTo(initialTarget)).toBeLessThan(1e-9);
  });

  it('keeps OrbitControls available while the idle director camera is selected', async () => {
    await mountStudio('lumora://director-orbit-controls');

    expect(r3fHarness.orbitProps.some((props) => props.enabled === true)).toBe(true);
  });

  it('drives the rendered camera in director mode', async () => {
    const studio = await mountStudio('lumora://director-render-camera');
    const renderedCamera = r3fHarness.states[r3fHarness.states.length - 1]!.camera;
    await act(async () => delay(60));
    const before = renderedCamera.position.clone();

    fireEvent.keyDown(studio.root, { key: 'w', code: 'KeyW' });
    await act(async () => delay(220));
    fireEvent.keyUp(studio.root, { key: 'w', code: 'KeyW' });

    expect(renderedCamera.position.distanceTo(before)).toBeGreaterThan(0.01);
  });

  it('rotates the rendered camera with a right-button drag in director mode', async () => {
    const studio = await mountStudio('lumora://director-render-look');
    const renderedCamera = r3fHarness.states[r3fHarness.states.length - 1]!.camera;
    const viewport = within(studio.root).getByTestId('lumora-viewport');
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    await act(async () => delay(60));
    const before = renderedCamera.quaternion.clone();

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 21, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 21, clientX: 150, clientY: 80 });
    fireEvent.pointerUp(viewport, { button: 2, pointerId: 21, clientX: 150, clientY: 80 });
    await act(async () => delay(100));

    expect(renderedCamera.quaternion.angleTo(before)).toBeGreaterThan(0.01);
  });

  it('keeps the rendered director camera authoritative when a scene camera is selected', async () => {
    const studio = await mountStudio('lumora://director-selected-render-camera');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const renderedCamera = r3fHarness.states[r3fHarness.states.length - 1]!.camera;
    await act(async () => delay(60));
    const before = renderedCamera.position.clone();

    fireEvent.keyDown(studio.root, { key: 'w', code: 'KeyW' });
    await act(async () => delay(180));
    fireEvent.keyUp(studio.root, { key: 'w', code: 'KeyW' });

    expect(renderedCamera.position.distanceTo(before)).toBeGreaterThan(0.01);
  });

  it('does not mirror the director camera default optics into a selected scene camera', async () => {
    const studio = await mountStudio('lumora://director-optics-preserved');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    const camera = findNode(studio.scene, 'sample-camera-2') as THREE.PerspectiveCamera;
    const initialFov = camera.fov;

    await act(async () => delay(120));

    expect(camera.fov).toBeCloseTo(initialFov, 8);
    expect(camera.userData.focalLength).toBeUndefined();
  });

  it('mirrors a director tap movement to the selected scene camera', async () => {
    const studio = await mountStudio('lumora://director-tap-mirror');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    const camera = findNode(studio.scene, 'sample-camera-2')!;
    const before = camera.position.clone();
    const viewport = within(studio.root).getByTestId('lumora-viewport');

    await act(async () => delay(60));
    fireEvent.keyDown(viewport, { key: 'w', code: 'KeyW' });
    fireEvent.keyUp(viewport, { key: 'w', code: 'KeyW' });
    await act(async () => delay(80));

    expect(camera.position.distanceTo(before)).toBeGreaterThan(0.05);
  });

  it('does not replay a held key after the director mirror target changes', async () => {
    const studio = await mountStudio('lumora://director-target-change-clears-input');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    const nextCamera = findNode(studio.scene, 'sample-camera')!;
    const before = nextCamera.position.clone();
    const viewport = within(studio.root).getByTestId('lumora-viewport');

    await act(async () => delay(60));
    fireEvent.keyDown(viewport, { key: 'w', code: 'KeyW' });
    await act(async () => delay(80));
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    await act(async () => delay(180));
    fireEvent.keyUp(viewport, { key: 'w', code: 'KeyW' });

    expect(nextCamera.position.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('clears held input when recording starts on the same POV camera', async () => {
    const studio = await mountStudio('lumora://recording-boundary-same-pov');
    const select = within(studio.root).getByTestId('view-mode-select');
    fireEvent.change(select, { target: { value: 'sample-camera-2' } });
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    const camera = findNode(studio.scene, 'sample-camera-2')!;
    const viewport = within(studio.root).getByTestId('lumora-viewport');

    await act(async () => delay(60));
    fireEvent.keyDown(viewport, { key: 'w', code: 'KeyW' });
    await act(async () => delay(160));
    fireEvent.click(within(studio.root).getByTestId('timeline-record'));
    await waitFor(() => expect(within(studio.root).getByTestId('timeline-record')).toHaveTextContent('■'));
    const afterStart = camera.position.clone();

    await act(async () => delay(220));
    fireEvent.keyUp(viewport, { key: 'w', code: 'KeyW' });

    expect(camera.position.distanceTo(afterStart)).toBeLessThan(1e-9);
  });

  it('reattaches the same POV camera after recording starts and stops', async () => {
    const studio = await mountStudio('lumora://recording-boundary-same-pov-reattach');
    const select = within(studio.root).getByTestId('view-mode-select');
    fireEvent.change(select, { target: { value: 'sample-camera-2' } });
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    const camera = findNode(studio.scene, 'sample-camera-2')!;
    const viewport = within(studio.root).getByTestId('lumora-viewport');

    await act(async () => delay(60));
    fireEvent.click(within(studio.root).getByTestId('timeline-record'));
    await act(async () => delay(80));
    fireEvent.click(within(studio.root).getByTestId('timeline-record'));
    await act(async () => delay(60));

    const recordedTracks = studio.handle.current!.runtime.editor.getProject()?.tracks.filter(
      (track) => track.objectId === 'sample-camera-2',
    ) ?? [];
    for (const track of recordedTracks) {
      act(() => {
        studio.handle.current!.runtime.editor.updateTrack(
          track.id,
          (next) => ({ ...next, disabled: true }),
          'disable recorded track',
        );
      });
    }

    const before = camera.position.clone();
    fireEvent.keyDown(viewport, { key: 'w', code: 'KeyW' });
    await act(async () => delay(180));
    fireEvent.keyUp(viewport, { key: 'w', code: 'KeyW' });

    expect(camera.position.distanceTo(before)).toBeGreaterThan(0.01);
  });

  it('shows a live accessible direction status in director mode', async () => {
    const studio = await mountStudio('lumora://director-direction-status');
    await waitFor(() => expect(within(studio.root).getByTestId('camera-direction-status')).toBeVisible());
    const status = within(studio.root).getByTestId('camera-direction-status');
    await waitFor(() => expect(status.textContent).toMatch(/^Heading \d+ deg \| Pitch [+-]?\d+ deg$/));
    expect(status).toHaveAttribute('aria-hidden', 'true');
    const announcement = within(studio.root).getByTestId('camera-direction-announcement');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveAttribute('aria-atomic', 'true');
    await waitFor(() => expect(announcement.textContent).toMatch(/^Heading \d+ deg \| Pitch [+-]?\d+ deg$/));

    const arrow = studio.root.querySelector<HTMLElement>('.lumora-camera-direction__arrow')!;
    const mutation = vi.fn();
    const observer = new MutationObserver(mutation);
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    observer.observe(arrow, { attributes: true, attributeFilter: ['style'] });
    await act(async () => delay(80));
    observer.disconnect();
    expect(mutation).not.toHaveBeenCalled();
  });

  it('shows a stable live warning and blocks director mirroring through a singular ancestor', async () => {
    const project = drivableProject('lumora://director-singular-warning');
    const objects = project.objects.map((object) => {
      if (object.id === 'sample-group') {
        return {
          ...object,
          transform: { ...object.transform, scale: [0, 1, 1] as [number, number, number] },
        };
      }
      return object.id === 'sample-camera-2' ? { ...object, parentId: 'sample-group' } : object;
    });
    const scenes = project.scenes.map((scene) => ({
      ...scene,
      rootObjectIds: scene.rootObjectIds.filter((id) => id !== 'sample-camera-2'),
    }));
    const studio = await mountStudio({ ...project, objects, scenes });
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    const camera = findNode(studio.scene, 'sample-camera-2')!;
    const before = camera.position.clone();
    const warning = within(studio.root).getByTestId('camera-transform-warning');
    await waitFor(() => expect(warning).toHaveTextContent('ancestor transform is singular'));

    const mutation = vi.fn();
    const observer = new MutationObserver(mutation);
    observer.observe(warning, { childList: true, characterData: true, subtree: true });
    await act(async () => delay(80));
    observer.disconnect();
    expect(mutation).not.toHaveBeenCalled();

    fireEvent.keyDown(studio.root, { key: 'w', code: 'KeyW' });
    await act(async () => delay(120));
    fireEvent.keyUp(studio.root, { key: 'w', code: 'KeyW' });
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('right-button dragging rotates the selected camera without translating it', async () => {
    const studio = await mountStudio('lumora://drive-mouse-look');
    const renderedCamera = r3fHarness.states[r3fHarness.states.length - 1]!.camera;
    const beforePosition = renderedCamera.position.clone();
    const beforeQuaternion = renderedCamera.quaternion.clone();
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const viewport = within(studio.root).getByTestId('lumora-viewport');
    await act(async () => delay(60));

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 7, clientX: 140, clientY: 80 });
    await act(async () => delay(80));
    fireEvent.pointerUp(viewport, { button: 2, pointerId: 7, clientX: 140, clientY: 80 });

    expect(renderedCamera.position.distanceTo(beforePosition)).toBeLessThan(1e-9);
    expect(renderedCamera.quaternion.angleTo(beforeQuaternion)).toBeGreaterThan(0.001);
  });

  it('keyboard-mouse mode keeps translation and pointer look independent', async () => {
    const studio = await mountStudio('lumora://drive-independent-inputs');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const camera = findNode(studio.scene, 'sample-camera')!;
    await act(async () => delay(60));
    const beforePosition = camera.position.clone();
    const beforeQuaternion = camera.quaternion.clone();

    fireEvent.keyDown(studio.root, { key: 'w', code: 'KeyW' });
    await act(async () => delay(180));
    fireEvent.keyUp(studio.root, { key: 'w', code: 'KeyW' });
    fireEvent.keyDown(studio.root, { key: 'ArrowLeft', code: 'ArrowLeft' });
    await act(async () => delay(80));
    fireEvent.keyUp(studio.root, { key: 'ArrowLeft', code: 'ArrowLeft' });

    expect(camera.position.distanceTo(beforePosition)).toBeGreaterThan(0.01);
    expect(camera.quaternion.angleTo(beforeQuaternion)).toBeLessThan(1e-9);
  });

  it('keeps driving the recording camera after selecting another camera or clearing selection', async () => {
    const studio = await mountStudio('lumora://drive-recording-camera-lock');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    fireEvent.click(within(studio.root).getByTestId('timeline-record'));
    const recordingCamera = findNode(studio.scene, 'sample-camera')!;
    const otherCamera = findNode(studio.scene, 'sample-camera-2')!;
    await act(async () => delay(60));
    const recordingStart = recordingCamera.position.clone();
    const otherStart = otherCamera.position.clone();

    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    fireEvent.keyDown(studio.root, { key: 's', code: 'KeyS' });
    await act(async () => delay(180));
    fireEvent.keyUp(studio.root, { key: 's', code: 'KeyS' });

    expect(recordingCamera.position.distanceTo(recordingStart)).toBeGreaterThan(0.01);
    expect(otherCamera.position.distanceTo(otherStart)).toBeLessThan(1e-9);

    act(() => studio.handle.current!.runtime.editor.clearSelection());
    const beforeDeselectedDrive = recordingCamera.position.clone();
    fireEvent.keyDown(studio.root, { key: 's', code: 'KeyS' });
    await act(async () => delay(180));
    fireEvent.keyUp(studio.root, { key: 's', code: 'KeyS' });

    expect(recordingCamera.position.distanceTo(beforeDeselectedDrive)).toBeGreaterThan(0.01);
    expect(otherCamera.position.distanceTo(otherStart)).toBeLessThan(1e-9);
  });

  it('keyboard-only mode ignores pointer look and rotates with arrow keys', async () => {
    const studio = await mountStudio('lumora://drive-keyboard-only');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    fireEvent.click(within(studio.root).getByRole('button', { name: '纯键盘操控' }));
    const camera = findNode(studio.scene, 'sample-camera')!;
    const beforePointer = camera.quaternion.clone();
    const viewport = within(studio.root).getByTestId('lumora-viewport');
    await act(async () => delay(60));

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 8, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 8, clientX: 150, clientY: 80 });
    fireEvent.pointerUp(viewport, { button: 2, pointerId: 8, clientX: 150, clientY: 80 });
    await act(async () => delay(80));
    expect(camera.quaternion.angleTo(beforePointer)).toBeLessThan(1e-9);

    fireEvent.keyDown(studio.root, { key: 'ArrowLeft', code: 'ArrowLeft' });
    await act(async () => delay(100));
    fireEvent.keyUp(studio.root, { key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(camera.quaternion.angleTo(beforePointer)).toBeGreaterThan(0.001);
  });

  it('suppresses the viewport context menu while keeping pointer capture scoped to camera look', async () => {
    const studio = await mountStudio('lumora://drive-pointer-lifecycle');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const viewport = within(studio.root).getByTestId('lumora-viewport');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(viewport, { setPointerCapture, releasePointerCapture });
    const look = vi.spyOn(CameraDrive.prototype, 'look');
    await act(async () => delay(60));

    const idleContextMenu = fireEvent.contextMenu(viewport);
    expect(idleContextMenu).toBe(false);
    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 9, clientX: 10, clientY: 10 });
    expect(setPointerCapture).toHaveBeenCalledWith(9);
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 9, clientX: 30, clientY: 20 });
    expect(look).toHaveBeenCalled();
    fireEvent.pointerUp(viewport, { button: 2, pointerId: 9, clientX: 30, clientY: 20 });
    expect(releasePointerCapture).toHaveBeenCalledWith(9);
    expect(fireEvent.contextMenu(viewport)).toBe(false);
    expect(fireEvent.contextMenu(viewport)).toBe(false);

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 10, clientX: 30, clientY: 20 });
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 10, clientX: 45, clientY: 30 });
    const callsAtButtonRelease = look.mock.calls.length;
    fireEvent.pointerMove(viewport, { buttons: 0, pointerId: 10, clientX: 50, clientY: 35 });
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 10, clientX: 60, clientY: 40 });
    expect(look).toHaveBeenCalledTimes(callsAtButtonRelease);

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 11, clientX: 60, clientY: 40 });
    fireEvent.lostPointerCapture(viewport, { pointerId: 11 });
    const callsAtCaptureLoss = look.mock.calls.length;
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 11, clientX: 80, clientY: 50 });
    expect(look).toHaveBeenCalledTimes(callsAtCaptureLoss);

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 12, clientX: 80, clientY: 50 });
    fireEvent.pointerUp(window, { button: 2, pointerId: 12, clientX: 90, clientY: 55 });
    const callsAtWindowRelease = look.mock.calls.length;
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 12, clientX: 100, clientY: 60 });
    expect(look).toHaveBeenCalledTimes(callsAtWindowRelease);
  });

  it.each(['track', 'playback', 'export'] as const)(
    'suppresses the viewport context menu while %s disables camera drive',
    async (owner) => {
      const project = owner === 'track'
        ? createSampleProject()
        : drivableProject(`lumora://drive-context-menu-${owner}`);
      const studio = await mountStudio(project);
      act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
      fireEvent.change(within(studio.root).getByTestId('view-mode-select'), {
        target: { value: 'sample-camera' },
      });
      const viewport = within(studio.root).getByTestId('lumora-viewport');

      if (owner === 'playback') {
        fireEvent.click(within(studio.root).getByTestId('timeline-play'));
      } else if (owner === 'export') {
        fireEvent.click(within(studio.root).getByTestId('open-export-workspace'));
        await screen.findByTestId('export-workspace');
      }

      expect(fireEvent.contextMenu(viewport)).toBe(false);
    },
  );

  it('identifies and locates only the enabled tracks taking over the current camera', async () => {
    const studio = await mountStudio(createSampleProject());
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    fireEvent.change(within(studio.root).getByTestId('view-mode-select'), {
      target: { value: 'sample-camera' },
    });

    const status = within(studio.root).getByTestId('camera-control-status');
    expect(status).toHaveTextContent('主摄像机推镜');
    expect(status).toHaveTextContent('主摄像机变焦');
    expect(status).toHaveTextContent('禁用这些轨道后可手动操控');
    expect(status).not.toHaveTextContent('立方体旋转');

    const firstLane = within(studio.root).getByTestId('track-lane-sample-track-camera-dolly');
    const scrollIntoView = vi.fn();
    Object.assign(firstLane, { scrollIntoView });
    fireEvent.click(within(studio.root).getByRole('button', { name: /定位轨道/ }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    expect(within(firstLane).getByTestId('track-disabled-sample-track-camera-dolly')).toHaveFocus();

    fireEvent.click(within(firstLane).getByTestId('track-disabled-sample-track-camera-dolly'));
    expect(status).not.toHaveTextContent('主摄像机推镜');
    expect(status).toHaveTextContent('主摄像机变焦');
    fireEvent.click(within(studio.root).getByTestId('track-disabled-sample-track-camera-focus'));
    expect(status).toHaveTextContent('机位“主摄像机”可手动操控');
  });

  it('does not report an unrelated object track as a camera takeover', async () => {
    const studio = await mountStudio(createSampleProject());
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera-2']));
    fireEvent.change(within(studio.root).getByTestId('view-mode-select'), {
      target: { value: 'sample-camera-2' },
    });

    const status = within(studio.root).getByTestId('camera-control-status');
    expect(status).toHaveTextContent('机位“俯拍机位”可手动操控');
    expect(status).not.toHaveTextContent('立方体旋转');
    expect(within(studio.root).queryByRole('button', { name: /定位轨道/ })).not.toBeInTheDocument();
  });

  it('explains that playback must be paused before camera drive resumes', async () => {
    const studio = await mountStudio('lumora://drive-playback-status');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    fireEvent.change(within(studio.root).getByTestId('view-mode-select'), {
      target: { value: 'sample-camera' },
    });
    fireEvent.click(within(studio.root).getByTestId('timeline-play'));

    const status = within(studio.root).getByTestId('camera-control-status');
    expect(status).toHaveTextContent('播放正在接管机位；暂停播放后可手动操控。');
  });

  it('explains that the export workspace must close before camera drive resumes', async () => {
    const studio = await mountStudio('lumora://drive-export-status');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    fireEvent.change(within(studio.root).getByTestId('view-mode-select'), {
      target: { value: 'sample-camera' },
    });
    fireEvent.click(within(studio.root).getByTestId('open-export-workspace'));
    await screen.findByTestId('export-workspace');

    expect(within(studio.root).getByTestId('camera-control-status')).toHaveTextContent(
      '导出工作区正在接管视口；关闭导出工作区后可手动操控。',
    );
  });

  it('aggregates export, playback, and track blockers without a false recovery promise', async () => {
    const studio = await mountStudio(createSampleProject());
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    fireEvent.change(within(studio.root).getByTestId('view-mode-select'), {
      target: { value: 'sample-camera' },
    });
    fireEvent.click(within(studio.root).getByTestId('timeline-play'));
    fireEvent.click(within(studio.root).getByTestId('open-export-workspace'));
    await screen.findByTestId('export-workspace');

    const exportStatus = within(studio.root).getByTestId('export-camera-control-status');
    expect(exportStatus).toHaveTextContent('导出工作区正在接管视口；关闭导出工作区后可手动操控。');
    expect(exportStatus).toHaveTextContent('播放正在接管机位；暂停播放后可手动操控。');
    expect(exportStatus).toHaveTextContent('启用轨道“主摄像机推镜”、“主摄像机变焦”正在接管机位“主摄像机”；禁用这些轨道后可手动操控。');

    fireEvent.click(within(studio.root).getByRole('button', { name: '关闭导出' }));
    expect(within(studio.root).getByTestId('camera-control-status')).toHaveTextContent(
      '播放正在接管机位；暂停播放后可手动操控。',
    );
    expect(within(studio.root).getByTestId('camera-control-status')).toHaveTextContent('主摄像机推镜');
  });

  it('defines the current POV as the camera view, independent of tree selection in director mode', async () => {
    const studio = await mountStudio(createSampleProject());
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));

    const status = within(studio.root).getByTestId('camera-control-status');
    expect(within(studio.root).getByTestId('view-mode-select')).toHaveValue('director');
    expect(status).toHaveTextContent('导演视图可手动操控。');
    expect(status).not.toHaveTextContent('主摄像机推镜');
    expect(within(studio.root).queryByRole('button', { name: /定位轨道/ })).not.toBeInTheDocument();
  });

  it('lost pointer capture clears queued look while held keyboard movement continues', async () => {
    const studio = await mountStudio('lumora://drive-lost-capture');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const camera = r3fHarness.states[r3fHarness.states.length - 1]!.camera;
    const viewport = within(studio.root).getByTestId('lumora-viewport');
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    const press = vi.spyOn(CameraDrive.prototype, 'press');
    await act(async () => delay(60));

    fireEvent.keyDown(viewport, { key: 'w', code: 'KeyW' });
    const drive = press.mock.instances[press.mock.instances.length - 1] as unknown as CameraDrive;
    act(() => {
      drive.update(0.06);
      drive.update(0.08);
    });
    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 14, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 14, clientX: 100, clientY: 60 });
    act(() => drive.update(1 / 60));
    fireEvent.lostPointerCapture(viewport, { pointerId: 14 });

    const rotationAtLoss = camera.quaternion.clone();
    const positionAtLoss = camera.position.clone();
    expect(drive.hasInput).toBe(true);
    act(() => drive.update(0.1));
    fireEvent.keyUp(viewport, { key: 'w', code: 'KeyW' });

    expect(camera.quaternion.angleTo(rotationAtLoss)).toBeLessThan(1e-9);
    expect(camera.position.distanceTo(positionAtLoss)).toBeGreaterThan(0.05);
  });

  it('right-button camera look reclaims focus from a control before subsequent keyboard driving', async () => {
    const studio = await mountStudio('lumora://drive-pointer-focus-transfer');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const camera = findNode(studio.scene, 'sample-camera')!;
    const viewport = within(studio.root).getByTestId('lumora-viewport');
    const speed = within(studio.root).getByTestId('camera-control-speed');
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    await act(async () => delay(60));
    speed.focus();
    expect(document.activeElement).toBe(speed);

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 13, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(viewport, { button: 2, pointerId: 13, clientX: 20, clientY: 20 });
    expect(document.activeElement).toBe(viewport);
    const beforeKeyboardDrive = camera.position.clone();
    fireEvent.keyDown(viewport, { key: 's', code: 'KeyS' });
    await act(async () => delay(220));
    fireEvent.keyUp(viewport, { key: 's', code: 'KeyS' });

    expect(camera.position.distanceTo(beforeKeyboardDrive)).toBeGreaterThan(0.01);
  });

  it.each(['blur', 'export', 'overwrite'] as const)(
    'ends camera-look and clears residual rotation on %s',
    async (terminal) => {
      const studio = await mountStudio(`lumora://drive-look-${terminal}`, terminal === 'overwrite');
      act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
      const camera = findNode(studio.scene, 'sample-camera')!;
      const viewport = within(studio.root).getByTestId('lumora-viewport');
      const releasePointerCapture = vi.fn();
      Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture });
      const look = vi.spyOn(CameraDrive.prototype, 'look');
      await act(async () => delay(60));

      fireEvent.pointerDown(viewport, { button: 2, buttons: 2, pointerId: 10, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 10, clientX: 45, clientY: 25 });
      await act(async () => delay(40));
      if (terminal === 'blur') {
        const outside = document.createElement('button');
        document.body.append(outside);
        viewport.focus();
        outside.focus();
        outside.remove();
      }
      if (terminal === 'export') {
        fireEvent.click(within(studio.root).getByTestId('open-export-workspace'));
        await screen.findByTestId('export-workspace');
      }
      if (terminal === 'overwrite') {
        fireEvent.click(within(studio.root).getByTestId('timeline-record'));
        await screen.findByTestId('overwrite-confirm');
      }
      await act(async () => delay(40));
      const callsAtTerminal = look.mock.calls.length;
      const rotationAtTerminal = camera.quaternion.clone();
      fireEvent.pointerMove(viewport, { buttons: 2, pointerId: 10, clientX: 80, clientY: 40 });
      await act(async () => delay(80));

      expect(look).toHaveBeenCalledTimes(callsAtTerminal);
      expect(releasePointerCapture).toHaveBeenCalledWith(10);
      expect(camera.quaternion.angleTo(rotationAtTerminal)).toBeLessThan(1e-6);
    },
  );

  it('does not consume Ctrl+W or move the recording camera', async () => {
    const studio = await mountStudio('lumora://drive-browser-shortcut');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const camera = findNode(studio.scene, 'sample-camera')!;
    await act(async () => delay(60));
    const before = camera.position.clone();
    const closeTab = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
    });

    studio.root.dispatchEvent(closeTab);
    await act(async () => delay(120));

    expect(closeTab.defaultPrevented).toBe(false);
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('hard-stops a held drive key when a protected modifier becomes active', async () => {
    const studio = await mountStudio('lumora://drive-held-before-modifier');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const camera = findNode(studio.scene, 'sample-camera')!;
    await act(async () => delay(60));

    fireEvent.keyDown(studio.root, { key: 'w', code: 'KeyW' });
    await act(async () => delay(220));
    fireEvent.keyDown(studio.root, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    const atModifier = camera.position.clone();
    await act(async () => delay(160));
    fireEvent.keyUp(studio.root, { key: 'w', code: 'KeyW', ctrlKey: true });
    fireEvent.keyUp(studio.root, { key: 'Control', code: 'ControlLeft' });

    expect(camera.position.distanceTo(atModifier)).toBeLessThan(1e-9);
  });

  it('uses Shift+R as the documented default recording shortcut', async () => {
    const studio = await mountStudio('lumora://recording-default-shortcut', true);
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const record = within(studio.root).getByTestId('timeline-record');

    expect(record).toHaveAttribute('title', expect.stringContaining('Shift+R'));
    fireEvent.keyDown(studio.root, { key: 'R', code: 'KeyR', shiftKey: true });

    expect(await screen.findByTestId('overwrite-confirm')).toBeInTheDocument();
  });

  it('rejects Ctrl+W in recording shortcut settings without persisting it', async () => {
    const studio = await mountStudio('lumora://recording-shortcut-settings');
    fireEvent.click(within(studio.root).getByTestId('recording-shortcut-settings'));
    const dialog = await screen.findByTestId('recording-shortcut-dialog');

    fireEvent.change(within(dialog).getByTestId('recording-shortcut-key'), {
      target: { value: 'w' },
    });
    fireEvent.click(within(dialog).getByLabelText('Ctrl'));
    fireEvent.click(within(dialog).getByLabelText('Shift'));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Ctrl+W');
    expect(within(dialog).getByTestId('recording-shortcut-save')).toBeDisabled();
    expect(localStorage.getItem('lumora.recording-shortcut.v1')).toBeNull();
  });

  it('rejects drive and command-palette conflicts in recording shortcut settings', async () => {
    const studio = await mountStudio('lumora://recording-app-shortcut-conflicts');
    fireEvent.click(within(studio.root).getByTestId('recording-shortcut-settings'));
    const dialog = await screen.findByTestId('recording-shortcut-dialog');
    const key = within(dialog).getByTestId('recording-shortcut-key');

    fireEvent.change(key, { target: { value: 'w' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Shift+W');
    expect(within(dialog).getByTestId('recording-shortcut-save')).toBeDisabled();

    fireEvent.change(key, { target: { value: 'k' } });
    fireEvent.click(within(dialog).getByLabelText('Ctrl'));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Ctrl+Shift+K');
    expect(within(dialog).getByTestId('recording-shortcut-save')).toBeDisabled();
    expect(localStorage.getItem('lumora.recording-shortcut.v1')).toBeNull();
  });

  it('closes shortcut settings with Escape after focus leaves and restores the trigger', async () => {
    const studio = await mountStudio('lumora://recording-shortcut-focus');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const trigger = within(studio.root).getByTestId('recording-shortcut-settings');
    fireEvent.click(trigger);
    expect(await screen.findByTestId('recording-shortcut-dialog')).toBeInTheDocument();

    const outside = within(studio.root).getByTestId('project-menu');
    outside.focus();
    expect(outside).toHaveFocus();
    fireEvent.keyDown(outside, { key: 'Escape', code: 'Escape' });

    expect(screen.queryByTestId('recording-shortcut-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(studio.handle.current!.runtime.editor.getSelection()).toEqual(['sample-camera']);
  });

  it('protects active and pending-save recordings but not clean projects on beforeunload', async () => {
    const studio = await mountStudio('lumora://recording-beforeunload', true);
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    await waitFor(() =>
      expect(within(studio.root).getByTestId('save-state-badge')).toHaveTextContent('已保存'),
    );

    await waitFor(() => {
      const clean = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(clean);
      expect(clean.defaultPrevented).toBe(false);
    });

    fireEvent.click(within(studio.root).getByTestId('timeline-record'));
    fireEvent.click(await screen.findByText('覆盖录制'));
    await waitFor(() => expect(within(studio.root).getByTestId('timeline-record')).toHaveTextContent('■'));
    const active = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(active);
    expect(active.defaultPrevented).toBe(true);

    await act(async () => delay(80));
    fireEvent.click(within(studio.root).getByTestId('timeline-record'));
    const pendingSave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pendingSave);
    expect(pendingSave.defaultPrevented).toBe(true);

    await waitFor(
      () => expect(within(studio.root).getByTestId('save-state-badge')).toHaveTextContent('已保存'),
      { timeout: 4000 },
    );
    const saved = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });

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
    await act(async () => delay(220));
    fireEvent.keyUp(a.root, { key: 's', code: 'KeyS' });

    expect(cameraA.position.distanceTo(beforeA)).toBeGreaterThan(0.01);
    expect(cameraB.position.distanceTo(beforeB)).toBeLessThan(1e-9);
  });

  it('freezes a held camera drive key when the export workspace opens', async () => {
    const studio = await mountStudio('lumora://drive-export-freeze');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const camera = findNode(studio.scene, 'sample-camera')!;
    const staticPosition = camera.position.clone();

    fireEvent.keyDown(studio.root, { key: 's', code: 'KeyS' });
    await act(async () => delay(220));
    expect(camera.position.distanceTo(staticPosition)).toBeGreaterThan(0.01);

    fireEvent.click(within(studio.root).getByTestId('open-export-workspace'));
    await waitFor(() => expect(within(studio.root).getByTestId('export-workspace')).toBeVisible());
    const frozenPosition = camera.position.clone();
    expect(frozenPosition.distanceTo(staticPosition)).toBeGreaterThan(0.01);
    await act(async () => delay(120));
    fireEvent.keyUp(studio.root, { key: 's', code: 'KeyS' });

    expect(camera.position.distanceTo(frozenPosition)).toBeLessThan(1e-9);
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
    await act(async () => delay(220));
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
    await act(async () => delay(220));

    fireEvent.pointerDown(viewportB, { button: 0, ctrlKey: true, clientX: 0, clientY: 0 });
    const atTransfer = cameraA.position.clone();
    fireEvent.keyUp(viewportB, { key: 's', code: 'KeyS' });
    await act(async () => delay(160));

    expect(cameraA.position.distanceTo(atTransfer)).toBeLessThan(1e-9);

    fireEvent.pointerDown(viewportA, { button: 0, ctrlKey: true, clientX: 0, clientY: 0 });
    fireEvent.keyDown(viewportA, { key: 's', code: 'KeyS' });
    await act(async () => delay(220));
    fireEvent.keyUp(viewportA, { key: 's', code: 'KeyS' });
    expect(cameraA.position.distanceTo(atTransfer)).toBeGreaterThan(0.01);
  });

  it('clears held drive input when focus leaves Studio A and rebinds when focus returns', async () => {
    const a = await mountStudio('lumora://drive-body-keyup-a');
    await mountStudio('lumora://drive-body-keyup-b');
    act(() => a.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const cameraA = findNode(a.scene, 'sample-camera')!;
    const focusTarget = document.createElement('div');
    focusTarget.tabIndex = 0;
    a.root.append(focusTarget);
    await act(async () => delay(60));

    focusTarget.focus();
    fireEvent.keyDown(focusTarget, { key: 's', code: 'KeyS' });
    await act(async () => delay(220));
    focusTarget.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyUp(document.body, { key: 's', code: 'KeyS' });
    const atRelease = cameraA.position.clone();
    await act(async () => delay(160));

    expect(cameraA.position.distanceTo(atRelease)).toBeLessThan(1e-9);

    focusTarget.focus();
    const beforeRebind = cameraA.position.clone();
    fireEvent.keyDown(focusTarget, { key: 's', code: 'KeyS' });
    await act(async () => delay(220));
    fireEvent.keyUp(focusTarget, { key: 's', code: 'KeyS' });

    expect(cameraA.position.distanceTo(beforeRebind)).toBeGreaterThan(0.01);
  });

  it('releases a held drive key even when its scoped keyup was canceled', async () => {
    const a = await mountStudio('lumora://drive-canceled-keyup-a');
    await mountStudio('lumora://drive-canceled-keyup-b');
    act(() => a.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const releaseSpy = vi.spyOn(CameraDrive.prototype, 'release');
    await act(async () => delay(60));

    fireEvent.keyDown(a.root, { key: 's', code: 'KeyS' });
    const canceledKeyUp = new KeyboardEvent('keyup', {
      bubbles: true,
      cancelable: true,
      key: 's',
      code: 'KeyS',
    });
    canceledKeyUp.preventDefault();
    a.root.dispatchEvent(canceledKeyUp);

    expect(canceledKeyUp.defaultPrevented).toBe(true);
    expect(releaseSpy).toHaveBeenCalledWith('KeyS');
  });

  it('overwrite confirmation clears existing momentum and blocks drive keys from portal controls', async () => {
    const studio = await mountStudio('lumora://drive-modal', true);
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
    const closeTab = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
    });
    confirm.dispatchEvent(closeTab);
    await act(async () => delay(120));

    expect(camera.position.distanceTo(atOpen)).toBeLessThan(1e-9);
    expect(closeTab.defaultPrevented).toBe(false);
    expect(screen.getByTestId('overwrite-confirm')).toBeInTheDocument();
  });
});
