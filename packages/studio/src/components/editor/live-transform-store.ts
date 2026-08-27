import type { Vec3 } from '@lumora/core';

export interface LiveTransformSnapshot {
  objectId: string;
  position: Vec3;
}

export class LiveTransformStore {
  private snapshot: LiveTransformSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): LiveTransformSnapshot | null => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(objectId: string, position: Vec3): void {
    const current = this.snapshot;
    if (
      current?.objectId === objectId &&
      current.position[0] === position[0] &&
      current.position[1] === position[1] &&
      current.position[2] === position[2]
    ) {
      return;
    }
    this.snapshot = { objectId, position: [...position] };
    for (const listener of this.listeners) listener();
  }

  clear(objectId?: string): void {
    if (!this.snapshot || (objectId !== undefined && this.snapshot.objectId !== objectId)) return;
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }
}
