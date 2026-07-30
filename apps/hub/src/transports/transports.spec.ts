import { createSocket } from 'node:dgram';
import { AddressInfo, createServer, Server } from 'node:net';

import { createNodeTcpFactory } from './tcp';
import { createNodeUdpFactory } from './udp';

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

describe('node tcp transport', () => {
  it('round-trips bytes over a loopback socket', async () => {
    const received: Buffer[] = [];
    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk);
        socket.write(Buffer.from([9, 9, 9]));
      });
    });
    const port = await listen(server);

    const conn = await createNodeTcpFactory().connect({
      host: '127.0.0.1',
      port,
      timeoutMs: 1000,
    });
    const echoed = new Promise<Uint8Array>((resolve) => conn.onData(resolve));
    conn.write(Uint8Array.of(1, 2, 3));

    expect(new Uint8Array(await echoed)).toEqual(Uint8Array.of(9, 9, 9));
    expect(new Uint8Array(received[0])).toEqual(Uint8Array.of(1, 2, 3));

    conn.destroy();
    server.close();
  });

  it('rejects when nothing is listening', async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));

    await expect(
      createNodeTcpFactory().connect({
        host: '127.0.0.1',
        port,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });
});

describe('node udp transport', () => {
  it('delivers datagrams with the sender ip', async () => {
    // fixed high port: openBroadcastListener binds the given port by contract
    const port = 43911;
    const socket = await createNodeUdpFactory().openBroadcastListener(port);
    const message = new Promise<{ data: Uint8Array; fromIp: string }>(
      (resolve) => {
        socket.onMessage((data, fromIp) => resolve({ data, fromIp }));
      },
    );

    const client = createSocket('udp4');
    client.send(Buffer.from('beacon'), port, '127.0.0.1');

    const { data, fromIp } = await message;
    expect(Buffer.from(data).toString()).toBe('beacon');
    expect(fromIp).toBe('127.0.0.1');

    client.close();
    socket.close();
  });
});
