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
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('camera drive keyboard routing', () => {
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
    await act(async () => delay(120));
    fireEvent.keyDown(studio.root, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    const atModifier = camera.position.clone();
    await act(async () => delay(160));
    fireEvent.keyUp(studio.root, { key: 'w', code: 'KeyW', ctrlKey: true });
    fireEvent.keyUp(studio.root, { key: 'Control', code: 'ControlLeft' });

    expect(camera.position.distanceTo(atModifier)).toBeLessThan(1e-9);
  });

  it('uses Shift+R as the documented default recording shortcut', async () => {
    const studio = await mountStudio('lumora://recording-default-shortcut');
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

  it('protects active and pending-save recordings but not clean projects on beforeunload', async () => {
    const studio = await mountStudio('lumora://recording-beforeunload');
    act(() => studio.handle.current!.runtime.editor.setSelection(['sample-camera']));
    await waitFor(() =>
      expect(within(studio.root).getByTestId('save-state-badge')).toHaveTextContent('已保存'),
    );

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

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

  it('clears held drive input when focus leaves Studio A and rebinds when focus returns', async () => {
    const a = await mountStudio('lumora://drive-body-keyup-a');
    await mountStudio('lumora://drive-body-keyup-b');
    act(() => a.handle.current!.runtime.editor.setSelection(['sample-camera']));
    const cameraA = findNode(a.scene, 'sample-camera')!;
    const focusTarget = within(a.root).getByTestId('timeline-play');
    await act(async () => delay(60));

    focusTarget.focus();
    fireEvent.keyDown(focusTarget, { key: 's', code: 'KeyS' });
    await act(async () => delay(120));
    focusTarget.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyUp(document.body, { key: 's', code: 'KeyS' });
    const atRelease = cameraA.position.clone();
    await act(async () => delay(160));

    expect(cameraA.position.distanceTo(atRelease)).toBeLessThan(1e-9);

    focusTarget.focus();
    const beforeRebind = cameraA.position.clone();
    fireEvent.keyDown(focusTarget, { key: 's', code: 'KeyS' });
    await act(async () => delay(120));
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
