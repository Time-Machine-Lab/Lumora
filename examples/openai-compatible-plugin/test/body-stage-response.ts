import { vi } from 'vitest';
import type { OpenAiFetch } from '../src/openai-client';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export interface ControlledBodyStageResponse {
  readonly fetchImpl: ReturnType<typeof vi.fn<OpenAiFetch>>;
  readonly bodyReadStarted: Promise<void>;
  readonly readerCleanupSettled: Promise<void>;
  releaseBody(): void;
}

export function createControlledBodyStageResponse(value: unknown): ControlledBodyStageResponse {
  const body = deferred<unknown>();
  const bodyReadStarted = deferred<void>();
  const readerCleanupSettled = deferred<void>();
  const response = new Response(null, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  let reading = false;
  let released = false;

  Object.defineProperty(response, 'json', {
    configurable: true,
    value: () => {
      reading = true;
      bodyReadStarted.resolve();
      return body.promise;
    },
  });

  const fetchImpl = vi.fn<OpenAiFetch>(async (_input, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('The controlled response requires the production request signal.');
    const removeEventListener = signal.removeEventListener.bind(signal);
    Object.defineProperty(signal, 'removeEventListener', {
      configurable: true,
      value: (
        type: string,
        callback: EventListenerOrEventListenerObject,
        options?: EventListenerOptions | boolean,
      ) => {
        removeEventListener(type, callback, options);
        if (reading && type === 'abort') readerCleanupSettled.resolve();
      },
    });
    return response;
  });

  return {
    fetchImpl,
    bodyReadStarted: bodyReadStarted.promise,
    readerCleanupSettled: readerCleanupSettled.promise,
    releaseBody() {
      if (released) return;
      released = true;
      body.resolve(value);
    },
  };
}
