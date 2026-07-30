import { FairwayState } from '@golf/store';
import { Club, Environment, WristDevice } from '@golf/types';

import { HubSnapshot, ShotRowDto } from './shared/protocol';

const MAX_SHOT_ROWS = 50;

export interface SnapshotExtras {
  clubs: Club[];
  wristCandidates: WristDevice[];
  environment: Environment;
}

export function buildSnapshot(
  state: FairwayState,
  extras: SnapshotExtras,
): HubSnapshot {
  const clubName = new Map(extras.clubs.map((c) => [c.id, c.name]));
  const shots: ShotRowDto[] = state.sessionShots
    .slice(0, MAX_SHOT_ROWS)
    .map((shot) => ({
      id: shot.id,
      clubId: shot.clubId,
      clubName: clubName.get(shot.clubId) ?? 'Unknown',
      capturedAt: shot.capturedAt,
      discarded: shot.discarded,
      ballSpeedMs: shot.measured.ball.speedMs,
      clubSpeedMs: shot.measured.club.speedMs,
      smashFactor: shot.measured.smashFactor,
      carryM: shot.flight?.carryM ?? null,
      totalM: shot.flight?.totalM ?? null,
      offlineM: shot.flight?.offlineM ?? null,
      curveM: shot.flight?.curveM ?? null,
      apexM: shot.flight?.apexM ?? null,
      hasWrist: shot.wrist !== undefined,
    }));

  return {
    connection: state.connection,
    device: state.device,
    ballReady: state.ballReady,
    session: state.session,
    activeClubId: state.activeClub?.id ?? null,
    clubs: extras.clubs,
    shots,
    wristConnection: state.wristConnection,
    wristDevice: state.wristDevice,
    wristBatteryPercent: state.wristBatteryPercent,
    wristAlert: state.wristAlert,
    wristCandidates: extras.wristCandidates,
    environment: extras.environment,
  };
}
