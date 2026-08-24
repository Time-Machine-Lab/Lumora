/**
 * OPFS 适配器单测用的内存文件系统 shim：只实现 OpfsProjectStore 实际使用的
 * API 子集（getFileHandle / getDirectoryHandle / removeEntry / entries /
 * createWritable / move / getFile），行为对齐 File System Access 规范
 * （getFileHandle 缺省 create:false 时缺失抛 NotFoundError；move 覆盖目标名）。
 * failNextWrite 钩子用于注入配额不足等写入失败，验证原子写保护。
 */

import { vi } from 'vitest';
import type { OpfsDirectoryHandle, OpfsFileHandle } from '../src/persistence/project-store-opfs';

class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export class MemWritable {
  private closed = false;

  constructor(
    private readonly file: MemFileHandle,
    private readonly dir: MemDirectoryHandle,
  ) {}

  async write(data: string): Promise<void> {
    if (this.closed) throw new Error('writable 已关闭');
    const failure = this.dir.takeWriteFailure();
    if (failure) throw failure;
    this.file.text = data;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class MemFileHandle implements OpfsFileHandle {
  readonly kind = 'file' as const;
  text = '';

  constructor(
    public name: string,
    private parent: MemDirectoryHandle,
  ) {}

  async getFile(): Promise<{ text(): Promise<string> }> {
    return {
      text: async () => this.text,
    };
  }

  async createWritable(): Promise<MemWritable> {
    return new MemWritable(this, this.parent);
  }

  /** move：从当前父目录摘除，写入目标目录（目标名已存在则覆盖） */
  async move(destination: MemDirectoryHandle, name: string): Promise<void> {
    this.parent.children.delete(this.name);
    this.parent = destination;
    this.name = name;
    destination.children.set(name, this);
  }
}

export class MemDirectoryHandle implements OpfsDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MemFileHandle | MemDirectoryHandle>();
  /** 一次性写入失败钩子（配额注入）：取走后清空 */
  private writeFailure: Error | null = null;

  constructor(readonly name: string) {}

  failNextWrite(error: Error): void {
    this.writeFailure = error;
  }

  takeWriteFailure(): Error | null {
    const failure = this.writeFailure;
    this.writeFailure = null;
    return failure;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error('TypeMismatchError');
      return existing as MemDirectoryHandle;
    }
    if (!options?.create) throw new NotFoundError(`目录不存在：${name}`);
    const dir = new MemDirectoryHandle(name);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error('TypeMismatchError');
      return existing as MemFileHandle;
    }
    if (!options?.create) throw new NotFoundError(`文件不存在：${name}`);
    const file = new MemFileHandle(name, this);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new NotFoundError(`条目不存在：${name}`);
  }

  async *entries(): AsyncIterableIterator<[string, MemFileHandle | MemDirectoryHandle]> {
    for (const [name, entry] of this.children) {
      yield [name, entry];
    }
  }
}

/** 便捷构造：目录直接包含若干「文件名 → 文本内容」的只读文件 */
export function memDirWithFiles(name: string, files: Record<string, string>): MemDirectoryHandle {
  const dir = new MemDirectoryHandle(name);
  for (const [fileName, text] of Object.entries(files)) {
    const handle = new MemFileHandle(fileName, dir);
    handle.text = text;
    dir.children.set(fileName, handle);
  }
  return dir;
}

export interface LockStub {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * 互斥 Web Locks 模拟（jsdom 无 navigator.locks）：按锁名串行化，语义与生产
 * withFallbackLock 一致 —— 前序任务 reject（锁内异常）不毒化队列，任务自身
 * 的异常传播给调用方但仍在 finally 释放互斥位。挂到 navigator.locks 后生产
 * 路径走 Web Locks 分支，同一 navigator 内的多实例（模拟多标签页）共享互斥。
 */
export function makeLockStub(): LockStub {
  const chains = new Map<string, Promise<void>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const previous = chains.get(name) ?? Promise.resolve();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      chains.set(
        name,
        previous
          .catch(() => {})
          .then(() => gate),
      );
      return previous
        .catch(() => {})
        .then(async () => {
          try {
            return await callback();
          } finally {
            release();
          }
        });
    },
  };
}

/**
 * 把内存根目录 + 互斥 Web Locks 模拟挂到 navigator（生产代码的两个注入点：
 * navigator.storage.getDirectory 与 navigator.locks）。无 locks 时生产路径会
 * 因 Web Locks 固化检查（无 Web Locks 即禁用 OPFS）返回 null。
 */
export function stubOpfsNavigator(root: MemDirectoryHandle): void {
  vi.stubGlobal(
    'navigator',
    Object.create(navigator, {
      storage: {
        value: { getDirectory: async () => root },
        configurable: true,
      },
      locks: {
        value: makeLockStub(),
        configurable: true,
      },
    }),
  );
}
