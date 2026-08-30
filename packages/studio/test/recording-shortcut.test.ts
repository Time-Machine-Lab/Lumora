import { describe, expect, it } from 'vitest';
import {
  BROWSER_RESERVED_SHORTCUTS,
  DEFAULT_RECORDING_SHORTCUT,
  RECORDING_SHORTCUT_STORAGE_KEY,
  formatShortcut,
  loadRecordingShortcut,
  matchesShortcut,
  parseShortcut,
  saveRecordingShortcut,
  validateRecordingShortcut,
} from '../src/components/editor/recording-shortcut';

describe('recording shortcut policy', () => {
  it('rejects an independent matrix of common Edge, Chrome, Firefox, and Safari shortcuts', () => {
    const requiredReservedShortcuts = [
      'Ctrl+W',
      'Ctrl+O',
      'Ctrl+A',
      'Ctrl+0',
      'Ctrl+E',
      'Ctrl+G',
      'Ctrl+Shift+G',
      'Ctrl+Shift+I',
      'Ctrl+Shift+J',
      'Ctrl+Shift+C',
      'F3',
      'Shift+F3',
      'Cmd+W',
      'Cmd+O',
      'Cmd+A',
      'Cmd+0',
      'Cmd+Alt+F',
      'Cmd+G',
      'Cmd+Shift+G',
      'Cmd+Alt+I',
      'Cmd+Alt+J',
      'Cmd+Alt+C',
    ];

    for (const value of requiredReservedShortcuts) {
      const shortcut = parseShortcut(value);
      expect(shortcut, value).not.toBeNull();
      expect(validateRecordingShortcut(shortcut!), value).toContain('浏览器');
    }
  });

  it('keeps every documented browser shortcut parseable and rejected', () => {
    expect(BROWSER_RESERVED_SHORTCUTS.length).toBeGreaterThan(20);
    for (const reserved of BROWSER_RESERVED_SHORTCUTS) {
      const shortcut = parseShortcut(reserved.shortcut);
      expect(shortcut, reserved.shortcut).not.toBeNull();
      expect(validateRecordingShortcut(shortcut!), reserved.shortcut).toContain('浏览器');
    }
  });

  it('rejects shortcuts consumed by camera drive and the command palette', () => {
    for (const value of ['Shift+W', 'Shift+A', 'Ctrl+Alt+K', 'Cmd+K']) {
      const shortcut = parseShortcut(value)!;
      expect(validateRecordingShortcut(shortcut), value).toContain('Lumora');
    }
    expect(validateRecordingShortcut(parseShortcut('Ctrl+Shift+K')!)).not.toBeNull();
  });

  it('uses a safe Shift+R default and matches modifiers exactly', () => {
    expect(formatShortcut(DEFAULT_RECORDING_SHORTCUT)).toBe('Shift+R');
    expect(validateRecordingShortcut(DEFAULT_RECORDING_SHORTCUT)).toBeNull();
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'R', code: 'KeyR', shiftKey: true }),
        DEFAULT_RECORDING_SHORTCUT,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }),
        DEFAULT_RECORDING_SHORTCUT,
      ),
    ).toBe(false);
  });

  it('does not overwrite storage with a reserved shortcut and restores valid saved settings', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const closeTab = parseShortcut('Ctrl+W')!;
    expect(saveRecordingShortcut(closeTab, storage)).toBe(false);
    expect(values.has(RECORDING_SHORTCUT_STORAGE_KEY)).toBe(false);

    const custom = parseShortcut('Ctrl+Alt+R')!;
    expect(saveRecordingShortcut(custom, storage)).toBe(true);
    expect(loadRecordingShortcut(storage)).toEqual(custom);

    values.set(RECORDING_SHORTCUT_STORAGE_KEY, 'Ctrl+W');
    expect(loadRecordingShortcut(storage)).toEqual(DEFAULT_RECORDING_SHORTCUT);
  });
});
