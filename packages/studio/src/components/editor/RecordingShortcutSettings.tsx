import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import type { KeyboardShortcut } from './recording-shortcut';
import {
  DEFAULT_RECORDING_SHORTCUT,
  RECORDING_SHORTCUT_KEY_OPTIONS,
  formatShortcut,
  validateRecordingShortcut,
} from './recording-shortcut';

export interface RecordingShortcutSettingsProps {
  shortcut: KeyboardShortcut;
  onChange(shortcut: KeyboardShortcut): boolean;
}

export function RecordingShortcutSettings({ shortcut, onChange }: RecordingShortcutSettingsProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<KeyboardShortcut>(shortcut);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keyRef = useRef<HTMLSelectElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    keyRef.current?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && !event.composedPath().includes(root)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [close, open]);

  const update = (patch: Partial<KeyboardShortcut>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setError(validateRecordingShortcut(next));
  };

  const save = () => {
    const validation = validateRecordingShortcut(draft);
    if (validation) {
      setError(validation);
      return;
    }
    if (!onChange(draft)) {
      setError('浏览器未允许保存快捷键设置，请检查站点存储权限');
      return;
    }
    close();
  };

  return (
    <div className="lumora-recording-shortcut" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="lumora-timeline__shortcut-button"
        data-testid="recording-shortcut-settings"
        title={`设置录制快捷键（${formatShortcut(shortcut)}）`}
        aria-label={`设置录制快捷键，当前为 ${formatShortcut(shortcut)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setDraft(shortcut);
            setError(null);
          }
          setOpen((value) => !value);
        }}
      >
        <Keyboard aria-hidden="true" />
      </button>
      {open && (
        <div
          className="lumora-recording-shortcut__dialog"
          data-testid="recording-shortcut-dialog"
          role="dialog"
          aria-label="录制快捷键设置"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <div className="lumora-recording-shortcut__header">
            <span>录制快捷键</span>
            <kbd>{formatShortcut(draft)}</kbd>
          </div>
          <div className="lumora-recording-shortcut__modifiers">
            <label>
              <input
                type="checkbox"
                checked={draft.ctrlKey}
                onChange={(event) => update({ ctrlKey: event.target.checked })}
              />
              Ctrl
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.altKey}
                onChange={(event) => update({ altKey: event.target.checked })}
              />
              Alt
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.shiftKey}
                onChange={(event) => update({ shiftKey: event.target.checked })}
              />
              Shift
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.metaKey}
                onChange={(event) => update({ metaKey: event.target.checked })}
              />
              Win/Cmd
            </label>
          </div>
          <label className="lumora-recording-shortcut__key">
            <span>按键</span>
            <select
              ref={keyRef}
              className="lumora-select"
              data-testid="recording-shortcut-key"
              value={draft.key}
              onChange={(event) => update({ key: event.target.value })}
            >
              {RECORDING_SHORTCUT_KEY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p className="lumora-recording-shortcut__error" role="alert">
              {error}
            </p>
          )}
          <div className="lumora-recording-shortcut__actions">
            <button
              type="button"
              className="lumora-button"
              onClick={() => {
                setDraft({ ...DEFAULT_RECORDING_SHORTCUT });
                setError(null);
              }}
            >
              恢复默认
            </button>
            <button type="button" className="lumora-button" onClick={close}>
              取消
            </button>
            <button
              type="button"
              className="lumora-button"
              data-testid="recording-shortcut-save"
              disabled={error !== null}
              onClick={save}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
