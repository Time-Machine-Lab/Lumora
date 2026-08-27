import { createRef } from 'react';
import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import { findNode } from '../src/components/editor/scene-builder';
import {
  isKeyboardEventForStudio,
  registerStudioKeyboardRoot,
} from '../src/components/studio-keyboard-scope';

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
    const focusTarget = within(studio.root).getByTestId('timeline-play');
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

  it('uses the registered root ownerDocument for the single-Studio body fallback', () => {
    const ownerDocument = document.implementation.createHTMLDocument('embedded');
    const root = ownerDocument.createElement('div');
    ownerDocument.body.append(root);
    const unregister = registerStudioKeyboardRoot(root);
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    ownerDocument.body.dispatchEvent(event);

    try {
      expect(isKeyboardEventForStudio(root, event)).toBe(true);
    } finally {
      unregister();
    }
  });
});
