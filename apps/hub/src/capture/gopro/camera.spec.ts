import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GoProCamera, createHttpCamera } from './camera';

/**
 * The camera transport against a stand-in that answers like Open GoPro 2.0.
 * Every request the driver will make on bench day passes through here, so a
 * wrong path or a misread status id shows up now rather than with a camera in
 * one hand and a golf club in the other.
 */
interface Bench {
  camera: GoProCamera;
  paths: string[];
  /** What `/gopro/camera/state` reports. */
  status: Record<string, number>;
  /** Set to answer every request with this status instead. */
  fail(code: number | null): void;
  server: Server;
  workDir: string;
  close(): void;
}

async function bench(): Promise<Bench> {
  const paths: string[] = [];
  const status: Record<string, number> = { '8': 0, '70': 91, '106': 1 };
  const workDir = mkdtempSync(join(tmpdir(), 'fairway-cam-'));

  let failWith: number | null = null;

  const server = createServer((req, res) => {
    const path = req.url ?? '';
    paths.push(path);
    if (failWith !== null) {
      res.writeHead(failWith).end();
      return;
    }
    if (path === '/gopro/camera/state') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status, settings: { '167': 2 } }));
      return;
    }
    if (path === '/gopro/media/list') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: '1',
          media: [
            { d: '100GOPRO', fs: [{ n: 'GX010001.MP4' }, { n: 'GX010002.MP4' }] },
            { d: '101GOPRO', fs: [{ n: 'GX010003.MP4' }] },
          ],
        }),
      );
      return;
    }
    if (path.startsWith('/videos/DCIM/')) {
      res.writeHead(200, { 'content-type': 'video/mp4' }).end('....mp4 bytes....');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    camera: createHttpCamera(`127.0.0.1:${port}`),
    paths,
    status,
    fail: (code) => {
      failWith = code;
    },
    server,
    workDir,
    close() {
      server.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

describe('createHttpCamera', () => {
  let b: Bench;
  beforeEach(async () => {
    b = await bench();
  });
  afterEach(() => {
    b.close();
  });

  it('arms Hindsight through setting 167', async () => {
    await b.camera.setHindsight(15);
    await b.camera.setHindsight(30);
    await b.camera.setHindsight('off');
    expect(b.paths).toEqual([
      '/gopro/camera/setting?setting=167&option=2',
      '/gopro/camera/setting?setting=167&option=3',
      '/gopro/camera/setting?setting=167&option=4',
    ]);
  });

  it('reads the three statuses the loop turns on', async () => {
    expect(await b.camera.state()).toEqual({
      hindsightActive: true, // 106
      encoding: false, // 8
      batteryPct: 91, // 70
    });

    b.status['106'] = 0;
    b.status['8'] = 1;
    expect(await b.camera.state()).toMatchObject({
      hindsightActive: false,
      encoding: true,
    });
  });

  it('reports an absent battery as unknown rather than as empty', async () => {
    delete b.status['70'];
    expect((await b.camera.state()).batteryPct).toBeNull();
  });

  it('triggers and saves through the shutter', async () => {
    await b.camera.shutter(true);
    await b.camera.shutter(false);
    expect(b.paths).toEqual([
      '/gopro/camera/shutter/start',
      '/gopro/camera/shutter/stop',
    ]);
  });

  it('flattens the media list across card directories', async () => {
    expect(await b.camera.mediaList()).toEqual([
      '100GOPRO/GX010001.MP4',
      '100GOPRO/GX010002.MP4',
      '101GOPRO/GX010003.MP4',
    ]);
  });

  it('streams a save to disk and reports what it wrote', async () => {
    const dest = join(b.workDir, 'save.mp4');
    const bytes = await b.camera.download('100GOPRO/GX010002.MP4', dest);

    expect(b.paths).toContain('/videos/DCIM/100GOPRO/GX010002.MP4');
    expect(readFileSync(dest).toString()).toBe('....mp4 bytes....');
    expect(bytes).toBe('....mp4 bytes....'.length);
  });

  it('enables wired control and sets the clock in the camera\'s format', async () => {
    await b.camera.enableWiredControl();
    await b.camera.setClock(new Date(2026, 6, 30, 9, 5, 3));
    expect(b.paths).toEqual([
      '/gopro/camera/control/wired_usb?p=1',
      '/gopro/camera/set_date_time?date=2026_7_30&time=9_5_3',
    ]);
  });

  it('surfaces the status code, because a 503 while encoding means "wait"', async () => {
    // The driver retries the media list through the encode. It can only do
    // that if the code reaches it instead of becoming a generic failure.
    b.fail(503);
    await expect(b.camera.mediaList()).rejects.toThrow('503');
  });

  it('gives up on a camera that has stopped answering', async () => {
    b.server.close();
    await expect(b.camera.state()).rejects.toThrow();
  });
});
