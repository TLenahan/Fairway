import {
  Environment,
  FlightModel,
  FlightResult,
  LaunchConditions,
} from '@golf/types';

import { airDensityKgM3 } from './air';
import { integrateFlight } from './integrator';
import { degToRad, radToDeg, vec3 } from './math';
import { rolloutM } from './rollout';
import { initialSpinRadS } from './spin';

/**
 * The one flight engine every view builds on (BUILD_SPEC §10.1). Pure and
 * deterministic; every output is COMPUTED (never confuse with sensor data).
 */
export const simulate = (
  launch: LaunchConditions,
  env: Environment,
): FlightResult => {
  const vlaRad = degToRad(launch.launchAngleDeg);
  const hlaRad = degToRad(launch.launchDirectionDeg);
  const v0 = launch.ballSpeedMs;

  const integration = integrateFlight({
    initialVelocityMs: vec3(
      v0 * Math.cos(vlaRad) * Math.cos(hlaRad),
      v0 * Math.sin(vlaRad),
      v0 * Math.cos(vlaRad) * Math.sin(hlaRad),
    ),
    initialSpinRadS: initialSpinRadS(launch),
    airDensityKgM3: airDensityKgM3(env.altitudeM, env.temperatureC),
  });

  const { landing } = integration;
  const horizontalSpeed = Math.hypot(
    landing.velocityMs.x,
    landing.velocityMs.z,
  );
  const descentDeg = radToDeg(
    Math.atan2(-landing.velocityMs.y, horizontalSpeed),
  );
  const rollout = rolloutM(horizontalSpeed, descentDeg);

  return {
    path: integration.path,
    carryM: landing.x,
    totalM: landing.x + rollout,
    apexM: integration.apexM,
    descentDeg,
    flightTimeS: landing.tS,
    offlineM: landing.z,
    landing: { x: landing.x, z: landing.z },
    rolloutM: rollout,
    computed: true,
  };
};

export const flightModel: FlightModel = { simulate };

export const createFlightModel = (): FlightModel => flightModel;
