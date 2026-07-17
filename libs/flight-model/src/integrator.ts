import type { FlightPathPoint } from '@golf/types';

import {
  DEFAULT_AERO,
  dragCoefficient,
  liftCoefficient,
  spinRatio,
} from './coefficients';
import type { AeroCoefficients } from './coefficients';
import {
  BALL_CROSS_SECTION_M2,
  BALL_MASS_KG,
  BALL_RADIUS_M,
  GRAVITY_MS2,
} from './constants';
import { addScaled, cross, magnitude, vec3 } from './math';
import type { Vec3 } from './math';
import { SPIN_DECAY_TAU_S, spinAtTime } from './spin';

/** Fixed RK4 step (FLIGHT_MODEL.md §6): 1 ms. */
export const TIME_STEP_S = 0.001;
/** Path decimation: record every 10th step → one FlightPathPoint per ~10 ms. */
const PATH_SAMPLE_EVERY_STEPS = 10;
/** Hard cap so the integrator always terminates; no real shot flies this long. */
const MAX_FLIGHT_TIME_S = 20;
/** Below this |ω × v| the Magnus direction is undefined; treat lift as zero. */
const MIN_MAGNUS_CROSS_MAGNITUDE = 1e-9;

export interface FlightIntegrationInput {
  initialVelocityMs: Vec3;
  initialSpinRadS: Vec3;
  airDensityKgM3: number;
  /** Calibration overrides; production callers omit them (fitted defaults). */
  aero?: AeroCoefficients;
  spinDecayTauS?: number;
  /** Calibration-search speedup only; accuracy vs 1 ms verified in the harness. */
  timeStepS?: number;
}

export interface LandingState {
  tS: number;
  x: number;
  z: number;
  velocityMs: Vec3;
}

export interface FlightIntegration {
  /** Decimated path: t = 0, every ~10 ms, and the interpolated ground crossing. */
  path: FlightPathPoint[];
  /** Max height seen at 1 ms resolution. */
  apexM: number;
  landing: LandingState;
}

/**
 * Classic fixed-step RK4 integration of the equations of motion
 * (FLIGHT_MODEL.md §3/§6):
 *
 *   dp/dt = v
 *   dv/dt = ( F_gravity + F_drag + F_magnus ) / m
 *     F_gravity = (0, −m·g, 0)
 *     F_drag    = −½·ρ·A·Cd(S)·V·v
 *     F_magnus  =  ½·ρ·A·Cl(S)·V²·(ω × v)/|ω × v|
 *
 * Forces are recomputed at every RK4 stage; spin decays analytically with stage
 * time (spinAtTime). Air density is held at the session altitude — a golf shot's
 * apex (< ~50 m) changes ρ by < 0.5%, far below the coefficient model's accuracy.
 *
 * Terminates at the first step where y ≤ 0 while descending (vy < 0, i.e. after
 * apex — the ball starts at y = 0), then linearly interpolates the exact ground
 * crossing for the landing time, position, and velocity.
 */
