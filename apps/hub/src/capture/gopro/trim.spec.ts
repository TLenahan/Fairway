import { parseProbe, probeArgs, trimArgs } from './trim';

describe('trimArgs', () => {
  it('seeks from the end, because the end is the instant the hub knows', () => {
    const args = trimArgs('/in.mp4', '/out.mp4', 8_500);
    expect(args.join(' ')).toContain('-sseof -8.500');
    // stream copy: a re-encode of 1080p120 per shot would not keep up, and
    // nothing here needs the pixels changed
    expect(args.join(' ')).toContain('-c copy');
  });

  it('keeps the audio track, optionally', () => {
    const args = trimArgs('/in.mp4', '/out.mp4', 1_000).join(' ');
    // the impact-audio pass is what later upgrades a clip's sync to 'fine',
    // so dropping audio here would quietly cap every clip at 'coarse'
    expect(args).toContain('-map 0:v:0 -map 0:a:0?');
  });

  it('puts the moov atom first so the UI can scrub without the tail', () => {
    expect(trimArgs('/in.mp4', '/out.mp4', 1_000).join(' ')).toContain(
      '-movflags +faststart',
    );
  });

  it('is exact to the millisecond', () => {
    expect(trimArgs('/in.mp4', '/out.mp4', 8_437).join(' ')).toContain('-8.437');
    expect(trimArgs('/in.mp4', '/out.mp4', 500).join(' ')).toContain('-0.500');
  });
});

describe('parseProbe', () => {
  const probe = (
    duration: string,
    rate = '120/1',
  ): string =>
    JSON.stringify({
      streams: [{ width: 1920, height: 1080, r_frame_rate: rate }],
      format: { duration },
    });

  it('reads the four numbers a clip row needs', () => {
    expect(parseProbe(probe('9.041667'))).toEqual({
      durationMs: 9_041.667,
      fps: 120,
      width: 1920,
      height: 1080,
    });
  });

  it('turns a frame-rate ratio into a frame rate', () => {
    expect(parseProbe(probe('9.0', '120000/1001')).fps).toBe(119.88);
    expect(parseProbe(probe('9.0', '240/1')).fps).toBe(240);
  });

  it('refuses a probe that came back vague', () => {
    // the ingest endpoint rejects a non-positive duration, fps or frame size,
    // so a bad probe has to fail here where the cause is still visible
    expect(() => parseProbe(probe(''))).toThrow('duration');
    expect(() => parseProbe(probe('0'))).toThrow('duration');
    expect(() => parseProbe(probe('9.0', '0/0'))).toThrow('fps');
    expect(() =>
      parseProbe(
        '{"streams":[{"r_frame_rate":"120/1"}],"format":{"duration":"9"}}',
      ),
    ).toThrow('width');
    expect(() => parseProbe('{"streams":[],"format":{"duration":"9"}}')).toThrow(
      'no video stream',
    );
    expect(() => parseProbe('not json at all')).toThrow('no JSON');
  });
});

describe('probeArgs', () => {
  it('asks for exactly the video stream and the container duration', () => {
    const args = probeArgs('/clip.mp4').join(' ');
    expect(args).toContain('-select_streams v:0');
    expect(args).toContain('stream=width,height,r_frame_rate');
    expect(args).toContain('format=duration');
    expect(args).toContain('-of json');
  });
});
