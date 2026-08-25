import { createRef, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
                    id: 'small-usd',
                    name: 'Small USD',
                    cost: { kind: 'known', amount: 0.004, currency: 'USD', note: 'Sub-cent estimate' },
                  },
                  {
                    id: 'zero-usd',
                    name: 'Zero USD',
                    cost: { kind: 'known', amount: 0, currency: 'USD', note: 'No charge' },
                  },
                  {
                    id: 'jpy',
                    name: 'JPY',
                    cost: { kind: 'known', amount: 12, currency: 'JPY', note: 'Whole-yen estimate' },
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
  it('formats zero, sub-minor-unit, and currency-specific known costs without showing a nonzero amount as zero', async () => {
    await mountWorkspace();
    const model = screen.getByTestId('storyboard-model');
    const hint = screen.getByTestId('storyboard-cost-hint');

    expect(hint).toHaveTextContent('0.03 USD');
    fireEvent.change(model, { target: { value: 'small-usd' } });
    expect(hint).toHaveTextContent('<0.01 USD');
    fireEvent.change(model, { target: { value: 'zero-usd' } });
    expect(hint).toHaveTextContent('0.00 USD');
    fireEvent.change(model, { target: { value: 'jpy' } });
    expect(hint).toHaveTextContent('12 JPY');
    expect(hint).not.toHaveTextContent('12.00 JPY');
  });

  it('uses unique ARIA relationships and routes captured keys within each Studio root', async () => {
    const firstRef = createRef<LumoraStudioHandle>();
    const secondRef = createRef<LumoraStudioHandle>();
    render(
      <>
        <div data-testid="first-studio">
          <LumoraStudio
            ref={firstRef}
            plugins={[plugin]}
            initialProject={createBlankProject('lumora://storyboard-first', 'First storyboard')}
            scene={() => <div />}
          />
        </div>
        <div data-testid="second-studio">
          <LumoraStudio
            ref={secondRef}
            plugins={[plugin]}
            initialProject={createBlankProject('lumora://storyboard-second', 'Second storyboard')}
            scene={() => <div />}
          />
        </div>
      </>,
    );
    await waitFor(() => {
      expect(firstRef.current?.runtime.host.services.ai.listStoryboardProviders()).toHaveLength(1);
      expect(secondRef.current?.runtime.host.services.ai.listStoryboardProviders()).toHaveLength(1);
    });
    const triggers = screen.getAllByTestId('open-storyboard-workspace');
    fireEvent.click(triggers[0]!);
    fireEvent.click(triggers[1]!);
    const workspaces = await screen.findAllByTestId('storyboard-workspace');

    const ids = workspaces.map((workspace) => ({
      title: workspace.getAttribute('aria-labelledby'),
      draftTab: within(workspace).getByRole('tab', { name: '生成草案' }).id,
      draftPanel: within(workspace).getByRole('tabpanel').id,
    }));
    expect(new Set(ids.flatMap((item) => Object.values(item))).size).toBe(6);
    expect(ids[0]?.draftPanel).toBe(within(workspaces[0]!).getByRole('tab', { name: '生成草案' }).getAttribute('aria-controls'));
    expect(ids[1]?.draftPanel).toBe(within(workspaces[1]!).getByRole('tab', { name: '生成草案' }).getAttribute('aria-controls'));

    const secondConcept = within(workspaces[1]!).getByTestId('storyboard-concept');
    const delivered = vi.fn();
    secondConcept.addEventListener('keydown', delivered);
    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    expect(secondConcept.dispatchEvent(key)).toBe(true);
    expect(delivered).toHaveBeenCalledOnce();
  });

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

  it('marks a successful draft stale after the brief changes and disables adoption', async () => {
    await mountWorkspace();
    const concept = screen.getByTestId('storyboard-concept');
    fireEvent.change(concept, { target: { value: 'A complete first brief for stale draft validation.' } });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    expect(await screen.findByText('Generated pursuit')).toBeInTheDocument();

    fireEvent.change(concept, { target: { value: 'A materially different brief that makes the old draft stale.' } });

    expect(screen.getByTestId('storyboard-stale-draft')).toBeInTheDocument();
    expect(screen.getByTestId('storyboard-accept-all')).toBeDisabled();
    expect(screen.getByTestId('storyboard-accept-0')).toBeDisabled();
  });

  it('retains the edited last-success draft when a later generation fails', async () => {
    await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A complete brief whose edited draft must survive a failed retry.' },
    });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    expect(await screen.findByText('Generated pursuit')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('storyboard-draft-prompt-0'), { target: { value: 'Keep this edited prompt' } });

    fireEvent.change(screen.getByTestId('storyboard-model'), { target: { value: 'invalid-schema' } });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    expect(await screen.findByTestId('storyboard-error')).toHaveTextContent('schema_invalid');

    expect(screen.getByText('Generated pursuit')).toBeInTheDocument();
    expect(screen.getByTestId('storyboard-draft-prompt-0')).toHaveValue('Keep this edited prompt');
  });

  it('retains the edited last-success draft when a later generation is cancelled', async () => {
    await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A complete brief whose edited draft must survive cancellation.' },
    });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    expect(await screen.findByText('Generated pursuit')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('storyboard-draft-prompt-0'), { target: { value: 'Keep after cancellation' } });

    fireEvent.change(screen.getByTestId('storyboard-model'), { target: { value: 'slow' } });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    fireEvent.click(await screen.findByTestId('storyboard-cancel'));
    expect(await screen.findByTestId('storyboard-error')).toHaveTextContent('cancelled');

    expect(screen.getByText('Generated pursuit')).toBeInTheDocument();
    expect(screen.getByTestId('storyboard-draft-prompt-0')).toHaveValue('Keep after cancellation');
  });

  it('preserves adoption lineage across delete, re-adopt, undo, and redo', async () => {
    const ref = await mountWorkspace();
    fireEvent.change(screen.getByTestId('storyboard-concept'), {
      target: { value: 'A complete brief for project-derived adoption state.' },
    });
    fireEvent.click(screen.getByTestId('storyboard-generate'));
    expect(await screen.findByText('Generated pursuit')).toBeInTheDocument();
    const accept = screen.getByTestId('storyboard-accept-0');
    fireEvent.click(accept);
    await waitFor(() => expect(accept).toBeDisabled());
    const firstAdoptedId = ref.current?.runtime.editor.getProject()?.shots[0]?.id;

    fireEvent.click(screen.getByTestId('storyboard-tab-adopted'));
    fireEvent.click(screen.getByRole('button', { name: '删除分镜 Beat 1' }));
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots).toHaveLength(0));
    fireEvent.click(screen.getByRole('tab', { name: '生成草案' }));
    expect(screen.getByTestId('storyboard-accept-0')).toBeEnabled();
    fireEvent.click(screen.getByTestId('storyboard-accept-0'));
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots).toHaveLength(1));
    const secondAdoptedId = ref.current?.runtime.editor.getProject()?.shots[0]?.id;
    expect(secondAdoptedId).not.toBe(firstAdoptedId);

    act(() => {
      ref.current?.runtime.editor.undo();
      ref.current?.runtime.editor.undo();
    });
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots[0]?.id).toBe(firstAdoptedId));
    await waitFor(() => expect(screen.getByTestId('storyboard-accept-0')).toBeDisabled());

    act(() => {
      ref.current?.runtime.editor.redo();
      ref.current?.runtime.editor.redo();
    });
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots[0]?.id).toBe(secondAdoptedId));
    expect(screen.getByTestId('storyboard-accept-0')).toBeDisabled();
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
    const draftTabId = draftTab.id;
    const adoptedTabId = adoptedTab.id;
    const draftPanelId = draftTab.getAttribute('aria-controls');
    const adoptedPanelId = adoptedTab.getAttribute('aria-controls');

    expect(draftTabId).not.toBe('');
    expect(adoptedTabId).not.toBe('');
    expect(draftTabId).not.toBe(adoptedTabId);
    expect(draftPanelId).not.toBe(adoptedPanelId);
    expect(draftTab).toHaveAttribute('tabindex', '0');
    expect(adoptedTab).toHaveAttribute('tabindex', '-1');
    const draftPanel = document.getElementById(draftPanelId!);
    const adoptedPanel = document.getElementById(adoptedPanelId!);
    expect(draftPanel).not.toBeNull();
    expect(adoptedPanel).not.toBeNull();
    expect(draftPanel).not.toHaveAttribute('hidden');
    expect(adoptedPanel).toHaveAttribute('hidden');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', draftPanelId);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', draftTabId);

    draftTab.focus();
    fireEvent.keyDown(draftTab, { key: 'ArrowRight' });

    expect(adoptedTab).toHaveFocus();
    expect(adoptedTab).toHaveAttribute('aria-selected', 'true');
    expect(adoptedTab).toHaveAttribute('tabindex', '0');
    expect(draftTab).toHaveAttribute('tabindex', '-1');
    expect(draftPanel).toHaveAttribute('hidden');
    expect(adoptedPanel).not.toHaveAttribute('hidden');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', adoptedPanelId);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', adoptedTabId);

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

  it('skips unchanged blur history and removes a cleared optional prompt from a non-AI shot', async () => {
    const project = createBlankProject('lumora://storyboard-optional-prompt', 'Optional prompt storyboard');
    project.shots = [{
      id: 'optional-prompt-shot',
      name: 'Optional prompt shot',
      cameraObjectId: null,
      startTime: 0,
      endTime: 2,
      prompt: 'Can be cleared',
    }];
    const ref = await mountWorkspace(project);
    fireEvent.click(screen.getByTestId('storyboard-tab-adopted'));

    fireEvent.blur(screen.getByDisplayValue('Optional prompt shot'));
    expect(ref.current?.runtime.editor.getProject()?.revision).toBe(0);
    expect(ref.current?.runtime.editor.getHistoryState().canUndo).toBe(false);

    const prompt = screen.getByTestId('storyboard-adopted-prompt');
    fireEvent.change(prompt, { target: { value: '   ' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(ref.current?.runtime.editor.getProject()?.shots[0]?.prompt).toBeUndefined());
    expect(ref.current?.runtime.editor.getProject()?.revision).toBe(1);
  });
});
