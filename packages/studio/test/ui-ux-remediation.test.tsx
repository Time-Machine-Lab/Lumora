import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => <div data-testid="mock-canvas">{children}</div>,
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

describe('TML-563 modal accessibility boundary', () => {
  it('plugin manager is a portal modal, traps focus, closes on Escape, and restores its opener', async () => {
    render(<LumoraStudio />);
    const opener = await screen.findByTestId('open-plugin-manager');
    fireEvent.click(opener);

    const application = screen.getByTestId('lumora-studio');
    const dialog = await screen.findByRole('dialog', { name: '插件管理' });
    const close = screen.getByTestId('close-plugin-manager');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(application).toHaveAttribute('inert');
    expect(application.contains(dialog)).toBe(false);
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('plugin-manager')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('command palette labels search, contains Shift+Tab, and blocks editor shortcuts', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} />);
    const opener = await screen.findByTestId('open-command-palette');
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: '命令面板' });
    const input = screen.getByTestId('command-palette-input');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(input).toHaveAccessibleName('搜索命令');
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const clearSelection = vi.spyOn(handle.current!.runtime.editor, 'clearSelection');
    fireEvent.keyDown(document.activeElement ?? input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument());
    expect(clearSelection).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });

  it('keeps focus inside the command palette after programmatic escape to the host', async () => {
    render(<LumoraStudio />);
    fireEvent.click(await screen.findByTestId('open-command-palette'));
    const dialog = await screen.findByRole('dialog', { name: '命令面板' });
    const hostTarget = document.createElement('button');
    document.body.append(hostTarget);
    hostTarget.focus();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(dialog.contains(document.activeElement)).toBe(true);
    hostTarget.remove();
  });

  it('closes the portalled command palette when Ctrl+K is pressed again', async () => {
    render(<LumoraStudio />);
    const opener = await screen.findByTestId('open-command-palette');
    fireEvent.click(opener);
    const input = await screen.findByTestId('command-palette-input');

    fireEvent.keyDown(input, { key: 'k', ctrlKey: true });

    await waitFor(() => expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
