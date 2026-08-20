/** 撤销/重做历史栈：快照对 + 指针，支持有界深度与标签（FR-013）。 */

export interface HistoryEntry<T> {
  label: string;
  before: T;
  after: T;
}

export class HistoryStack<T> {
  private entries: HistoryEntry<T>[] = [];
  /** 当前状态对应 entries[index].after */
  private index = -1;
  private readonly maxDepth: number;

  constructor(maxDepth = 100) {
    this.maxDepth = maxDepth;
  }

  /** 提交一步；截断重做尾，超过深度时丢弃最旧一步 */
  push(entry: HistoryEntry<T>): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(entry);
    if (this.entries.length > this.maxDepth) {
      this.entries.shift();
    }
    this.index = this.entries.length - 1;
  }

  /** 撤销：返回应应用的状态快照；无可撤销时返回 null */
  undo(): T | null {
    if (this.index < 0) return null;
    const entry = this.entries[this.index];
    this.index -= 1;
    return entry.before;
  }

  /** 重做：返回应应用的状态快照；无可重做时返回 null */
  redo(): T | null {
    const next = this.entries[this.index + 1];
    if (!next) return null;
    this.index += 1;
    return next.after;
  }

  get canUndo(): boolean {
    return this.index >= 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.index]!.label : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.index + 1]!.label : null;
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }
}