export const integrateFlight = (
  input: FlightIntegrationInput,
): FlightIntegration => {
  const { initialSpinRadS, airDensityKgM3 } = input;
  const aero = input.aero ?? DEFAULT_AERO;
  const tauS = input.spinDecayTauS ?? SPIN_DECAY_TAU_S;
  const forceScale =
    (0.5 * airDensityKgM3 * BALL_CROSS_SECTION_M2) / BALL_MASS_KG;

  const acceleration = (tS: number, velocity: Vec3): Vec3 => {
    const speed = magnitude(velocity);
    let accel = vec3(0, -GRAVITY_MS2, 0);
    if (speed === 0) return accel;

    const spin = spinAtTime(initialSpinRadS, tS, tauS);
    const s = spinRatio(BALL_RADIUS_M, magnitude(spin), speed);

    accel = addScaled(
      accel,
      velocity,
      -forceScale * dragCoefficient(s, aero) * speed,
    );

    const spinCrossV = cross(spin, velocity);
    const spinCrossVMag = magnitude(spinCrossV);
    if (spinCrossVMag > MIN_MAGNUS_CROSS_MAGNITUDE) {
      accel = addScaled(
        accel,
        spinCrossV,
        (forceScale * liftCoefficient(s, aero) * speed * speed) / spinCrossVMag,
      );
    }
    return accel;
  };

  const dt = input.timeStepS ?? TIME_STEP_S;
  const maxSteps = Math.round(MAX_FLIGHT_TIME_S / dt);
  let position = vec3(0, 0, 0);
  let velocity = input.initialVelocityMs;
  let apexM = 0;
  const path: FlightPathPoint[] = [{ t: 0, x: 0, y: 0, z: 0 }];

  for (let step = 1; step <= maxSteps; step += 1) {
    const t = (step - 1) * dt;

    const k1v = acceleration(t, velocity);
    const k1p = velocity;
    const k2v = acceleration(t + dt / 2, addScaled(velocity, k1v, dt / 2));
    const k2p = addScaled(velocity, k1v, dt / 2);
    const k3v = acceleration(t + dt / 2, addScaled(velocity, k2v, dt / 2));
    const k3p = addScaled(velocity, k2v, dt / 2);
    const k4v = acceleration(t + dt, addScaled(velocity, k3v, dt));
    const k4p = addScaled(velocity, k3v, dt);

    const previousPosition = position;
    const previousVelocity = velocity;
    let positionDelta = k1p;
    positionDelta = addScaled(positionDelta, k2p, 2);
    positionDelta = addScaled(positionDelta, k3p, 2);
    positionDelta = addScaled(positionDelta, k4p, 1);
    position = addScaled(position, positionDelta, dt / 6);
    let velocityDelta = k1v;
    velocityDelta = addScaled(velocityDelta, k2v, 2);
    velocityDelta = addScaled(velocityDelta, k3v, 2);
    velocityDelta = addScaled(velocityDelta, k4v, 1);
    velocity = addScaled(velocity, velocityDelta, dt / 6);

    const tNew = step * dt;
    const landed = position.y <= 0 && velocity.y < 0;
    if (landed) {
      // Linear interpolation of the exact ground crossing within this step.
      const fraction =
        previousPosition.y === position.y
          ? 1
          : previousPosition.y / (previousPosition.y - position.y);
      const landingT = (step - 1 + fraction) * dt;
      const landingX =
        previousPosition.x + (position.x - previousPosition.x) * fraction;
      const landingZ =
        previousPosition.z + (position.z - previousPosition.z) * fraction;
      const landingVelocity = addScaled(
        previousVelocity,
        vec3(
          velocity.x - previousVelocity.x,
          velocity.y - previousVelocity.y,
          velocity.z - previousVelocity.z,
        ),
        fraction,
      );
      // Drop any recorded point at/after the crossing time before appending it.
      while (path.length > 1 && path[path.length - 1].t >= landingT) path.pop();
      path.push({ t: landingT, x: landingX, y: 0, z: landingZ });
      return {
        path,
        apexM,
        landing: {
          tS: landingT,
          x: landingX,
          z: landingZ,
          velocityMs: landingVelocity,
        },
      };
    }

    if (position.y > apexM) apexM = position.y;
    if (step % PATH_SAMPLE_EVERY_STEPS === 0) {
      path.push({ t: tNew, x: position.x, y: position.y, z: position.z });
    }
  }

  // Safety cap reached (unphysical inputs): treat the current state as landing.
  const cappedT = maxSteps * dt;
  while (path.length > 1 && path[path.length - 1].t >= cappedT) path.pop();
  path.push({
    t: cappedT,
    x: position.x,
    y: Math.max(position.y, 0),
    z: position.z,
  });
  return {
    path,
    apexM,
    landing: {
      tS: cappedT,
      x: position.x,
      z: position.z,
      velocityMs: velocity,
    },
  };
};
