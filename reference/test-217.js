#!/usr/bin/env node
'use strict';
/*
 * test-217.js — Does the EYE MINI stream shots WITHOUT the encrypted 217 handshake?
 *
 * Replays the exact init sequence Uneekor's View app sends on connect, with the
 * single command:217 (encrypted auth) step REMOVED. Then it polls for the ball
 * and listens for shots on both server ports, exactly like the real app.
 *
 * Usage:
 *     node test-217.js                # auto-discover the Mini via its UDP beacon
 *     node test-217.js 192.168.1.10   # or point it straight at the Mini's IP
 *
 * Verdict after you hit a few balls (or Ctrl-C):
 *   - a SHOT prints            -> 217 is NOT required. You can build the client today.
 *   - acks + ball detected, no shot -> auth likely gates shots; go extract the key.
 *   - nothing comes back       -> connect/init problem; tell me what it printed.
 */

const net = require('net');
const dgram = require('dgram');

const CONTROL_PORT = 43266; // client sends commands, Mini acks
const EVENT_PORT   = 43267; // Mini pushes state + shots (event_id 192)
const BEACON_PORT  = 43265;
const MAGIC = Buffer.from([0x99, 0x01]);
const SYNC  = Buffer.from([0x28, 0x28]);
const MS2MPH = 2.2369362920544;

// ---- framing ---------------------------------------------------------------
function encode(eventId, command, reqId, param = null) {
  const header = { hard_key: 82, event_id: eventId, command, req_id: reqId,
    length: param ? Buffer.byteLength(JSON.stringify(param)) : 0 };
  const json = Buffer.from(JSON.stringify({ header, param }), 'utf8');
  const out = Buffer.alloc(8 + json.length);
  MAGIC.copy(out, 0); SYNC.copy(out, 2); out.writeUInt32BE(json.length, 4);
  json.copy(out, 8);
  return out;
}
function makeParser(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length >= 4 && !buf.subarray(2, 4).equals(SYNC)) {
        const idx = buf.indexOf(SYNC, 1);
        if (idx < 2) { if (buf.length > 8192) buf = buf.subarray(buf.length - 2); return; }
        buf = buf.subarray(idx - 2);
      }
      if (buf.length < 8) return;
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) return;
      const body = buf.subarray(8, 8 + len);
      buf = buf.subarray(8 + len);
      try { onMsg(JSON.parse(body.toString('utf8'))); } catch {}
    }
  };
}

// ---- state -----------------------------------------------------------------
const state = { acks: 0, ballDetected: false, shot: null, sawState: false, errors: [] };

function handleMsg(port, m) {
  const h = m.header || {};
  const p = m.param || {};
  // ack to one of our commands (Mini->client uses `answer`/`ack_id`/`status`)
  if (h.answer !== undefined) {
    state.acks++;
    if (h.status && h.status !== 0) state.errors.push(`cmd ${h.command} -> status ${h.status}`);
  }
  // ball position poll result
  const bp = p.teeBallPos || p.ironBallPos;
  if (bp && bp.ballexist === 1 && !state.ballDetected) {
    state.ballDetected = true;
    console.log(`  [:${port}] ● ball detected in hitting zone`);
  }
  // device state push
  if (h.event_id === 192 && h.command === 4 && !state.sawState) {
    state.sawState = true;
    const sd = p.statedata || {};
    console.log(`  [:${port}] device state: club=${sd.clubtype} handed=${sd.rightleft} alt=${sd.altitude}m`);
  }
  // THE SHOT
  if (h.event_id === 192 && h.command === 1 && p.shotdataEX1) {
    state.shot = decodeShot(p.shotdataEX1);
    console.log(`\n  [:${port}] ★★★ SHOT RECEIVED — no 217 handshake was sent ★★★`);
    console.log(fmtShot(state.shot));
  }
}

function decodeShot(s) {
  const g = s.shotguid || {};
  const meas = (key, aKey) => (s[aKey] === 0 ? null : s[key] / 1000);
  return {
    id: [g.Data1, g.Data2, g.Data3].join('-'),
    ballSpeed_mph: (s.ballspeedx1000 / 1000) * MS2MPH,
    launch_deg: s.inclineX1000 / 1000,
    direction_deg: s.azimuthX1000 / 1000,
    backspin_rpm: s.backspinX1000 / 1000,
    sidespin_rpm: s.sidespinX1000 / 1000,
    clubSpeed_mph: s.assurance_clubspeed ? (s.clubspeedX1000 / 1000) * MS2MPH : null,
    clubPath_deg: meas('clubpathX1000', 'assurance_clubpath'),
    attackAngle_deg: meas('attackangleX1000', 'assurance_attackangle'),
    faceAngle_deg: meas('faceangleX1000', 'assurance_faceangle'),
    smash: s.assurance_clubspeed ? s.ballspeedx1000 / s.clubspeedX1000 : null,
  };
}
function fmtShot(x) {
  const r = (v, d = 1) => (v === null ? 'n/a' : v.toFixed(d));
  return [
    `      ball speed : ${r(x.ballSpeed_mph)} mph`,
    `      launch     : ${r(x.launch_deg)}°   direction ${r(x.direction_deg)}°`,
    `      spin       : ${r(x.backspin_rpm, 0)} back / ${r(x.sidespin_rpm, 0)} side rpm`,
    `      club speed : ${r(x.clubSpeed_mph)} mph   smash ${r(x.smash, 3)}`,
    `      club path  : ${r(x.clubPath_deg)}°   AoA ${r(x.attackAngle_deg)}°   face ${r(x.faceAngle_deg)}°`,
  ].join('\n');
}

