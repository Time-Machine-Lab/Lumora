/** Mounted Studio roots share window keyboard listeners. A single embedded Studio keeps
 * the historical owner-document/body fallback; focusable host controls remain host-owned.
 * Multiple or nested Studios admit only the nearest registered root in the event path. */
const mountedStudioRoots = new Set<HTMLElement>();

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
