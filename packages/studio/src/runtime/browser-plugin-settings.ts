import type { PluginSettingsStorage } from '@lumora/core';

const STORAGE_PREFIX = 'lumora.studio.plugin-settings.v1';

/** Browser persistence scoped to one embedded Studio instance and one plugin instance. */
export class BrowserPluginSettingsStorage implements PluginSettingsStorage {
  constructor(private readonly studioNamespace: string) {}

  get(pluginInstanceId: string, key: string): string | null {
    return window.localStorage.getItem(this.storageKey(pluginInstanceId, key));
  }

  set(pluginInstanceId: string, key: string, value: string): void {
    window.localStorage.setItem(this.storageKey(pluginInstanceId, key), value);
  }

  remove(pluginInstanceId: string, key: string): void {
    window.localStorage.removeItem(this.storageKey(pluginInstanceId, key));
  }

  private storageKey(pluginInstanceId: string, key: string): string {
    const scope = JSON.stringify([this.studioNamespace, pluginInstanceId, key]);
    return `${STORAGE_PREFIX}:${encodeURIComponent(scope)}`;
  }
}
