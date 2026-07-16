#!/usr/bin/env node
/**
 * Generates the wedge-drill feedback WAVs into apps/fairway/assets/audio
 * (committed — rerun only when a sound changes):
 *
 *   node tools/generate-drill-audio.mjs
 *
 * Zero dependencies and fully deterministic: pure sine synthesis, 44.1 kHz
 * 16-bit mono, ~5 ms attack + exponential decay so nothing clicks, peak ≤ 0.6
 * so cues cut through range noise without startling. Pitches are real note
 * frequencies because the cues are meant to be hummable over the ball (Korda
 * "co-ca-co-la"), not abstract beeps.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const ATTACK_S = 0.005;

// equal-temperament note frequencies (Hz)
const G4 = 392.0;
const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880.0;
const E6 = 1318.51;

/** 5 ms linear attack, then exponential decay to ~−43 dB at the end. */
const envelope = (tS, durS, peak) =>
  peak * Math.min(tS / ATTACK_S, 1) * Math.exp((-5 * tS) / durS);

/** Sine via phase accumulation — clickless even while the frequency moves. */
function tone(durS, peak, freqAt) {
  const n = Math.round(durS * SAMPLE_RATE);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const tS = i / SAMPLE_RATE;
    phase += (2 * Math.PI * freqAt(tS)) / SAMPLE_RATE;
    out[i] = Math.sin(phase) * envelope(tS, durS, peak);
  }
  return out;
}

const note = (durS, peak, freqHz) => tone(durS, peak, () => freqHz);

/** Exponential glide f0→f1 (linear in pitch, so the slide sounds even). */
const slide = (durS, peak, f0, f1) =>
  tone(durS, peak, (tS) => f0 * (f1 / f0) ** (tS / durS));

function concat(...parts) {
  const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** RIFF/WAVE, 16-bit PCM mono @ 44.1 kHz. */
function wavBytes(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const SOUNDS = {
  // one backswing click of the swing song
  'tick.wav': note(0.06, 0.5, A5),
  // the impact "la" — slightly louder than the ticks it resolves
  'accent.wav': note(0.14, 0.6, E6),
  // success: rising C-major arpeggio
  'match.wav': concat(
    note(0.12, 0.55, C5),
    note(0.12, 0.55, E5),
    note(0.12, 0.55, G5),
  ),
  // backswing went long: pitch slides up past the target
  'over.wav': slide(0.35, 0.55, G4, D5),
  // came up short: the same interval falling
  'under.wav': slide(0.35, 0.55, D5, G4),
  // rep recorded while the rung is still calibrating — soft, neutral
  'blip.wav': note(0.08, 0.35, C5),
};

const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps/fairway/assets/audio',
);
mkdirSync(outDir, { recursive: true });
for (const [name, samples] of Object.entries(SOUNDS)) {
  writeFileSync(join(outDir, name), wavBytes(samples));
  console.log(`wrote ${name} (${(samples.length / SAMPLE_RATE).toFixed(3)} s)`);
}
