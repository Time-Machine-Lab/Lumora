import { useLayoutEffect, useRef } from 'react';
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

function deepActiveElement(root: Document | ShadowRoot): HTMLElement | null {
  let active = root.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : null;
}

function composedParent(element: HTMLElement): HTMLElement | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
}

function composedContains(container: HTMLElement, target: HTMLElement | null): boolean {
  let current = target;
  while (current) {
    if (container.contains(current)) return true;
    current = composedParent(current);
  }
  return false;
}

function canRestoreFocus(target: HTMLElement): boolean {
  if (!target.isConnected || target.matches(':disabled')) return false;
  let current: HTMLElement | null = target;
  while (current) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (
      current.hidden ||
      current.hasAttribute('inert') ||
      style?.display === 'none' ||
      style?.visibility === 'hidden'
    ) return false;
    current = composedParent(current);
  }
  return true;
}

interface InertSnapshot {
  hadAttribute: boolean;
  propertyValue: boolean;
}

interface ModalEntry {
  dialog: HTMLDivElement;
  portalRoot: HTMLDivElement;
  returnFocusCandidates: HTMLElement[];
  close: () => void;
  initialFocus: HTMLElement | null;
}

class DocumentModalManager {
  private readonly stack: ModalEntry[] = [];
  private readonly inertSnapshots = new Map<HTMLElement, InertSnapshot>();
  private observer: MutationObserver | null = null;

  constructor(private readonly document: Document) {}

  register(entry: ModalEntry): () => void {
    this.stack.push(entry);
    if (this.stack.length === 1) {
      this.document.addEventListener('keydown', this.onKeyDown, true);
      this.document.addEventListener('focusin', this.onFocusIn, true);
      this.observer = new MutationObserver(() => this.reconcileInert());
      this.observer.observe(this.document.body, { childList: true });
    }
    this.reconcileInert();
    this.focusEntry(entry, false, entry.initialFocus);
    return () => this.unregister(entry);
  }

  private unregister(entry: ModalEntry) {
    const index = this.stack.indexOf(entry);
    if (index < 0) return;
    const wasTop = index === this.stack.length - 1;
    this.stack.splice(index, 1);
    this.reconcileInert();

    if (this.stack.length === 0) {
      this.document.removeEventListener('keydown', this.onKeyDown, true);
      this.document.removeEventListener('focusin', this.onFocusIn, true);
      this.observer?.disconnect();
      this.observer = null;
    }
    if (!wasTop) return;

    const next = this.top();
    const candidate = entry.returnFocusCandidates.find((target) =>
      canRestoreFocus(target) && (!next || composedContains(next.dialog, target)),
    );
    if (candidate) candidate.focus();
    else if (next) this.focusEntry(next);
  }

  private top(): ModalEntry | undefined {
    return this.stack[this.stack.length - 1];
  }

  private focusables(entry: ModalEntry): HTMLElement[] {
    return Array.from(entry.dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(canRestoreFocus);
  }

  private focusEntry(entry: ModalEntry, preferLast = false, preferred: HTMLElement | null = null) {
    const items = this.focusables(entry);
    const target = preferred && canRestoreFocus(preferred)
      ? preferred
      : preferLast
        ? items[items.length - 1]
        : items[0];
    (target ?? entry.dialog).focus();
  }

  private readonly onFocusIn = (event: FocusEvent) => {
    const top = this.top();
    if (!top || composedContains(top.dialog, deepActiveElement(this.document))) return;
    event.stopImmediatePropagation();
    this.focusEntry(top);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const top = this.top();
    if (!top) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      top.close();
      return;
    }

    const active = deepActiveElement(this.document);
    const activeInside = composedContains(top.dialog, active);
    const targetInside = event.composedPath().includes(top.dialog) || (
      event.target instanceof HTMLElement && composedContains(top.dialog, event.target)
    );
    if (event.key !== 'Tab') {
      if (!activeInside || !targetInside) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    const items = this.focusables(top);
    if (items.length === 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      top.dialog.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (!activeInside || !targetInside) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.focusEntry(top, event.shiftKey);
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      event.stopImmediatePropagation();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      event.stopImmediatePropagation();
      first.focus();
    }
  };

  private restoreInert(element: HTMLElement) {
    const snapshot = this.inertSnapshots.get(element);
    if (!snapshot) return;
    element.toggleAttribute('inert', snapshot.hadAttribute);
    element.inert = snapshot.propertyValue;
    this.inertSnapshots.delete(element);
  }

  private reconcileInert() {
    const top = this.top();
    if (!top) {
      for (const element of Array.from(this.inertSnapshots.keys())) this.restoreInert(element);
      return;
    }

    const bodyChildren = Array.from(this.document.body.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    for (const child of bodyChildren) {
      if (child === top.portalRoot) {
        this.restoreInert(child);
        continue;
      }
      if (!this.inertSnapshots.has(child)) {
        this.inertSnapshots.set(child, {
          hadAttribute: child.hasAttribute('inert'),
          propertyValue: child.inert,
        });
      }
      child.setAttribute('inert', '');
      child.inert = true;
    }
  }
}

const modalManagers = new WeakMap<Document, DocumentModalManager>();

function modalManagerFor(document: Document): DocumentModalManager {
  let manager = modalManagers.get(document);
  if (!manager) {
    manager = new DocumentModalManager(document);
    modalManagers.set(document, manager);
  }
  return manager;
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

/** Shared, document-scoped modal boundary for Studio overlays and embedded hosts. */
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
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const portalRoot = backdropRef.current;
    if (!dialog || !portalRoot) return;
    const activeElement = deepActiveElement(dialog.ownerDocument);
    const candidates = activeElement && activeElement !== dialog.ownerDocument.body
      ? [activeElement, returnFocusRef?.current]
      : [returnFocusRef?.current, activeElement];
    const returnFocusCandidates = candidates.filter(
      (candidate, index, list): candidate is HTMLElement =>
        candidate instanceof HTMLElement && list.indexOf(candidate) === index,
    );
    return modalManagerFor(dialog.ownerDocument).register({
      dialog,
      portalRoot,
      returnFocusCandidates,
      close: () => closeRef.current(),
      initialFocus: initialFocusRef?.current ?? null,
    });
  }, [initialFocusRef, returnFocusRef]);

  return createPortal(
    <div
      ref={backdropRef}
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
