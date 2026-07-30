import { readFile } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { join } from 'node:path';

import { Environment, WristDevice } from '@golf/types';
import { WebSocket, WebSocketServer } from 'ws';

import { HubServices } from './services';
import { HubCommand, SnapshotMessage } from './shared/protocol';
import { buildSnapshot } from './snapshot';

/**
 * Localhost HTTP + WebSocket surface for the hub: serves the session UI and
 * pushes full-state snapshots on every store change. The same server later
 * grows the phone-capture endpoints (clock sync, clip upload) — Phase 2.
 */
export interface HubServerConfig {
  services: HubServices;
  environment: Environment;
  uiDir: string;
  port: number;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export async function startHubServer(
  config: HubServerConfig,
): Promise<{ server: Server; close(): Promise<void> }> {
  const { services } = config;
  const clubs = await services.data.listClubs();
  const wristCandidates: WristDevice[] = [];

  services.wrist?.on('device', (device) => {
    if (!wristCandidates.some((d) => d.id === device.id)) {
      wristCandidates.push(device);
      pushSnapshots();
    }
  });

  const httpServer = createServer((req, res) => {
    void (async () => {
      const path = req.url === '/' || req.url === undefined ? '/index.html' : req.url;
      const ext = path.slice(path.lastIndexOf('.'));
      const type = CONTENT_TYPES[ext];
      if (!type || path.includes('..')) {
        res.writeHead(404).end();
        return;
      }
      try {
        const body = await readFile(join(config.uiDir, path));
        res.writeHead(200, { 'content-type': type }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    })();
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const snapshotMessage = (): string => {
    const message: SnapshotMessage = {
      type: 'snapshot',
      snapshot: buildSnapshot(services.store.getState(), {
        clubs,
        wristCandidates,
        environment: config.environment,
      }),
    };
    return JSON.stringify(message);
  };

  let pushTimer: NodeJS.Timeout | null = null;
  const pushSnapshots = (): void => {
    // trailing-edge coalesce: bursts of store updates become one push
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const message = snapshotMessage();
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      }
    }, 50);
  };

  const unsubscribe = services.store.subscribe(pushSnapshots);

  const dispatch = async (command: HubCommand): Promise<void> => {
    const store = services.store.getState();
    switch (command.cmd) {
      case 'startDiscovery':
        return store.startDiscovery();
      case 'connectMini':
        return store.connect(command.ip);
      case 'disconnectMini':
        return store.disconnect();
      case 'startSession':
        return store.startSession(config.environment, command.intent);
      case 'endSession':
        return store.endSession();
      case 'selectClub':
        return store.selectClub(command.clubId);
      case 'setActiveIntent':
        return store.setActiveIntent(command.intent);
      case 'startWristScan':
        wristCandidates.length = 0;
        return store.startWristScan();
      case 'stopWristScan':
        return store.stopWristScan();
      case 'connectWrist':
        return store.connectWrist(command.deviceId);
      case 'disconnectWrist':
        return store.disconnectWrist();
      case 'dismissWristAlert':
        return store.dismissWristAlert();
    }
  };

  wss.on('connection', (socket) => {
    socket.send(snapshotMessage());
    socket.on('message', (raw) => {
      let command: HubCommand;
      try {
        command = JSON.parse(String(raw)) as HubCommand;
      } catch {
        return;
      }
      dispatch(command).catch((err: Error) =>
        console.error(`[hub] command ${command.cmd} failed:`, err.message),
      );
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(config.port, '127.0.0.1', resolve),
  );

  return {
    server: httpServer,
    async close(): Promise<void> {
      unsubscribe();
      if (pushTimer) clearTimeout(pushTimer);
      wss.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
