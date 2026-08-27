/** Mounted Studio roots share window keyboard listeners. A single embedded Studio keeps
 * the historical document/body fallback; focusable host controls remain host-owned.
 * Multiple Studios admit only events originating inside the owning root. */
const mountedStudioRoots = new Set<HTMLElement>();

export function stopActivationKeyPropagation(event: { key: string; stopPropagation(): void }): void {
  if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
}

export function registerStudioKeyboardRoot(root: HTMLElement): () => void {
  mountedStudioRoots.add(root);
  return () => mountedStudioRoots.delete(root);
}

export function isKeyboardEventForStudio(root: HTMLElement, event: Event): boolean {
  const targetInside = event.target instanceof Node && root.contains(event.target);
  const unownedDocumentTarget = event.target === document || event.target === document.body;
  return targetInside || (
    unownedDocumentTarget &&
    mountedStudioRoots.size === 1 &&
    mountedStudioRoots.has(root)
  );
}
