import { createRef } from 'react';
import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import { findNode } from '../src/components/editor/scene-builder';

const r3fHarness = vi.hoisted(() => ({ scenes: [] as THREE.Group[] }));

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
    tracks: sample.tracks.filter((track) => track.objectId !== 'sample-camera'),
  };
}

function dispatchComposedKey(
  target: EventTarget,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mountShadowStudio(uri: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const container = document.createElement('div');
  shadowRoot.append(container);
  const handle = createRef<LumoraStudioHandle>();
  const sceneIndex = r3fHarness.scenes.length;
  render(<LumoraStudio ref={handle} initialProject={drivableProject(uri)} />, { container });
  await waitFor(() => expect(handle.current?.runtime.editor.getProject()?.uri).toBe(uri));
  await waitFor(() => expect(r3fHarness.scenes.length).toBeGreaterThan(sceneIndex));
  return {
    handle,
    host,
    shadowRoot,
    root: within(container).getByTestId('lumora-studio'),
    scene: r3fHarness.scenes[sceneIndex]!,
  };
}

beforeEach(() => {
  r3fHarness.scenes = [];
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Studio keyboard routing across ShadowRoot boundaries', () => {
  it('routes editing, deletion, and camera drive keys from the focused ShadowRoot Studio', async () => {
    const studio = await mountShadowStudio('lumora://shadow-keyboard');
    const editor = studio.handle.current!.runtime.editor;
    const focusTarget = document.createElement('div');
    focusTarget.tabIndex = -1;
    studio.root.append(focusTarget);
    focusTarget.focus();
    expect(studio.shadowRoot.activeElement).toBe(focusTarget);
    expect(document.activeElement).toBe(studio.host);

    act(() => {
      dispatchComposedKey(focusTarget, 'keydown', { key: '2', code: 'Digit2' });
    });
    expect(editor.getView().transformMode).toBe('rotate');

    act(() => editor.setSelection(['sample-cube']));
    const deleteSelection = vi.spyOn(editor, 'deleteSelection');
    act(() => {
      dispatchComposedKey(focusTarget, 'keydown', { key: 'Delete', code: 'Delete' });
    });
    expect(deleteSelection).toHaveBeenCalledTimes(1);

    act(() => editor.setSelection(['sample-camera']));
    const camera = findNode(studio.scene, 'sample-camera')!;
    await act(async () => delay(60));
    const before = camera.position.clone();
    act(() => {
      dispatchComposedKey(focusTarget, 'keydown', { key: 'w', code: 'KeyW' });
    });
    await act(async () => delay(120));
    act(() => {
      dispatchComposedKey(focusTarget, 'keyup', { key: 'w', code: 'KeyW' });
    });

    expect(camera.position.distanceTo(before)).toBeGreaterThan(0.01);
  });

  it('preserves native editing and drive keys for controls inside the ShadowRoot Studio', async () => {
    const studio = await mountShadowStudio('lumora://shadow-native-controls');
    const editor = studio.handle.current!.runtime.editor;
    act(() => editor.setSelection(['sample-camera']));
    const deleteSelection = vi.spyOn(editor, 'deleteSelection');
    const camera = findNode(studio.scene, 'sample-camera')!;
    const play = within(studio.root).getByTestId('timeline-play');
    const playBefore = play.textContent;
    const contentEditable = document.createElement('div');
    contentEditable.setAttribute('contenteditable', 'true');
    contentEditable.tabIndex = 0;
    const controls = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      document.createElement('button'),
      contentEditable,
    ];
    controls.forEach((control) => studio.root.append(control));

    for (const control of controls) {
      control.focus();
      expect(studio.shadowRoot.activeElement).toBe(control);
      for (const key of ['Delete', 'Backspace']) {
        let event!: KeyboardEvent;
        act(() => {
          event = dispatchComposedKey(control, 'keydown', { key, code: key });
        });
        expect(event.defaultPrevented, `${control.tagName}:${key}`).toBe(false);
      }
      let space!: KeyboardEvent;
      act(() => {
        space = dispatchComposedKey(control, 'keydown', { key: ' ', code: 'Space' });
      });
      expect(space.defaultPrevented, `${control.tagName}:Space`).toBe(false);
      for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
        let event!: KeyboardEvent;
        act(() => {
          event = dispatchComposedKey(control, 'keydown', {
            key: code.slice(-1).toLowerCase(),
            code,
          });
          dispatchComposedKey(control, 'keyup', {
            key: code.slice(-1).toLowerCase(),
            code,
          });
        });
        expect(event.defaultPrevented, `${control.tagName}:${code}`).toBe(false);
      }
    }

    const input = controls[0]!;
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
      const before = camera.position.clone();
      act(() => {
        dispatchComposedKey(input, 'keydown', {
          key: code.slice(-1).toLowerCase(),
          code,
        });
      });
      await act(async () => delay(80));
      act(() => {
        dispatchComposedKey(input, 'keyup', {
          key: code.slice(-1).toLowerCase(),
          code,
        });
      });
      expect(camera.position.distanceTo(before), code).toBeLessThan(1e-9);
    }

    expect(deleteSelection).not.toHaveBeenCalled();
    expect(editor.getSelection()).toEqual(['sample-camera']);
    expect(play).toHaveTextContent(playBefore ?? '');
  });

  it.each(['Space', 'Enter'])('keeps ShadowRoot export-button %s activation native without toggling playback', async (key) => {
    const studio = await mountShadowStudio(`lumora://shadow-button-${key.toLowerCase()}`);
    const trigger = within(studio.root).getByTestId('open-export-workspace');
    const play = within(studio.root).getByTestId('timeline-play');
    const playBefore = play.textContent;
    trigger.focus();

    const keydown = dispatchComposedKey(trigger, 'keydown', {
      key: key === 'Space' ? ' ' : key,
      code: key,
    });
    dispatchComposedKey(trigger, 'keyup', {
      key: key === 'Space' ? ' ' : key,
      code: key,
    });
    expect(keydown.defaultPrevented).toBe(false);
    await act(async () => trigger.click());

    expect(within(studio.root).getByTestId('export-workspace')).toBeInTheDocument();
    expect(play).toHaveTextContent(playBefore ?? '');
  });

  it('preserves ShadowRoot input keys while export shortcut capture is active', async () => {
    const studio = await mountShadowStudio('lumora://shadow-export-input');
    const editor = studio.handle.current!.runtime.editor;
    act(() => editor.setSelection(['sample-camera']));
    const deleteSelection = vi.spyOn(editor, 'deleteSelection');
    const trigger = within(studio.root).getByTestId('open-export-workspace');
    await act(async () => trigger.click());
    expect(within(studio.root).getByTestId('export-workspace')).toBeInTheDocument();
    const play = within(studio.root).getByTestId('timeline-play');
    const playBefore = play.textContent;
    const input = document.createElement('input');
    studio.root.append(input);
    input.focus();

    for (const [key, code] of [
      ['Delete', 'Delete'],
      ['Backspace', 'Backspace'],
      [' ', 'Space'],
      ['w', 'KeyW'],
    ]) {
      let event!: KeyboardEvent;
      act(() => {
        event = dispatchComposedKey(input, 'keydown', { key, code });
      });
      expect(event.defaultPrevented, code).toBe(false);
    }

    expect(deleteSelection).not.toHaveBeenCalled();
    expect(editor.getSelection()).toEqual(['sample-camera']);
    expect(play).toHaveTextContent(playBefore ?? '');
  });

  it('lets only the nearest registered root handle an event from a nested Studio', async () => {
    const outerHandle = createRef<LumoraStudioHandle>();
    const outerRender = render(
      <LumoraStudio
        ref={outerHandle}
        initialProject={createSampleProject('lumora://nested-outer', 'Nested outer')}
        scene={() => <div />}
      />,
    );
    await waitFor(() => expect(outerHandle.current?.runtime.editor.getProject()?.uri).toBe('lumora://nested-outer'));
    const outerRoot = within(outerRender.container).getByTestId('lumora-studio');
    const innerContainer = document.createElement('div');
    outerRoot.append(innerContainer);
    const innerHandle = createRef<LumoraStudioHandle>();
    render(
      <LumoraStudio
        ref={innerHandle}
        initialProject={createSampleProject('lumora://nested-inner', 'Nested inner')}
        scene={() => <div />}
      />,
      { container: innerContainer },
    );
    await waitFor(() => expect(innerHandle.current?.runtime.editor.getProject()?.uri).toBe('lumora://nested-inner'));
    const innerRoot = within(innerContainer).getByTestId('lumora-studio');
    const outerDelete = vi.spyOn(outerHandle.current!.runtime.editor, 'deleteSelection');
    const innerDelete = vi.spyOn(innerHandle.current!.runtime.editor, 'deleteSelection');
    act(() => {
      outerHandle.current!.runtime.editor.setSelection(['sample-cube']);
      innerHandle.current!.runtime.editor.setSelection(['sample-cube']);
    });

    act(() => {
      dispatchComposedKey(innerRoot, 'keydown', { key: 'Delete', code: 'Delete' });
    });

    expect(innerDelete).toHaveBeenCalledTimes(1);
    expect(outerDelete).not.toHaveBeenCalled();
    expect(outerHandle.current!.runtime.editor.getSelection()).toEqual(['sample-cube']);
  });

  it('does not claim a focusable host control outside the ShadowRoot Studio', async () => {
    const studio = await mountShadowStudio('lumora://shadow-host-boundary');
    const editor = studio.handle.current!.runtime.editor;
    act(() => editor.setSelection(['sample-cube']));
    const hostButton = document.createElement('button');
    document.body.append(hostButton);
    hostButton.focus();

    act(() => {
      dispatchComposedKey(hostButton, 'keydown', { key: 'Delete', code: 'Delete' });
      dispatchComposedKey(hostButton, 'keydown', { key: 'k', code: 'KeyK', ctrlKey: true });
    });

    expect(editor.getSelection()).toEqual(['sample-cube']);
    expect(within(studio.root).queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it.each([
    ['ownerDocument', (root: HTMLElement) => root.ownerDocument as EventTarget],
    ['ownerDocument.body', (root: HTMLElement) => root.ownerDocument.body as EventTarget],
  ])('keeps the single-Studio %s fallback behavior through the window listener', async (_name, target) => {
    const handle = createRef<LumoraStudioHandle>();
    const view = render(
      <LumoraStudio
        ref={handle}
        initialProject={createSampleProject('lumora://document-fallback', 'Document fallback')}
        scene={() => <div />}
      />,
    );
    await waitFor(() => expect(handle.current?.runtime.editor.getProject()).not.toBeNull());
    const editor = handle.current!.runtime.editor;
    const root = within(view.container).getByTestId('lumora-studio');
    act(() => editor.setSelection(['sample-cube']));
    const deleteSelection = vi.spyOn(editor, 'deleteSelection');

    act(() => {
      dispatchComposedKey(target(root), 'keydown', { key: 'Delete', code: 'Delete' });
    });

    expect(deleteSelection).toHaveBeenCalledTimes(1);
  });
});
