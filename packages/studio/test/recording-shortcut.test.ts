import { describe, expect, it, vi } from 'vitest';
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

const REQUIRED_RESERVED_SHORTCUTS = [
  'Ctrl+Shift+B',
  'Ctrl+Shift+O',
  'Ctrl+Shift+D',
  'Alt+E',
  'Alt+F',
  'Alt+Space',
  'Cmd+D',
  'Cmd+Alt+B',
  'Cmd+H',
  'Cmd+M',
  'Cmd+Space',
  'Cmd+Shift+B',
  'Cmd+Shift+D',
  'Cmd+Shift+P',
  'Cmd+Shift+[',
  'Cmd+Shift+]',
] as const;

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
      ...REQUIRED_RESERVED_SHORTCUTS,
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

  it('reports and refuses every required high-risk fixture without writing storage', () => {
    const localStorageSetItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      for (const value of REQUIRED_RESERVED_SHORTCUTS) {
        const shortcut = parseShortcut(value);
        expect(shortcut, value).not.toBeNull();
        expect(validateRecordingShortcut(shortcut!), value).toMatch(/浏览器/);

        const storage = {
          getItem: vi.fn(() => null),
          setItem: vi.fn(),
        };
        expect(saveRecordingShortcut(shortcut!, storage), value).toBe(false);
        expect(storage.setItem, value).not.toHaveBeenCalled();

        localStorage.removeItem(RECORDING_SHORTCUT_STORAGE_KEY);
        localStorageSetItem.mockClear();
        expect(saveRecordingShortcut(shortcut!), value).toBe(false);
        expect(localStorageSetItem, value).not.toHaveBeenCalled();
        expect(localStorage.getItem(RECORDING_SHORTCUT_STORAGE_KEY), value).toBeNull();
      }
    } finally {
      localStorageSetItem.mockRestore();
      localStorage.removeItem(RECORDING_SHORTCUT_STORAGE_KEY);
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
