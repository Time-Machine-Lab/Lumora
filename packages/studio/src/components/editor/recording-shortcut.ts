export interface KeyboardShortcut {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface ReservedBrowserShortcut {
  shortcut: string;
  browsers: readonly string[];
  action: string;
}

export interface ShortcutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
}

export const RECORDING_SHORTCUT_STORAGE_KEY = 'lumora.recording-shortcut.v1';

export const DEFAULT_RECORDING_SHORTCUT: KeyboardShortcut = Object.freeze({
  key: 'r',
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
  metaKey: false,
});

const WINDOWS_BROWSERS = ['Edge', 'Chrome', 'Firefox'] as const;
const DESKTOP_BROWSERS = ['Edge', 'Chrome', 'Firefox', 'Safari'] as const;
const MAC_BROWSERS = ['Chrome (macOS)', 'Firefox (macOS)', 'Safari'] as const;

/**
 * Desktop browser combinations that a web app cannot reliably own. Keeping the
 * list explicit makes changes reviewable and gives shortcut settings one policy.
 */
export const BROWSER_RESERVED_SHORTCUTS: readonly ReservedBrowserShortcut[] = [
  { shortcut: 'Ctrl+W', browsers: WINDOWS_BROWSERS, action: '关闭当前标签页' },
  { shortcut: 'Ctrl+Shift+W', browsers: WINDOWS_BROWSERS, action: '关闭当前窗口' },
  { shortcut: 'Ctrl+T', browsers: WINDOWS_BROWSERS, action: '新建标签页' },
  { shortcut: 'Ctrl+Shift+T', browsers: WINDOWS_BROWSERS, action: '恢复关闭的标签页' },
  { shortcut: 'Ctrl+N', browsers: WINDOWS_BROWSERS, action: '新建窗口' },
  { shortcut: 'Ctrl+Shift+N', browsers: ['Edge', 'Chrome'], action: '新建隐私窗口' },
  { shortcut: 'Ctrl+Shift+P', browsers: ['Firefox'], action: '新建隐私窗口' },
  { shortcut: 'Ctrl+L', browsers: WINDOWS_BROWSERS, action: '聚焦地址栏' },
  { shortcut: 'Ctrl+R', browsers: WINDOWS_BROWSERS, action: '刷新页面' },
  { shortcut: 'Ctrl+Shift+R', browsers: WINDOWS_BROWSERS, action: '强制刷新页面' },
  { shortcut: 'Ctrl+F', browsers: DESKTOP_BROWSERS, action: '页内查找' },
  { shortcut: 'Ctrl+P', browsers: WINDOWS_BROWSERS, action: '打印页面' },
  { shortcut: 'Ctrl+S', browsers: WINDOWS_BROWSERS, action: '保存页面' },
  { shortcut: 'Ctrl+U', browsers: WINDOWS_BROWSERS, action: '查看源代码' },
  { shortcut: 'Ctrl+H', browsers: WINDOWS_BROWSERS, action: '打开历史记录' },
  { shortcut: 'Ctrl+J', browsers: WINDOWS_BROWSERS, action: '打开下载记录' },
  { shortcut: 'Ctrl+D', browsers: WINDOWS_BROWSERS, action: '添加书签' },
  { shortcut: 'Ctrl+K', browsers: WINDOWS_BROWSERS, action: '聚焦浏览器搜索入口' },
  { shortcut: 'Ctrl+E', browsers: WINDOWS_BROWSERS, action: '聚焦浏览器搜索入口' },
  { shortcut: 'Ctrl+O', browsers: WINDOWS_BROWSERS, action: '打开文件' },
  { shortcut: 'Ctrl+A', browsers: DESKTOP_BROWSERS, action: '全选页面内容' },
  { shortcut: 'Ctrl+C', browsers: DESKTOP_BROWSERS, action: '复制' },
  { shortcut: 'Ctrl+X', browsers: DESKTOP_BROWSERS, action: '剪切' },
  { shortcut: 'Ctrl+V', browsers: DESKTOP_BROWSERS, action: '粘贴' },
  { shortcut: 'Ctrl+0', browsers: WINDOWS_BROWSERS, action: '重置页面缩放' },
  { shortcut: 'Ctrl+G', browsers: WINDOWS_BROWSERS, action: '查找下一个' },
  { shortcut: 'Ctrl+Shift+G', browsers: WINDOWS_BROWSERS, action: '查找上一个' },
  { shortcut: 'Ctrl+Shift+I', browsers: WINDOWS_BROWSERS, action: '打开开发者工具' },
  { shortcut: 'Ctrl+Shift+J', browsers: ['Edge', 'Chrome'], action: '打开开发者工具控制台' },
  { shortcut: 'Ctrl+Shift+K', browsers: ['Firefox'], action: '打开开发者工具控制台' },
  { shortcut: 'Ctrl+Shift+C', browsers: WINDOWS_BROWSERS, action: '检查页面元素' },
  { shortcut: 'Ctrl+F4', browsers: WINDOWS_BROWSERS, action: '关闭当前标签页' },
  { shortcut: 'Ctrl+Tab', browsers: DESKTOP_BROWSERS, action: '切换到下一个标签页' },
  { shortcut: 'Ctrl+Shift+Tab', browsers: DESKTOP_BROWSERS, action: '切换到上一个标签页' },
  { shortcut: 'Ctrl+PageUp', browsers: WINDOWS_BROWSERS, action: '切换到上一个标签页' },
  { shortcut: 'Ctrl+PageDown', browsers: WINDOWS_BROWSERS, action: '切换到下一个标签页' },
  ...Array.from({ length: 9 }, (_, index) => ({
    shortcut: `Ctrl+${index + 1}`,
    browsers: WINDOWS_BROWSERS,
    action: '切换标签页',
  })),
  { shortcut: 'Ctrl+Shift+Delete', browsers: WINDOWS_BROWSERS, action: '打开清除浏览数据' },
  { shortcut: 'Alt+Left', browsers: WINDOWS_BROWSERS, action: '后退' },
  { shortcut: 'Alt+Right', browsers: WINDOWS_BROWSERS, action: '前进' },
  { shortcut: 'Alt+Home', browsers: WINDOWS_BROWSERS, action: '打开主页' },
  { shortcut: 'Alt+D', browsers: WINDOWS_BROWSERS, action: '聚焦地址栏' },
  { shortcut: 'Alt+F4', browsers: WINDOWS_BROWSERS, action: '关闭窗口' },
  { shortcut: 'F1', browsers: WINDOWS_BROWSERS, action: '打开帮助' },
  { shortcut: 'F3', browsers: WINDOWS_BROWSERS, action: '查找下一个' },
  { shortcut: 'Shift+F3', browsers: WINDOWS_BROWSERS, action: '查找上一个' },
  { shortcut: 'F5', browsers: WINDOWS_BROWSERS, action: '刷新页面' },
  { shortcut: 'F6', browsers: DESKTOP_BROWSERS, action: '切换浏览器焦点区域' },
  { shortcut: 'F7', browsers: ['Edge', 'Chrome', 'Firefox'], action: '切换光标浏览' },
  { shortcut: 'F11', browsers: WINDOWS_BROWSERS, action: '切换全屏' },
  { shortcut: 'F12', browsers: WINDOWS_BROWSERS, action: '打开开发者工具' },
  { shortcut: 'Shift+Escape', browsers: ['Edge', 'Chrome'], action: '打开浏览器任务管理器' },
  { shortcut: 'Cmd+W', browsers: MAC_BROWSERS, action: '关闭当前标签页' },
  { shortcut: 'Cmd+Shift+W', browsers: MAC_BROWSERS, action: '关闭当前窗口' },
  { shortcut: 'Cmd+T', browsers: MAC_BROWSERS, action: '新建标签页' },
  { shortcut: 'Cmd+Shift+T', browsers: MAC_BROWSERS, action: '恢复关闭的标签页' },
  { shortcut: 'Cmd+N', browsers: MAC_BROWSERS, action: '新建窗口' },
  { shortcut: 'Cmd+Shift+N', browsers: MAC_BROWSERS, action: '新建隐私窗口' },
  { shortcut: 'Cmd+L', browsers: MAC_BROWSERS, action: '聚焦地址栏' },
  { shortcut: 'Cmd+R', browsers: MAC_BROWSERS, action: '刷新页面' },
  { shortcut: 'Cmd+Alt+R', browsers: ['Safari'], action: '强制刷新页面' },
  { shortcut: 'Cmd+Alt+F', browsers: MAC_BROWSERS, action: '聚焦浏览器搜索入口' },
  { shortcut: 'Cmd+F', browsers: MAC_BROWSERS, action: '页内查找' },
  { shortcut: 'Cmd+P', browsers: MAC_BROWSERS, action: '打印页面' },
  { shortcut: 'Cmd+S', browsers: MAC_BROWSERS, action: '保存页面' },
  { shortcut: 'Cmd+O', browsers: MAC_BROWSERS, action: '打开文件' },
  { shortcut: 'Cmd+A', browsers: MAC_BROWSERS, action: '全选页面内容' },
  { shortcut: 'Cmd+C', browsers: MAC_BROWSERS, action: '复制' },
  { shortcut: 'Cmd+X', browsers: MAC_BROWSERS, action: '剪切' },
  { shortcut: 'Cmd+V', browsers: MAC_BROWSERS, action: '粘贴' },
  { shortcut: 'Cmd+0', browsers: MAC_BROWSERS, action: '重置页面缩放' },
  { shortcut: 'Cmd+G', browsers: MAC_BROWSERS, action: '查找下一个' },
  { shortcut: 'Cmd+Shift+G', browsers: MAC_BROWSERS, action: '查找上一个' },
  { shortcut: 'Cmd+Alt+I', browsers: MAC_BROWSERS, action: '打开开发者工具' },
  { shortcut: 'Cmd+Alt+J', browsers: ['Chrome (macOS)'], action: '打开开发者工具控制台' },
  { shortcut: 'Cmd+Alt+K', browsers: ['Firefox (macOS)'], action: '打开开发者工具控制台' },
  { shortcut: 'Cmd+Alt+C', browsers: MAC_BROWSERS, action: '检查页面元素' },
  { shortcut: 'Cmd+Alt+U', browsers: ['Safari'], action: '查看源代码' },
  { shortcut: 'Cmd+[', browsers: ['Safari'], action: '后退' },
  { shortcut: 'Cmd+]', browsers: ['Safari'], action: '前进' },
  { shortcut: 'Cmd+Q', browsers: MAC_BROWSERS, action: '退出浏览器' },
  ...Array.from({ length: 9 }, (_, index) => ({
    shortcut: `Cmd+${index + 1}`,
    browsers: MAC_BROWSERS,
    action: '切换标签页',
  })),
];

