import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

export interface BodyStageServerCompletion {
  readonly writeAttempted: true;
  readonly responseClosed: true;
}

export interface BodyStageServer {
  readonly origin: string;
  readonly requestUrl: string;
  readonly headersFlushed: Promise<void>;
  readonly clientDisconnected: Promise<void>;
  readonly responseCompleted: Promise<BodyStageServerCompletion>;
  attempts(): number;
  releaseBody(): void;
  close(): Promise<void>;
}

export async function startBodyStageServer(responseBody: string): Promise<BodyStageServer> {
  const release = deferred<void>();
  const headersFlushed = deferred<void>();
  const clientDisconnected = deferred<void>();
  const responseCompleted = deferred<BodyStageServerCompletion>();
  let released = false;
  let postAttempts = 0;
  const server = createServer((request, response) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, corsHeaders);
      response.end();
      return;
    }

    postAttempts += 1;
    request.resume();
    const responseClosed = deferred<void>();
    const markClosed = () => responseClosed.resolve();
    response.once('finish', markClosed);
    response.once('close', () => {
      markClosed();
      if (!released) clientDisconnected.resolve();
    });
    response.on('error', () => undefined);
    response.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(responseBody),
      Connection: 'close',
    });
    response.flushHeaders();
    headersFlushed.resolve();

    void release.promise.then(async () => {
      try {
        response.end(responseBody);
      } catch {
        // The client may have closed after abort; the server still attempts the complete body write.
      }
      await responseClosed.promise;
      responseCompleted.resolve({ writeAttempted: true, responseClosed: true });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requestUrl: `${origin}/v1/chat/completions`,
    headersFlushed: headersFlushed.promise,
    clientDisconnected: clientDisconnected.promise,
    responseCompleted: responseCompleted.promise,
    attempts: () => postAttempts,
    releaseBody() {
      if (released) return;
      released = true;
      release.resolve();
    },
    close() {
      if (!released) {
        released = true;
        release.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
