import TcpSocket from 'react-native-tcp-socket';
import dgram from 'react-native-udp';

import { EyeMiniMonitor, MonitorConfig } from './monitor-service';
import {
  ConnectTimeoutError,
  TcpConnection,
  TcpConnectOptions,
  TcpFactory,
  UdpFactory,
  UdpSocket,
} from './transport';

/**
 * The ONLY file that touches native modules (react-native-tcp-socket /
 * react-native-udp) — everything else in the lib stays Node-pure. Requires a
 * custom dev client; never runs in Expo Go.
 */

const rnTcpFactory: TcpFactory = {
  connect(opts: TcpConnectOptions): Promise<TcpConnection> {
    return new Promise<TcpConnection>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ConnectTimeoutError(opts.host, opts.port));
      }, opts.timeoutMs);

      const socket = TcpSocket.createConnection(
        { host: opts.host, port: opts.port },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({
            write(data: Uint8Array): void {
              socket.write(data);
            },
            onData(handler: (chunk: Uint8Array) => void): void {
              socket.on('data', (chunk: string | Uint8Array) => {
                if (typeof chunk !== 'string') handler(chunk);
              });
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
          });
        },
      );

      socket.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
    });
  },
};

/**
 * Structural view of react-native-udp's socket — its published typings don't
 * expose the EventEmitter surface consistently across resolution modes.
 */
interface RnUdpSocket {
  bind(port: number, callback?: () => void): void;
  setBroadcast(flag: boolean): void;
  on(
    event: 'message',
    handler: (msg: Uint8Array, rinfo: { address: string }) => void,
  ): void;
  once(event: 'error', handler: (err: Error) => void): void;
  close(): void;
}

const rnUdpFactory: UdpFactory = {
  openBroadcastListener(port: number): Promise<UdpSocket> {
    return new Promise<UdpSocket>((resolve, reject) => {
      const socket = dgram.createSocket({
        type: 'udp4',
        reusePort: true,
      }) as unknown as RnUdpSocket;
      socket.once('error', (err: Error) => reject(err));
      socket.bind(port, () => {
        try {
          socket.setBroadcast(true);
        } catch {
          // some platforms deliver broadcast without the flag; non-fatal
        }
        resolve({
          onMessage(handler: (data: Uint8Array, fromIp: string) => void): void {
            socket.on(
              'message',
              (msg: Uint8Array, rinfo: { address: string }) => {
                handler(msg, rinfo.address);
              },
            );
          },
          close(): void {
            socket.close();
          },
        });
      });
    });
  },
};

/** Production factory: the monitor wired to the native RN transports. */
export function createNativeMonitorService(
  config: Omit<MonitorConfig, 'tcp' | 'udp'> = {},
): EyeMiniMonitor {
  return new EyeMiniMonitor({
    ...config,
    tcp: rnTcpFactory,
    udp: rnUdpFactory,
  });
}
