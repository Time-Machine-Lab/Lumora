/** Mounted Studio roots share window keyboard listeners. A single embedded Studio keeps
 * the historical owner-document/body fallback; focusable host controls remain host-owned.
 * Multiple or nested Studios admit only the nearest registered root in the event path. */
const mountedStudioRoots = new Set<HTMLElement>();

interface ClosestElement {
  closest(selectors: string): ClosestElement | null;
  getAttribute(name: string): string | null;
}

const NATIVE_KEYBOARD_CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  'option',
  'a[href]',
  'area[href]',
  'summary',
  'audio[controls]',
  'video[controls]',
].join(',');

function isClosestElement(value: unknown): value is ClosestElement {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { closest?: unknown; getAttribute?: unknown };
  return typeof candidate.closest === 'function' && typeof candidate.getAttribute === 'function';
}

export function preservesNativeKeyboardSemantics(event: Event): boolean {
  const source = event.composedPath()[0];
  if (!isClosestElement(source)) return false;
  const key = 'key' in event ? event.key : undefined;
  if (source.closest('button')) return key !== 'Escape';
  if (source.closest(NATIVE_KEYBOARD_CONTROL_SELECTOR)) return true;

  const editable = source.closest('[contenteditable]');
  const editableValue = editable?.getAttribute('contenteditable');
  return editableValue !== null && editableValue !== undefined && editableValue.toLowerCase() !== 'false';
}

export function stopActivationKeyPropagation(event: { key: string; stopPropagation(): void }): void {
  if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
}

export function registerStudioKeyboardRoot(root: HTMLElement): () => void {
  mountedStudioRoots.add(root);
  return () => mountedStudioRoots.delete(root);
}

export function isKeyboardEventForStudio(root: HTMLElement, event: Event): boolean {
  const nearestPathRoot = event
    .composedPath()
    .find((target) => mountedStudioRoots.has(target as HTMLElement));
  if (nearestPathRoot) return nearestPathRoot === root;

  const ownerDocument = root.ownerDocument;
  const targetInside = event.target instanceof Node && root.contains(event.target);
  const unownedDocumentTarget = event.target === ownerDocument || event.target === ownerDocument.body;
  return targetInside || (
    unownedDocumentTarget &&
    mountedStudioRoots.size === 1 &&
    mountedStudioRoots.has(root)
  );
}