export const RECORDING_SHORTCUT_KEY_OPTIONS: readonly { value: string; label: string }[] = [
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map((key) => ({ value: key, label: key.toUpperCase() })),
  ...'0123456789'.split('').map((key) => ({ value: key, label: key })),
  ...Array.from({ length: 12 }, (_, index) => ({ value: `f${index + 1}`, label: `F${index + 1}` })),
  { value: 'space', label: 'Space' },
  { value: 'left', label: '←' },
  { value: 'right', label: '→' },
  { value: 'up', label: '↑' },
  { value: 'down', label: '↓' },
  { value: '[', label: '[' },
  { value: ']', label: ']' },
];

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  space: 'Space',
  tab: 'Tab',
  escape: 'Escape',
  delete: 'Delete',
  backspace: 'Backspace',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'space',
  spacebar: 'space',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
};

function normalizeKey(key: string): string {
  const lower = key.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

function shortcutIdentity(shortcut: KeyboardShortcut): string {
  return [
    shortcut.ctrlKey ? 'c' : '-',
    shortcut.altKey ? 'a' : '-',
    shortcut.shiftKey ? 's' : '-',
    shortcut.metaKey ? 'm' : '-',
    shortcut.key,
  ].join(':');
}

export function parseShortcut(value: string): KeyboardShortcut | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const shortcut: KeyboardShortcut = {
    key: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === 'ctrl' || normalized === 'control') shortcut.ctrlKey = true;
    else if (normalized === 'alt' || normalized === 'option') shortcut.altKey = true;
    else if (normalized === 'shift') shortcut.shiftKey = true;
    else if (normalized === 'cmd' || normalized === 'command' || normalized === 'meta') {
      shortcut.metaKey = true;
    } else if (!shortcut.key) shortcut.key = normalizeKey(part);
    else return null;
  }
  return shortcut.key ? shortcut : null;
}

