#!/usr/bin/env node
// GoPro Hindsight bench harness — proves/kills the live per-shot clip flow
// before a second body is bought. Runs the 5 checks from
// handoff/GOPRO_CAPTURE.md over Open GoPro HTTP (wired USB preferred).
//
//   node tools/gopro-bench.mjs <cmd> --ip 172.2X.1YZ.51 [--out DIR]
//
// Commands:
//   status   camera state dump (is hindsight active? encoding? battery?)
//   setup    enable wired control, set clock, arm Hindsight 15s, verify armed
//   clip     one trigger cycle: shutter on → 3.5s → off → wait for file →
//            download → report timings (bench items 1/2/4). Clap BEFORE
//            triggering to verify pre-roll audio in the clip.
//   cycle    bench item 3: 10× trigger→stop→wait-12s→trigger; per-cycle report
//   soak     bench item 5: keep Hindsight armed 30 min, log battery/temp/
//            self-disarm each minute (no shots)
//
// The camera IP derives from the serial: last 3 digits ABC → 172.2A.1BC.51.
// Camera must be on firmware >= v01.30.00 with the video preset (1080p120,
// then 240) chosen on-camera BEFORE `setup` — settings can't change while
// Hindsight is armed, and preset ids vary by model, so pick it by hand.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const IP = flag('ip');
const OUT = flag('out', './gopro-bench-out');
const BASE = `http://${IP}:8080`;

if (!cmd || !IP) {
  console.log('usage: node tools/gopro-bench.mjs <status|setup|clip|cycle|soak> --ip <camera-ip> [--out dir]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function get(path, timeoutMs = 5000) {
  const t0 = now();
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const ms = now() - t0;
  if (!res.ok) throw new Error(`${path} -> ${res.status} (${ms}ms)`);
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { body, ms, status: res.status };
}

async function getRetry(path, tries = 10, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await get(path);
    } catch (err) {
      lastErr = err; // 503 while encoding / intermittent 404 are expected
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

const state = async () => (await get('/gopro/camera/state')).body;
const hindsightActive = async () => (await state()).status?.['106'] === 1;
const encoding = async () => (await state()).status?.['8'] === 1;
const battery = async () => (await state()).status?.['70'];

let keepAliveTimer = null;
const startKeepAlive = () => {
  keepAliveTimer = setInterval(() => {
    get('/gopro/camera/keep_alive').catch(() => {});
  }, 60_000);
};

async function mediaList() {
  const { body } = await getRetry('/gopro/media/list');
  const files = [];
  for (const dir of body.media ?? []) {
    for (const f of dir.fs ?? []) files.push(`${dir.d}/${f.n}`);
  }
  return files;
}

async function setup() {
  console.log('enabling wired usb control…');
  await get('/gopro/camera/control/wired_usb?p=1').catch((e) =>
    console.log(`  (${e.message} — often already enabled, continuing)`),
  );
  const d = new Date();
  await get(
    `/gopro/camera/set_date_time?date=${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}` +
      `&time=${d.getHours()}_${d.getMinutes()}_${d.getSeconds()}`,
  );
  console.log('clock set. arming Hindsight 15s (setting 167 = 2)…');
  await get('/gopro/camera/setting?setting=167&option=2');
  for (let i = 0; i < 20; i += 1) {
    if (await hindsightActive()) {
      console.log(`ARMED ✓ (battery ${await battery()}%)`);
      return;
    }
    await sleep(500);
  }
  throw new Error('Hindsight never reported active (status 106) — check the preset supports it');
}

async function oneClip(label) {
  const before = new Set(await mediaList());
  const armedBefore = await hindsightActive();
  const tTrigger = now();
  await get('/gopro/camera/shutter/start');
  const triggerMs = now() - tTrigger;
  await sleep(3500);
  const tStop = now();
  await get('/gopro/camera/shutter/stop');

  let file = null;
  const tPoll = now();
  while (now() - tPoll < 30_000) {
    const files = await mediaList().catch(() => []);
    file = files.find((f) => !before.has(f)) ?? null;
    if (file) break;
    await sleep(1000);
  }
  if (!file) return { label, ok: false, reason: 'file never appeared in 30s' };
  const visibleMs = now() - tStop;

  const tDl = now();
  const { body } = await get(`/videos/DCIM/${file}`, 120_000);
  const bytes = body.byteLength;
  const dlMs = now() - tDl;
  mkdirSync(OUT, { recursive: true });
  const local = join(OUT, `${label}-${file.replaceAll('/', '_')}`);
  writeFileSync(local, Buffer.from(body));

  let rearmed = false;
  for (let i = 0; i < 20; i += 1) {
    if (await hindsightActive()) { rearmed = true; break; }
    await sleep(500);
  }
  return {
    label, ok: true, file: local, armedBefore, triggerMs,
    fileVisibleMs: visibleMs, downloadMs: dlMs, mb: Math.round(bytes / 1e5) / 10,
    rearmed,
  };
}

async function main() {
  startKeepAlive();
  if (cmd === 'status') {
    const s = await state();
    console.log(`hindsight active: ${s.status?.['106']}, encoding: ${s.status?.['8']}, battery: ${s.status?.['70']}%`);
    console.log(JSON.stringify(s.settings ?? {}, null, 0).slice(0, 400));
  } else if (cmd === 'setup') {
    await setup();
  } else if (cmd === 'clip') {
    console.log('CLAP once, then triggering in 6s — the clap must be in the pre-roll…');
    await sleep(6000);
    console.log(JSON.stringify(await oneClip('clip'), null, 2));
    console.log('verify: ffprobe the file — fps as configured, audio present, clap audible ~6s before the end minus 3.5s.');
  } else if (cmd === 'cycle') {
    const results = [];
    for (let i = 1; i <= 10; i += 1) {
      console.log(`cycle ${i}/10…`);
      const r = await oneClip(`cycle${i}`);
      results.push(r);
      console.log(JSON.stringify(r));
      if (!r.rearmed) console.log('  ⚠ did not re-arm — flow broken at this cadence');
      await sleep(12_000);
    }
    const ok = results.filter((r) => r.ok && r.rearmed).length;
    console.log(`\n${ok}/10 clean cycles`);
  } else if (cmd === 'soak') {
    await setup();
    for (let min = 1; min <= 30; min += 1) {
      await sleep(60_000);
      const armed = await hindsightActive().catch(() => 'unreachable');
      console.log(`[${min}m] armed=${armed} battery=${await battery().catch(() => '?')}% encoding=${await encoding().catch(() => '?')}`);
      if (armed !== true) console.log('  ⚠ self-disarmed or unreachable — thermal/idle event');
    }
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
  clearInterval(keepAliveTimer);
}

main().catch((err) => {
  clearInterval(keepAliveTimer);
  console.error(err.message);
  process.exit(1);
});
