import {
  Environment,
  FlightModel,
  FlightResult,
  LaunchConditions,
} from '@golf/types';

import { airDensityKgM3 } from './air';
import type { AeroCoefficients } from './coefficients';
import { integrateFlight } from './integrator';
import { degToRad, radToDeg, vec3 } from './math';
import { rolloutM } from './rollout';
import type { RolloutParams } from './rollout';
import { initialSpinRadS, spinAtTime, RPM_TO_RAD_PER_S } from './spin';

/** Calibration-only knobs; production callers never pass them. */
export interface SimulationOverrides {
  aero?: AeroCoefficients;
  spinDecayTauS?: number;
  rollout?: RolloutParams;
  timeStepS?: number;
}

/**
 * The one flight engine every view builds on (BUILD_SPEC §10.1). Pure and
 * deterministic; every output is COMPUTED (never confuse with sensor data).
 * `overrides` exists for the aero-calibration harness only — it replays truth
 * datasets against candidate coefficients without touching the fitted defaults.
 */
export const simulate = (
  launch: LaunchConditions,
  env: Environment,
  overrides?: SimulationOverrides,
): FlightResult => {
  const vlaRad = degToRad(launch.launchAngleDeg);
  const hlaRad = degToRad(launch.launchDirectionDeg);
  const v0 = launch.ballSpeedMs;

  const spin0 = initialSpinRadS(launch);
  const integration = integrateFlight({
    initialVelocityMs: vec3(
      v0 * Math.cos(vlaRad) * Math.cos(hlaRad),
      v0 * Math.sin(vlaRad),
      v0 * Math.cos(vlaRad) * Math.sin(hlaRad),
    ),
    initialSpinRadS: spin0,
    airDensityKgM3: airDensityKgM3(env.altitudeM, env.temperatureC),
    aero: overrides?.aero,
    spinDecayTauS: overrides?.spinDecayTauS,
    timeStepS: overrides?.timeStepS,
  });

  const { landing } = integration;
  const horizontalSpeed = Math.hypot(
    landing.velocityMs.x,
    landing.velocityMs.z,
  );
  const descentDeg = radToDeg(
    Math.atan2(-landing.velocityMs.y, horizontalSpeed),
  );
  const spinAtLanding = spinAtTime(spin0, landing.tS, overrides?.spinDecayTauS);
  const landingSpinRpm =
    Math.hypot(spinAtLanding.x, spinAtLanding.y, spinAtLanding.z) /
    RPM_TO_RAD_PER_S;

  // carry = horizontal distance the ball actually flew (along its own line —
  // what golfers and launch monitors mean by carry), NOT the target-line
  // projection. offlineM/landing keep the target-line frame for the views.
  const carry = Math.hypot(landing.x, landing.z);
  const rollout = rolloutM(
    horizontalSpeed,
    descentDeg,
    landingSpinRpm,
    carry,
    overrides?.rollout,
  );

  return {
    path: integration.path,
    carryM: carry,
    totalM: carry + rollout,
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
