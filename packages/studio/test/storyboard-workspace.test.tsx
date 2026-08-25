import { createRef, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_STORYBOARD_GENERATE_CAPABILITY,
  createBlankProject,
  type Manifest,
  type PluginDescriptor,
  type StoryboardGenerateRequest,
} from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';

const generate = vi.fn(async (request: StoryboardGenerateRequest): Promise<unknown> => {
  if (request.model === 'invalid-schema') {
    return { title: 'Broken', summary: 'Missing fields', shots: [{ title: 'Broken shot' }] };
  }
  if (request.model === 'slow') {
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      void resolve;
    });
  }
  const durationSeconds = request.brief.targetDurationSeconds / request.brief.shotCount;
  return {
    title: 'Generated pursuit',
    summary: 'Three beats generated for offline acceptance.',
    shots: Array.from({ length: request.brief.shotCount }, (_, index) => ({
      title: `Beat ${index + 1}`,
      shotSize: (['wide', 'medium', 'close-up'] as const)[index % 3],
      movement: (['dolly-in', 'tracking', 'static'] as const)[index % 3],
      durationSeconds,
      prompt: `Prompt ${index + 1}`,
    })),
  };
});

const manifest: Manifest = {
  schemaVersion: '1',
  id: 'com.test.storyboard',
  name: 'Storyboard test provider',
  version: '0.1.0',
  entry: './dist/index.js',
  contributes: ['aiProvider'],
};

const plugin: PluginDescriptor = {
  manifest,
  entry: async () => ({
    default: {
      activate: (context) =>
        context.contribute({
          aiProviders: [
            {
              kind: 'aiProvider',
              id: 'com.test.storyboard.ai',
              name: 'Storyboard test provider',
              models: [],
              chat: async function* () {},
              storyboard: {
                capability: AI_STORYBOARD_GENERATE_CAPABILITY,
                models: [
                  {
                    id: 'success',
                    name: 'Success',
                    cost: { kind: 'known', amount: 0.03, currency: 'USD', note: 'Estimate' },
                  },
                  {
                    id: 'invalid-schema',
                    name: 'Invalid schema',
                    cost: { kind: 'unknown', note: 'Unknown on failure' },
                  },
                  {
                    id: 'slow',
                    name: 'Slow',
                    cost: { kind: 'unknown', note: 'Cancellable' },
                  },
                ],
                generate,
              },
            },
          ],
        }),
    },
  }),
};

async function mountWorkspace(initialProject = createBlankProject('lumora://storyboard-ui', 'Storyboard UI')) {
  const ref = createRef<LumoraStudioHandle>();
  render(
    <StrictMode>
      <LumoraStudio
        ref={ref}
        plugins={[plugin]}
        initialProject={initialProject}
        scene={() => <div data-testid="storyboard-test-scene" />}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(ref.current?.runtime.host.services.ai.listStoryboardProviders()).toHaveLength(1));
  const trigger = screen.getByTestId('open-storyboard-workspace');
  trigger.focus();
  fireEvent.click(trigger);
  expect(await screen.findByTestId('storyboard-workspace')).toBeInTheDocument();
  return ref;
}

beforeEach(() => {
  generate.mockClear();
});