export function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrlKey) parts.push('Ctrl');
  if (shortcut.altKey) parts.push('Alt');
  if (shortcut.shiftKey) parts.push('Shift');
  if (shortcut.metaKey) parts.push('Cmd');
  const key = DISPLAY_KEYS[shortcut.key] ??
    (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key.toUpperCase());
  parts.push(key);
  return parts.join('+');
}

export function matchesShortcut(event: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
  return (
    normalizeKey(event.key) === shortcut.key &&
    event.ctrlKey === shortcut.ctrlKey &&
    event.altKey === shortcut.altKey &&
    event.shiftKey === shortcut.shiftKey &&
    event.metaKey === shortcut.metaKey
  );
}

const RESERVED_IDENTITIES = new Map(
  BROWSER_RESERVED_SHORTCUTS.flatMap((entry) => {
    const shortcut = parseShortcut(entry.shortcut);
    return shortcut ? [[shortcutIdentity(shortcut), entry] as const] : [];
  }),
);

const APP_SHORTCUT_IDENTITIES = new Set(
  ['Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Meta+Z', 'Meta+Shift+Z', 'Meta+Y'].flatMap((value) => {
    const shortcut = parseShortcut(value);
    return shortcut ? [shortcutIdentity(shortcut)] : [];
  }),
);

