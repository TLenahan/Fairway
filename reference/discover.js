'use strict';
// Listen for the EYE MINI's UDP broadcast beacon (port 43265) and report the
// device the moment it announces itself. No handshake, no pairing — the Mini
// broadcasts its own IP, serial, and hashKey in plaintext ~1x/sec.
//
//   node discover.js
//
// Emits each unique device once. Ctrl-C to stop.

const dgram = require('dgram');

const BEACON_PORT = 43265;
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const seen = new Set();

sock.on('message', (msg, rinfo) => {
  let json;
  try { json = JSON.parse(msg.toString('utf8')); } catch { return; }
  const d = json.device;
  if (!d) return;
  const key = d.serialNumber || rinfo.address;
  if (seen.has(key)) return;
  seen.add(key);
  console.log('Found Uneekor device:');
  console.log('  model   :', d.modelName);
  console.log('  serial  :', d.serialNumber);
  console.log('  sw / hw :', d.swVersion, '/', d.hwVersion);
  console.log('  ip      :', d.networkInfo && d.networkInfo.ipaddr, '(from', rinfo.address + ')');
  console.log('  mac     :', d.networkInfo && d.networkInfo.mac);
  console.log('  hashKey :', d.hashKey);           // needed for the auth handshake
  console.log('  → control channel: tcp://' + (d.networkInfo && d.networkInfo.ipaddr) + ':43266');
  console.log('  → impact images  : http://' + (d.networkInfo && d.networkInfo.ipaddr) + '/SCAMIMG/CURRENT/');
  console.log('');
});

sock.on('error', (e) => { console.error('socket error:', e.message); sock.close(); });
sock.bind(BEACON_PORT, () => {
  sock.setBroadcast(true);
  console.log(`Listening for EYE MINI beacon on UDP :${BEACON_PORT} …`);
});