describe('StoryboardWorkspace', () => {
  it('allows a core-valid exact minimum duration at the 24-shot boundary', async () => {
    await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A complete concept for an exact duration boundary.' },
    });
    fireEvent.change(screen.getByTestId('storyboard-duration'), { target: { value: '2.4' } });
    fireEvent.change(screen.getByTestId('storyboard-shot-count'), { target: { value: '24' } });

    expect(screen.getByTestId('storyboard-generate')).toBeEnabled();
  });

  it('generates editable drafts, supports per-shot and remaining-shot adoption, then edits persisted shots', async () => {
    const ref = await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A courier crosses a neon market while protecting a mysterious case.' },
    });
    fireEvent.change(screen.getByTestId('storyboard-duration'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('storyboard-shot-count'), { target: { value: '3' } });

    expect(screen.getByTestId('storyboard-cost-hint')).toHaveTextContent('0.03 USD');
    fireEvent.click(screen.getByTestId('storyboard-generate'));

    expect(await screen.findByText('Generated pursuit')).toBeInTheDocument();
    expect(screen.getAllByTestId('storyboard-draft-shot')).toHaveLength(3);
    fireEvent.change(screen.getByTestId('storyboard-draft-prompt-0'), { target: { value: 'Edited first prompt' } });

    fireEvent.click(screen.getByTestId('storyboard-accept-0'));
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots).toHaveLength(1));
    expect(screen.getByTestId('storyboard-draft-prompt-0')).toBeDisabled();
    expect(ref.current?.runtime.editor.getProject()?.shots[0]).toMatchObject({
      shotSize: 'wide',
      movement: 'dolly-in',
      prompt: 'Edited first prompt',
    });

    fireEvent.click(screen.getByTestId('storyboard-accept-all'));
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots).toHaveLength(3));
    expect(ref.current?.runtime.editor.getProject()?.shots.map((shot) => shot.endTime - shot.startTime)).toEqual([4, 4, 4]);

    fireEvent.click(screen.getByTestId('storyboard-tab-adopted'));
    expect(screen.getAllByTestId('storyboard-adopted-shot')).toHaveLength(3);
    const prompt = screen.getAllByTestId('storyboard-adopted-prompt')[0]!;
    fireEvent.change(prompt, { target: { value: 'Persisted prompt edit' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots[0]?.prompt).toBe('Persisted prompt edit'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('shows a diagnostic schema error and leaves the project untouched', async () => {
    const ref = await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A complete concept long enough to satisfy validation.' },
    });
    fireEvent.change(screen.getByTestId('storyboard-model'), { target: { value: 'invalid-schema' } });
    fireEvent.click(screen.getByTestId('storyboard-generate'));

    expect(await screen.findByTestId('storyboard-error')).toHaveTextContent('schema_invalid');
    expect(screen.getByTestId('storyboard-error')).toHaveTextContent('未自动重试');
    expect(ref.current?.runtime.editor.getProject()?.shots).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('cancels a running task and does not adopt any shots', async () => {
    const ref = await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A complete concept long enough to satisfy validation.' },
    });
    fireEvent.change(screen.getByTestId('storyboard-model'), { target: { value: 'slow' } });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    expect(await screen.findByTestId('storyboard-cancel')).toBeEnabled();
    expect(screen.getByTestId('storyboard-concept')).toBeDisabled();
    expect(screen.getByTestId('storyboard-model')).toBeDisabled();
    act(() => ref.current?.runtime.editor.setTransformMode('rotate'));
    expect(screen.getByTestId('storyboard-cancel')).toBeEnabled();
    fireEvent.click(screen.getByTestId('storyboard-cancel'));

    expect(await screen.findByTestId('storyboard-error')).toHaveTextContent('cancelled');
    expect(screen.getByTestId('storyboard-concept')).toBeEnabled();
    expect(ref.current?.runtime.editor.getProject()?.shots).toEqual([]);
  });

  it('cancels an active generation when the workspace closes', async () => {
    await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A complete concept long enough to verify close cancellation.' },
    });
    fireEvent.change(screen.getByTestId('storyboard-model'), { target: { value: 'slow' } });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    expect(await screen.findByTestId('storyboard-cancel')).toBeEnabled();
    const signal = generate.mock.calls.at(-1)?.[0].signal;

    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 分镜工作台' }));

    await waitFor(() => expect(screen.queryByTestId('storyboard-workspace')).not.toBeInTheDocument());
    expect(signal?.aborted).toBe(true);
  });

  it('links tabs to panels and supports roving arrow-key focus', async () => {
    await mountWorkspace();
    const draftTab = screen.getByRole('tab', { name: '生成草案' });
    const adoptedTab = screen.getByRole('tab', { name: /已采用/ });

    expect(draftTab).toHaveAttribute('id', 'storyboard-tab-draft');
    expect(draftTab).toHaveAttribute('aria-controls', 'storyboard-panel-draft');
    expect(draftTab).toHaveAttribute('tabindex', '0');
    expect(adoptedTab).toHaveAttribute('id', 'storyboard-tab-adopted');
    expect(adoptedTab).toHaveAttribute('aria-controls', 'storyboard-panel-adopted');
    expect(adoptedTab).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'storyboard-tab-draft');

    draftTab.focus();
    fireEvent.keyDown(draftTab, { key: 'ArrowRight' });

    expect(adoptedTab).toHaveFocus();
    expect(adoptedTab).toHaveAttribute('aria-selected', 'true');
    expect(adoptedTab).toHaveAttribute('tabindex', '0');
    expect(draftTab).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'storyboard-tab-adopted');

    fireEvent.keyDown(adoptedTab, { key: 'Home' });
    expect(draftTab).toHaveFocus();
    expect(draftTab).toHaveAttribute('aria-selected', 'true');
  });

  it('isolates background editor shortcuts and restores focus when Escape closes the workspace', async () => {
    const ref = await mountWorkspace();
    const trigger = screen.getByTestId('open-storyboard-workspace');
    act(() => ref.current?.runtime.editor.setTransformMode('rotate'));

    const workspace = screen.getByTestId('storyboard-workspace');
    const concept = screen.getByTestId('storyboard-concept');
    const targetKeyDown = vi.fn();
    concept.addEventListener('keydown', targetKeyDown);
    for (const eventInit of [
      { key: ' ' },
      { key: 'Backspace' },
      { key: '1' },
      { key: 'z', ctrlKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...eventInit, bubbles: true, cancelable: true });
      expect(concept.dispatchEvent(event)).toBe(true);
    }
    expect(targetKeyDown).toHaveBeenCalledTimes(4);

    expect(workspace).toHaveAttribute('role', 'dialog');
    expect(workspace).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('lumora-toolbar')).toHaveAttribute('inert');
    const focusables = workspace.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    focusables[focusables.length - 1]!.focus();
    fireEvent.keyDown(focusables[focusables.length - 1]!, { key: 'Tab' });
    expect(focusables[0]).toHaveFocus();

    fireEvent.keyDown(window, { key: '1' });
    expect(ref.current?.runtime.editor.getView().transformMode).toBe('rotate');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('storyboard-workspace')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('edits a legacy shot without inventing AI-only metadata', async () => {
    const project = createBlankProject('lumora://storyboard-legacy-shot', 'Legacy storyboard');
    project.shots = [{
      id: 'legacy-shot',
      name: 'Legacy shot',
      cameraObjectId: null,
      startTime: 0,
      endTime: 2,
    }];
    const ref = await mountWorkspace(project);
    fireEvent.click(screen.getByTestId('storyboard-tab-adopted'));
    const name = screen.getByDisplayValue('Legacy shot');

    fireEvent.change(name, { target: { value: 'Renamed legacy shot' } });
    fireEvent.blur(name);

    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots[0]?.name).toBe('Renamed legacy shot'));
    expect(ref.current?.runtime.editor.getProject()?.shots[0]).toEqual({
      id: 'legacy-shot',
      name: 'Renamed legacy shot',
      cameraObjectId: null,
      startTime: 0,
      endTime: 2,
    });
  });
});