const UNMODIFIED_APP_KEYS = new Set([
  'space',
  'tab',
  'escape',
  'delete',
  'backspace',
  '1',
  '2',
  '3',
  'w',
  'a',
  's',
  'd',
  'q',
  'e',
  'left',
  'right',
  'up',
  'down',
  '[',
  ']',
]);

const CAMERA_DRIVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'left', 'right', 'up', 'down', '[', ']']);

export function validateRecordingShortcut(shortcut: KeyboardShortcut): string | null {
  const reserved = RESERVED_IDENTITIES.get(shortcutIdentity(shortcut));
  if (reserved) {
    return `${formatShortcut(shortcut)} 是 ${reserved.browsers.join('/')} 浏览器的“${reserved.action}”快捷键，不能用于录制`;
  }
  if (APP_SHORTCUT_IDENTITIES.has(shortcutIdentity(shortcut))) {
    return `${formatShortcut(shortcut)} 已用于 Lumora 编辑命令，不能同时用于录制`;
  }
  if ((shortcut.ctrlKey || shortcut.metaKey) && shortcut.key === 'k') {
    return `${formatShortcut(shortcut)} 已用于 Lumora 命令面板，不能同时用于录制`;
  }
  if (!shortcut.ctrlKey && !shortcut.altKey && !shortcut.metaKey && CAMERA_DRIVE_KEYS.has(shortcut.key)) {
    return `${formatShortcut(shortcut)} 已用于 Lumora 机位驾驶，不能同时用于录制`;
  }
  if (
    !shortcut.ctrlKey &&
    !shortcut.altKey &&
    !shortcut.shiftKey &&
    !shortcut.metaKey &&
    UNMODIFIED_APP_KEYS.has(shortcut.key)
  ) {
    return `${formatShortcut(shortcut)} 已用于 Lumora 导航或机位驾驶，不能同时用于录制`;
  }
  return null;
}

function browserStorage(): ShortcutStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadRecordingShortcut(storage: ShortcutStorage | null = browserStorage()): KeyboardShortcut {
  if (!storage) return { ...DEFAULT_RECORDING_SHORTCUT };
  try {
    const saved = storage.getItem(RECORDING_SHORTCUT_STORAGE_KEY);
    const shortcut = saved ? parseShortcut(saved) : null;
    if (shortcut && validateRecordingShortcut(shortcut) === null) return shortcut;
  } catch {
    // Storage can be blocked by privacy settings; use the safe default.
  }
  return { ...DEFAULT_RECORDING_SHORTCUT };
}

export function saveRecordingShortcut(
  shortcut: KeyboardShortcut,
  storage: ShortcutStorage | null = browserStorage(),
): boolean {
  if (validateRecordingShortcut(shortcut) !== null || !storage) return false;
  try {
    storage.setItem(RECORDING_SHORTCUT_STORAGE_KEY, formatShortcut(shortcut));
    return true;
  } catch {
    return false;
  }
}
