import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Manifest, PluginDescriptor } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import { ModalDialog } from '../src/components/ModalDialog';

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

const focusPlugin: PluginDescriptor = {
  manifest: {
    schemaVersion: '1',
    id: 'com.test.focus',
    name: '焦点测试插件',
    version: '0.1.0',
    entry: './dist/index.js',
  } satisfies Manifest,
  entry: async () => ({ default: { activate: () => undefined } }),
};

function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function ShadowModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="shadow-modal-opener" onClick={() => setOpen(true)}>打开模态</button>
      {open && (
        <ModalDialog ariaLabel="ShadowRoot 模态" dialogClassName="lumora-modal" onClose={() => setOpen(false)}>
          <button type="button" onClick={() => setOpen(false)}>关闭 ShadowRoot 模态</button>
        </ModalDialog>
      )}
    </>
  );
}

describe('TML-563 modal accessibility boundary', () => {
  it('inerts every host sibling and recaptures programmatic focus outside the portal', async () => {
    const hostSibling = document.createElement('section');
    const hostButton = document.createElement('button');
    hostSibling.append(hostButton);
    document.body.append(hostSibling);

    try {
      render(
        <ModalDialog ariaLabel="宿主隔离模态" dialogClassName="lumora-modal" onClose={() => undefined}>
          <button type="button">模态操作</button>
        </ModalDialog>,
      );
      const dialog = await screen.findByRole('dialog', { name: '宿主隔离模态' });
      expect(hostSibling).toHaveAttribute('inert');

      hostButton.focus();
      await waitFor(() => expect(dialog.contains(deepActiveElement())).toBe(true));
    } finally {
      hostSibling.remove();
    }
  });

  it('restores the deep focused opener inside an open ShadowRoot', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const mount = document.createElement('div');
    shadow.append(mount);
    document.body.append(host);
    const root = createRoot(mount);

    try {
      await act(async () => root.render(<ShadowModalHarness />));
      const opener = shadow.querySelector<HTMLButtonElement>('[data-testid="shadow-modal-opener"]')!;
      opener.focus();
      fireEvent.click(opener);
      fireEvent.click(await screen.findByRole('button', { name: '关闭 ShadowRoot 模态' }));

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ShadowRoot 模态' })).not.toBeInTheDocument());
      expect(deepActiveElement()).toBe(opener);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('routes Escape to only the top modal when two Studio instances share a document', async () => {
    render(
      <>
        <section aria-label="Studio A"><LumoraStudio /></section>
        <section aria-label="Studio B"><LumoraStudio /></section>
      </>,
    );
    const openers = await screen.findAllByTestId('open-plugin-manager');
    fireEvent.click(openers[0]!);
    const lowerDialog = await screen.findByRole('dialog', { name: '插件管理' });
    fireEvent.click(openers[1]!);
    await waitFor(() => expect(screen.getAllByRole('dialog', { name: '插件管理' })).toHaveLength(2));

    fireEvent.keyDown(deepActiveElement() ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.getAllByRole('dialog', { name: '插件管理' })).toHaveLength(1));
    expect(lowerDialog).toBeInTheDocument();
  });

  it('plugin manager is a portal modal, traps focus, closes on Escape, and restores its opener', async () => {
    render(<LumoraStudio />);
    const opener = await screen.findByTestId('open-plugin-manager');
    fireEvent.click(opener);

    const application = screen.getByTestId('lumora-studio');
    const dialog = await screen.findByRole('dialog', { name: '插件管理' });
    const close = screen.getByTestId('close-plugin-manager');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(application.parentElement).toHaveAttribute('inert');
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

  it('keeps one focused plugin toggle node across disable and enable transitions', async () => {
    render(<LumoraStudio plugins={[focusPlugin]} hostVersion="0.1.0" />);
    fireEvent.click(screen.getByTestId('open-plugin-manager'));
    await screen.findByTestId('plugin-state-com.test.focus');
    const toggle = await screen.findByTestId('plugin-toggle-com.test.focus');
    toggle.focus();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('plugin-state-com.test.focus')).toHaveTextContent('已禁用'));
    expect(screen.getByTestId('plugin-toggle-com.test.focus')).toBe(toggle);
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('plugin-state-com.test.focus')).toHaveTextContent('运行中'));
    expect(screen.getByTestId('plugin-toggle-com.test.focus')).toBe(toggle);
    expect(toggle).toHaveFocus();
  });
});
