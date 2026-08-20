import { useEffect, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 轻量全局消息提示（编辑器操作结果反馈，无需事件总线） */
export function showToast(message: string, kind: ToastKind = 'info'): void {
  const item = { id: nextId, message, kind };
  nextId += 1;
  items = [...items, item];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== item.id);
    emit();
  }, 4000);
}

export function useToasts(): ToastItem[] {
  const [state, setState] = useState<ToastItem[]>(items);
  useEffect(() => {
    const sync = () => setState(items);
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return state;
}

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="lumora-toasts" data-testid="lumora-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`lumora-toast lumora-toast--${toast.kind}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
