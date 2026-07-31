import { readFile } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { join } from 'node:path';

import { Environment, WristDevice } from '@golf/types';
import { WebSocket, WebSocketServer } from 'ws';

import { runProgramLoop } from './program-runner';
import { RecapTracker, loadRecaps } from './recap-endpoint';
import { HubServices } from './services';
import { HubCommand, RecapsPayload, SnapshotMessage } from './shared/protocol';
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
  /** fires after a session ends — the daily coach-recap hook */
  onSessionEnd?(sessionId: string): void;
  /**
   * State of the in-flight coach recap, owned by whoever drives
   * `onSessionEnd`. Optional so tests can stand the server up without a coach;
   * absent reports 'idle'.
   */
  recapTracker?: RecapTracker;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const INSIGHTS_PATH = '/api/insights';
const RECAPS_PATH = '/api/recaps';
const RECAP_LIMIT = 5;

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

      // Findings and baselines are windowed over the whole shot history, so
      // insights are pulled on demand rather than riding the per-shot snapshot
      // push — recomputing the engine on every shot would be wasted work.
      //
      // This GET also runs the §6.10 prescription loop, which WRITES training
      // blocks. A GET must not have side effects that surprise the caller,
      // and this one does not: the loop is idempotent by construction —
      // `prescribe` skips findings an existing non-abandoned block already
      // covers, and `evaluate` only resolves blocks whose re-measure window
      // has closed — so running it here is safe. Two identical requests over
      // unchanged history leave the store identical.
      if (path === INSIGHTS_PATH) {
        try {
          const { payload } = await runProgramLoop(services.data, Date.now());
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(payload));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          res
            .writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error }));
        }
        return;
      }

      // Stored recaps plus the state of the run in flight, in one response:
      // a UI that fetched them separately could show an empty list while the
      // coach was mid-run and call it "no recap".
      if (path === RECAPS_PATH) {
        try {
          const tracked = config.recapTracker?.snapshot();
          const payload: RecapsPayload = {
            status: tracked?.status ?? 'idle',
            error: tracked?.error ?? null,
            recaps: await loadRecaps(services.data, RECAP_LIMIT),
          };
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(payload));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          res
            .writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error }));
        }
        return;
      }

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
        return store.startSession(config.environment, {
          ...(command.intent ? { defaultIntent: command.intent } : {}),
          ...(command.focusClubId ? { focusClubId: command.focusClubId } : {}),
        });
      case 'endSession': {
        const endedSessionId = store.session?.id;
        await store.endSession();
        if (endedSessionId) config.onSessionEnd?.(endedSessionId);
        return;
      }
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
