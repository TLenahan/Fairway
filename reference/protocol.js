'use strict';
// Uneekor EYE MINI protocol — reverse-engineered from packet capture.
// Wire format (verified on every frame):
//   [0x99 0x01][0x28 0x28][uint32 BE length][JSON body of `length` bytes]

const MAGIC = Buffer.from([0x99, 0x01]);
const SYNC = Buffer.from([0x28, 0x28]);
const HEADER_LEN = 8;

/**
 * Streaming frame parser. Feed it raw TCP chunks; it emits complete JSON
 * messages. Handles partial frames split across TCP segments.
 */
class FrameParser {
  constructor(onMessage) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      // resync to the 0x2828 marker if we're misaligned
      if (this.buf.length >= 4 && !this.buf.subarray(2, 4).equals(SYNC)) {
        const idx = this.buf.indexOf(SYNC, 1);
        if (idx < 2) { if (this.buf.length > 4096) this.buf = this.buf.subarray(this.buf.length - 2); return; }
        this.buf = this.buf.subarray(idx - 2);
      }
      if (this.buf.length < HEADER_LEN) return;
      const len = this.buf.readUInt32BE(4);
      if (this.buf.length < HEADER_LEN + len) return; // wait for more
      const body = this.buf.subarray(HEADER_LEN, HEADER_LEN + len);
      this.buf = this.buf.subarray(HEADER_LEN + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); }
      catch (e) { continue; } // skip malformed, stay synced
      this.onMessage(msg);
    }
  }
}

/** Build a client->server request frame. */
function encode(eventId, command, reqId, param = null) {
  const header = { hard_key: 82, event_id: eventId, command, req_id: reqId,
    length: param ? Buffer.byteLength(JSON.stringify(param)) : 0 };
  const json = Buffer.from(JSON.stringify({ header, param }), 'utf8');
  const out = Buffer.alloc(HEADER_LEN + json.length);
  MAGIC.copy(out, 0); SYNC.copy(out, 2);
  out.writeUInt32BE(json.length, 4);
  json.copy(out, HEADER_LEN);
  return out;
}

const MS2MPH = 2.2369362920544;

/**
 * Decode a shotdataEX1 object into real units. Any metric whose matching
 * assurance_* is 0 is returned as null (not measured), not a false zero.
 */
function decodeShot(shot) {
  const a = (name, key, scale = 1000, assurance) => {
    if (assurance !== undefined && shot[assurance] === 0) return null;
    return shot[key] / scale;
  };
  const guid = shot.shotguid || {};
  return {
    id: [guid.Data1, guid.Data2, guid.Data3].join('-'),
    handed: shot.rightlefthanded === 0 ? 'R' : 'L',
    impactTimestamp: shot.impactTimestamp,
    ball: {
      speed_ms: shot.ballspeedx1000 / 1000,
      speed_mph: (shot.ballspeedx1000 / 1000) * MS2MPH,
      launchAngle_deg: shot.inclineX1000 / 1000,       // VLA
      launchDirection_deg: shot.azimuthX1000 / 1000,   // HLA, - = left
      backspin_rpm: shot.backspinX1000 / 1000,
      sidespin_rpm: shot.sidespinX1000 / 1000,         // + = right
      rollspin_rpm: shot.rollspinX1000 / 1000,
      spinAssurance: shot.assurance_spin,
    },
    club: {
      speed_ms: a('cs', 'clubspeedX1000', 1000, 'assurance_clubspeed'),
      speed_mph: shot.assurance_clubspeed ? (shot.clubspeedX1000 / 1000) * MS2MPH : null,
      path_deg: a('cp', 'clubpathX1000', 1000, 'assurance_clubpath'),          // - = out-to-in
      faceAngle_deg: a('fa', 'faceangleX1000', 1000, 'assurance_faceangle'),
      attackAngle_deg: a('aa', 'attackangleX1000', 1000, 'assurance_attackangle'),
      loft_deg: a('lo', 'loftangleX1000', 1000, 'assurance_loftangle'),
      lie_deg: a('li', 'lieangleX1000', 1000, 'assurance_lieangle'),
      faceImpactH_mm: a('fh', 'faceimpactLateralX1000', 1, 'assurance_faceimpactLateral'),
      faceImpactV_mm: a('fv', 'faceimpactVerticalX1000', 1, 'assurance_faceimpactVertical'),
    },
    smashFactor: (shot.assurance_clubspeed && shot.clubspeedX1000)
      ? shot.ballspeedx1000 / shot.clubspeedX1000 : null,
  };
}

module.exports = { FrameParser, encode, decodeShot, MAGIC, SYNC, HEADER_LEN };
