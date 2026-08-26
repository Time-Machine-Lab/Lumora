import { describe, expect, it } from 'vitest';
import { defineManifest, definePlugin } from '../src/define-plugin';
import type { EventMap, PluginDefinition, PluginInfo } from '../src/index';

function assertSinglePluginDiagnostic(
  info: PluginInfo,
  event: EventMap['plugin:state-changed'],
): void {
  const infoMessage: string | undefined = info.error?.message;
  const eventMessage: string | undefined = event.error?.message;
  void infoMessage;
  void eventMessage;
  if (info.error) {
    // @ts-expect-error public diagnostics are readonly.
    info.error.message = 'mutated';
    // @ts-expect-error public diagnostics are objects, not arrays.
    const firstDiagnostic = info.error[0];
    void firstDiagnostic;
  }
}

void assertSinglePluginDiagnostic;

const VALID = {
  schemaVersion: '1',
  id: 'com.example.mock',
  name: 'Mock 插件',
  version: '0.1.0',
  entry: './dist/index.js',
  engine: { lumora: '^0.1.0' },
};

describe('definePlugin', () => {
  it('原样返回定义（类型层契约）', () => {
    const definition: PluginDefinition = {
      activate: () => undefined,
      deactivate: () => undefined,
    };
    expect(definePlugin(definition)).toBe(definition);
  });
});

describe('defineManifest', () => {
  it('合法 Manifest 通过校验并返回', () => {
    const manifest = defineManifest(VALID);
    expect(manifest.id).toBe('com.example.mock');
  });

  it('非法 Manifest 抛出带错误项说明的异常', () => {
    expect(() => defineManifest({ ...VALID, schemaVersion: '2' })).toThrow(/schemaVersion/);
    expect(() => defineManifest({ ...VALID, id: 'bad id' })).toThrow(/lumora\.plugin\.json 非法/);
  });
});
