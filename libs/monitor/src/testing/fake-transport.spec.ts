import { MeasuredShot } from '@golf/types';

import fixture from '../fixtures/sample-shot.json';
import { EyeMiniMonitor } from '../monitor-service';
import { connectFakeEyeMini, feedShot } from './fake-transport';

describe('fake-transport — replay harness convenience', () => {
  let monitor: EyeMiniMonitor | undefined;

  afterEach(() => {
    monitor?.disconnect();
    monitor = undefined;
  });

  it('beacon -> connect -> feedShot drives a real EyeMiniMonitor to a shot event', async () => {
    const connected = await connectFakeEyeMini('192.168.1.10');
    monitor = connected.monitor;
    expect(monitor.getState()).toBe('connected');

    const shots: MeasuredShot[] = [];
    monitor.on('shot', (s) => shots.push(s));
    feedShot(connected.event, fixture.raw_shotdataEX1);

    expect(shots).toHaveLength(1);
    expect(shots[0].ball.speedMs).toBeCloseTo(26.092);
  });
});