// ---- the init sequence, VERBATIM from the capture, minus command 217 --------
function runControlChannel(ip) {
  const sock = net.connect(CONTROL_PORT, ip, () => {
    console.log(`Connected to control :${CONTROL_PORT}. Sending init (217 OMITTED)…`);
    sock.write(encode(178, 0,   0, { sensorcode: 178, sensornum: 0, p0: 0, p1: 0, p2: 0, p3: 0 }));
    sock.write(encode(176, 48,  2, null));
    // <-- command 217 handshake would go here (req_id 3). Deliberately skipped.
    sock.write(encode(176, 33,  4, { club: 20 }));
    sock.write(encode(176, 36,  7, { rightLeft: 0 }));
    sock.write(encode(176, 37,  8, { unitDistance: 16, unitSpeed: 32 }));

    // then poll for the ball exactly like the app: 51,51,51,203,repeat
    let req = 9, tick = 0;
    const poll = setInterval(() => {
      if (sock.destroyed) return clearInterval(poll);
      const cmd = (tick % 4 === 3) ? 203 : 51;
      sock.write(encode(176, cmd, req++, null));
      tick++;
    }, 300);
    sock.on('close', () => clearInterval(poll));
  });
  sock.on('data', makeParser((m) => handleMsg(CONTROL_PORT, m)));
  sock.on('error', (e) => console.log(`  control :${CONTROL_PORT} error: ${e.message}`));
  return sock;
}

function runEventChannel(ip) {
  const sock = net.connect(EVENT_PORT, ip, () => {
    console.log(`Connected to event :${EVENT_PORT}. Listening for shots…`);
  });
  sock.on('data', makeParser((m) => handleMsg(EVENT_PORT, m)));
  sock.on('error', (e) => console.log(`  event :${EVENT_PORT} error: ${e.message} (may be normal if shots come on :${CONTROL_PORT})`));
  return sock;
}

function start(ip) {
  console.log(`\nTarget Mini: ${ip}`);
  console.log('Hit 3–4 balls once you see "Listening for shots…". Ctrl-C for the verdict.\n');
  const a = runControlChannel(ip);
  const b = runEventChannel(ip);

  const verdict = () => {
    console.log('\n──────────── VERDICT ────────────');
    if (state.shot) {
      console.log('217 NOT required. Shots stream on an unauthenticated socket.');
      console.log('→ Build the client. Skip the crypto entirely.');
    } else if (state.acks > 0) {
      console.log(`Commands were accepted (${state.acks} acks${state.ballDetected ? ', ball detected' : ''}) but no shot arrived.`);
      console.log(state.ballDetected
        ? '→ Detection is live but shots may be auth-gated. If you did hit a ball, 217 is likely required for shot push — go pull the key from the Windows View app.'
        : '→ Socket works but no ball was detected. Re-run and make sure a ball is in the zone / you actually hit one.');
    } else {
      console.log('No responses at all. The init or connection failed.');
      console.log('→ Check the IP, that the Mini is on the LAN (not just its own AP), and paste me the output.');
    }
    if (state.errors.length) console.log('Error statuses seen:', state.errors.join('; '));
    console.log('─────────────────────────────────');
    a.destroy(); b.destroy();
    process.exit(0);
  };

  process.on('SIGINT', verdict);
  setTimeout(verdict, 120000); // auto-verdict after 2 min
}

// ---- entry: use CLI ip, else discover via beacon ---------------------------
const ipArg = process.argv[2];
if (ipArg) {
  start(ipArg);
} else {
  console.log(`No IP given — listening for the Mini's beacon on UDP :${BEACON_PORT}…`);
  const d = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const discoveryTimer = setTimeout(() => {
    console.log('No beacon in 15s. Pass the IP directly: node test-217.js <ip>');
    process.exit(1);
  }, 15000);
  d.on('message', (msg) => {
    let j; try { j = JSON.parse(msg.toString()); } catch { return; }
    const ip = j.device && j.device.networkInfo && j.device.networkInfo.ipaddr;
    if (ip) { clearTimeout(discoveryTimer); d.close(); start(ip); } // <-- cancel timeout on success
  });
  d.on('error', (e) => { clearTimeout(discoveryTimer); console.log('beacon listen error:', e.message); process.exit(1); });
  d.bind(BEACON_PORT, () => d.setBroadcast(true));
}
