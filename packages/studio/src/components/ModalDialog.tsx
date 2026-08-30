import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function canRestoreFocus(target: HTMLElement): boolean {
  if (!target.isConnected || target.matches(':disabled')) return false;
  let current: HTMLElement | null = target;
  while (current) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (current.hidden || style?.display === 'none' || style?.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}

interface ModalDialogProps {
  children: ReactNode;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  backdropClassName?: string;
  dialogClassName: string;
  backdropTestId?: string;
  dialogTestId?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  onDialogKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/** Shared modal boundary for Studio overlays, including host-page keyboard isolation. */
export function ModalDialog({
  children,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  backdropClassName,
  dialogClassName,
  backdropTestId,
  dialogTestId,
  initialFocusRef,
  returnFocusRef,
  closeOnBackdrop = true,
  onDialogKeyDown,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusReturnCandidatesRef = useRef<HTMLElement[]>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const candidates = activeElement && activeElement !== document.body
      ? [activeElement, returnFocusRef?.current]
      : [returnFocusRef?.current, activeElement];
    focusReturnCandidatesRef.current = candidates.filter(
      (candidate, index, candidates): candidate is HTMLElement =>
        candidate instanceof HTMLElement && candidates.indexOf(candidate) === index,
    );
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (initialFocusRef?.current ?? focusables()[0] ?? dialog).focus();

    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      const activeInside = document.activeElement instanceof Node && dialog.contains(document.activeElement);
      const targetInside = event.target instanceof Node && dialog.contains(event.target);
      if (!targetInside && event.key !== 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!activeInside) {
        event.preventDefault();
        event.stopImmediatePropagation();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        event.stopImmediatePropagation();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        event.stopImmediatePropagation();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
      focusReturnCandidatesRef.current.find(canRestoreFocus)?.focus();
    };
  }, [initialFocusRef, returnFocusRef]);

  return createPortal(
    <div
      className={`lumora-studio lumora-studio--portal lumora-modal-backdrop${backdropClassName ? ` ${backdropClassName}` : ''}`}
      data-testid={backdropTestId}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className={dialogClassName}
        data-testid={dialogTestId}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onKeyDown={(event) => {
          onDialogKeyDown?.(event);
          event.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
