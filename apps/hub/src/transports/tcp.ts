import { createConnection, Socket } from 'node:net';

import {
  ConnectTimeoutError,
  TcpConnection,
  TcpConnectOptions,
  TcpFactory,
} from '@golf/monitor';

/**
 * node:net implementation of the @golf/monitor TCP seam — the hub-side
 * counterpart of the app's rn-monitor-transport.
 */
function wrap(socket: Socket): TcpConnection {
  return {
    write(data: Uint8Array): void {
      socket.write(data);
    },
    onData(handler: (chunk: Uint8Array) => void): void {
      socket.on('data', (chunk) => handler(new Uint8Array(chunk)));
    },
    onClose(handler: () => void): void {
      socket.on('close', handler);
    },
    onError(handler: (err: Error) => void): void {
      socket.on('error', handler);
    },
    destroy(): void {
      socket.destroy();
    },
  };
}

export function createNodeTcpFactory(): TcpFactory {
  return {
    connect(opts: TcpConnectOptions): Promise<TcpConnection> {
      return new Promise((resolve, reject) => {
        const socket = createConnection({ host: opts.host, port: opts.port });
        socket.setTimeout(opts.timeoutMs);
        socket.once('timeout', () => {
          socket.destroy();
          reject(new ConnectTimeoutError(opts.host, opts.port));
        });
        socket.once('error', (err) => {
          socket.destroy();
          reject(err);
        });
        socket.once('connect', () => {
          socket.setTimeout(0);
          socket.removeAllListeners('error');
          resolve(wrap(socket));
        });
      });
    },
  };
}
