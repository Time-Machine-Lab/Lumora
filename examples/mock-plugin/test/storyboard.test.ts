import { describe, expect, it } from 'vitest';
import { PluginHost } from '@lumora/core';
import type { CreativeBrief, Manifest } from '@lumora/core';
import manifest from '../lumora.plugin.json';
import pluginEntry from '../src/index';

const descriptor = {
  manifest: manifest as Manifest,
  entry: async () => ({ default: pluginEntry }),
};

const BRIEF: CreativeBrief = {
  concept: 'A courier crosses a rain-soaked neon market to deliver a mysterious case.',
  targetDurationSeconds: 12,
  shotCount: 3,
  visualStyle: 'Grounded cinematic sci-fi',
};

async function run(model: string, brief: CreativeBrief = BRIEF) {
  const host = new PluginHost({ hostVersion: '0.1.0' });
  await host.register(descriptor);
  const submitted = host.services.ai.submitStoryboard('com.lumora.mock.ai', { model, brief });
  const completed = await host.services.ai.waitForGenerationTask(submitted.id);
  await host.dispose();
  return completed;
}

describe('Mock storyboard provider', () => {
  it('advertises deterministic success and failure models with cost hints', async () => {
    const host = new PluginHost({ hostVersion: '0.1.0' });
    await host.register(descriptor);

    const [provider] = host.services.ai.listStoryboardProviders();

    expect(provider?.id).toBe('com.lumora.mock.ai');
    expect(provider?.models.map((model) => model.id)).toEqual([
      'mock-storyboard-success',
      'mock-storyboard-timeout',
      'mock-storyboard-rate-limit',
      'mock-storyboard-schema-error',
      'mock-storyboard-slow',
    ]);
    expect(provider?.models[0]?.cost).toMatchObject({ kind: 'known', amount: 0, currency: 'USD' });
    expect(provider?.models[1]?.cost).toMatchObject({ kind: 'unknown' });
    await host.dispose();
  });

  it('generates the requested number of useful shots offline', async () => {
    const task = await run('mock-storyboard-success');

    expect(task.status).toBe('succeeded');
    expect(task.draft?.shots).toHaveLength(3);
    expect(task.draft?.shots.map((shot) => shot.durationSeconds)).toEqual([4, 4, 4]);
    expect(task.draft?.shots.every((shot) => shot.prompt.includes('neon market'))).toBe(true);
  });

  it('keeps every generated shot valid near the minimum duration boundary', async () => {
    const task = await run('mock-storyboard-success', {
      ...BRIEF,
      targetDurationSeconds: 1.0051,
      shotCount: 10,
    });

    expect(task.status).toBe('succeeded');
    expect(task.draft?.shots).toHaveLength(10);
    expect(task.draft?.shots.every((shot) => shot.durationSeconds >= 0.1)).toBe(true);
    expect(task.draft?.shots.reduce((total, shot) => total + shot.durationSeconds, 0)).toBeCloseTo(1.0051, 10);
  });

  it.each([
    ['mock-storyboard-timeout', 'timeout'],
    ['mock-storyboard-rate-limit', 'rate_limited'],
    ['mock-storyboard-schema-error', 'schema_invalid'],
  ])('exposes %s as a diagnostic %s task failure without a draft', async (model, code) => {
    const task = await run(model);

    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe(code);
    expect(task.draft).toBeUndefined();
  });

  it('cancels the slow scenario through the public task API', async () => {
    const host = new PluginHost({ hostVersion: '0.1.0' });
    await host.register(descriptor);
    const submitted = host.services.ai.submitStoryboard('com.lumora.mock.ai', {
      model: 'mock-storyboard-slow',
      brief: BRIEF,
    });

    expect(host.services.ai.cancelGenerationTask(submitted.id)).toBe(true);
    const completed = await host.services.ai.waitForGenerationTask(submitted.id);

    expect(completed.status).toBe('cancelled');
    expect(completed.error?.code).toBe('cancelled');
    await host.dispose();
  });
});
