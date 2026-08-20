import { describe, expect, it } from 'vitest';
import { checkEngineCompatibility, validateManifest } from '@lumora/core';
import manifest from '../lumora.plugin.json';

describe('lumora.plugin.json（Manifest v1）', () => {
  it('通过宿主校验，可被注册', () => {
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('com.lumora.mock');
    expect(result.manifest?.schemaVersion).toBe('1');
  });

  it('声明了全部六类贡献项', () => {
    expect(manifest.contributes).toEqual([
      'panel',
      'command',
      'toolbar',
      'assetLoader',
      'aiProvider',
      'exporter',
    ]);
  });

  it('与宿主 0.1.x 引擎兼容', () => {
    const result = checkEngineCompatibility(manifest as Parameters<typeof checkEngineCompatibility>[0], '0.1.0');
    expect(result.ok).toBe(true);
  });

  it('entry 指向构建产物', () => {
    expect(manifest.entry).toBe('./dist/index.js');
  });
});
