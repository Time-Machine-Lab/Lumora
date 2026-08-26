import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserPluginSettingsStorage } from '../src/runtime/browser-plugin-settings';

describe('BrowserPluginSettingsStorage', () => {
  beforeEach(() => localStorage.clear());

  it('keeps dotted plugin ids and setting keys in distinct tuple scopes', () => {
    const storage = new BrowserPluginSettingsStorage('studio.scope');

    storage.set('com.example', 'settings.v1', 'provider-a');
    storage.set('com.example.settings', 'v1', 'provider-b');

    expect(storage.get('com.example', 'settings.v1')).toBe('provider-a');
    expect(storage.get('com.example.settings', 'v1')).toBe('provider-b');
  });

  it('keeps dotted Studio namespaces distinct from plugin id prefixes', () => {
    const firstStudio = new BrowserPluginSettingsStorage('studio.scope');
    const secondStudio = new BrowserPluginSettingsStorage('studio');

    firstStudio.set('com.example', 'settings', 'studio-a');
    secondStudio.set('scope.com.example', 'settings', 'studio-b');

    expect(firstStudio.get('com.example', 'settings')).toBe('studio-a');
    expect(secondStudio.get('scope.com.example', 'settings')).toBe('studio-b');
  });
});
