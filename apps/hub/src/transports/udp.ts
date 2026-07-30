import { createSocket } from 'node:dgram';

import { UdpFactory, UdpSocket } from '@golf/monitor';

/** node:dgram implementation of the @golf/monitor UDP discovery seam. */
export function createNodeUdpFactory(): UdpFactory {
  return {
    openBroadcastListener(port: number): Promise<UdpSocket> {
      return new Promise((resolve, reject) => {
        const socket = createSocket({ type: 'udp4', reuseAddr: true });
        const handlers: ((data: Uint8Array, fromIp: string) => void)[] = [];
        socket.on('message', (data, rinfo) => {
          for (const handler of handlers) {
            handler(new Uint8Array(data), rinfo.address);
          }
        });
        socket.once('error', (err) => {
          socket.close();
          reject(err);
        });
        socket.bind(port, () => {
          socket.setBroadcast(true);
          resolve({
            onMessage(handler): void {
              handlers.push(handler);
            },
            close(): void {
              socket.close();
            },
          });
        });
      });
    },
  };
}
