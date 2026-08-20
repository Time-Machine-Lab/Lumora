import { describe, expect, it } from 'vitest';
import { checkEngineCompatibility } from '../src/manifest/engine';
import { validateManifest } from '../src/manifest/validate';

const VALID = {
  schemaVersion: '1',
  id: 'com.example.mock',
  name: 'Mock 插件',
  version: '0.1.0',
  entry: './dist/index.js',
  engine: { lumora: '^0.1.0' },
  contributes: ['panel', 'command', 'toolbar', 'assetLoader', 'aiProvider', 'exporter'],
};

describe('validateManifest', () => {
  it('接受合法 Manifest', () => {
    const result = validateManifest(VALID);
    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('com.example.mock');
  });

  it('schemaVersion 非 1 时拒绝', () => {
    const result = validateManifest({ ...VALID, schemaVersion: '2' });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('schemaVersion');
  });

  it('拒绝反向域名风格以外的 id', () => {
    expect(validateManifest({ ...VALID, id: 'mock' }).ok).toBe(false);
    expect(validateManifest({ ...VALID, id: 'COM.example.mock' }).ok).toBe(false);
  });

  it('拒绝缺失 entry / name / version', () => {
    expect(validateManifest({ ...VALID, entry: '' }).ok).toBe(false);
    const noName = { ...VALID };
    delete (noName as Record<string, unknown>).name;
    expect(validateManifest(noName).ok).toBe(false);
  });

  it('拒绝未知顶层字段（strict）', () => {
    const result = validateManifest({ ...VALID, unknownField: true });
    expect(result.ok).toBe(false);
  });

  it('拒绝非 semver 的 version', () => {
    const result = validateManifest({ ...VALID, version: 'latest' });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('version');
  });

  it('拒绝非对象输入', () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest('str').ok).toBe(false);
    expect(validateManifest([1, 2]).ok).toBe(false);
  });

  it('contributes 只接受已知贡献项类型', () => {
    const result = validateManifest({ ...VALID, contributes: ['panel', 'hacker'] });
    expect(result.ok).toBe(false);
  });
});

describe('checkEngineCompatibility', () => {
  const manifest = (engine: unknown) => ({ ...VALID, engine });

  it('无 engine 声明时兼容', () => {
    const { manifest: m } = validateManifest(manifest(undefined));
    expect(checkEngineCompatibility(m!, '0.1.0').ok).toBe(true);
  });

  it('宿主版本满足范围时兼容', () => {
    const { manifest: m } = validateManifest(manifest({ lumora: '^0.1.0' }));
    expect(checkEngineCompatibility(m!, '0.1.3').ok).toBe(true);
    expect(checkEngineCompatibility(m!, '0.2.0').ok).toBe(false);
    expect(checkEngineCompatibility(m!, '0.1.0').ok).toBe(true);
  });

  it('非法范围与非法宿主版本给出明确原因', () => {
    const { manifest: m } = validateManifest(manifest({ lumora: 'not-a-range' }));
    const bad = checkEngineCompatibility(m!, '0.1.0');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('semver 范围');
  });
});
