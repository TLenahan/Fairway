import { MeasuredShot, ShotDataEX1, ShotDataEX1Schema } from '@golf/types';

/**
 * Decode a raw `param.shotdataEX1` payload into a MeasuredShot (BUILD_SPEC
 * A.7, port of reference/protocol.js decodeShot).
 *
 * - Integers arrive ×1000 in SI base units (m/s, deg, rpm); face impact is ×1
 *   (mm-ish) per the verified reference implementation.
 * - THE null rule: any club metric whose companion assurance_* is 0 was not
 *   measured and decodes to null — never 0. A decoder returning 0.0 for the
 *   fixture's face angle is wrong.
 * - smashFactor derives from the raw integer ratio (ball/club speed), only
 *   when club speed was measured.
 */
export function decodeShot(raw: unknown): MeasuredShot {
  const shot: ShotDataEX1 = ShotDataEX1Schema.parse(raw);

  const gated = (
    value: number,
    assurance: number,
    scale = 1000,
  ): number | null => (assurance === 0 ? null : value / scale);

  const shotImgPath = extractShotImgPath(shot);

  return {
    shotGuid: [
      shot.shotguid.Data1,
      shot.shotguid.Data2,
      shot.shotguid.Data3,
    ].join('-'),
    handedness: shot.rightlefthanded === 0 ? 'right' : 'left',
    impactTimestamp: shot.impactTimestamp,
    ball: {
      speedMs: shot.ballspeedx1000 / 1000,
      launchAngleDeg: shot.inclineX1000 / 1000,
      launchDirectionDeg: shot.azimuthX1000 / 1000,
      backspinRpm: shot.backspinX1000 / 1000,
      sidespinRpm: shot.sidespinX1000 / 1000,
      rollspinRpm: shot.rollspinX1000 / 1000,
      spinAssurance: shot.assurance_spin,
    },
    club: {
      speedMs: gated(shot.clubspeedX1000, shot.assurance_clubspeed),
      pathDeg: gated(shot.clubpathX1000, shot.assurance_clubpath),
      faceAngleDeg: gated(shot.faceangleX1000, shot.assurance_faceangle),
      attackAngleDeg: gated(shot.attackangleX1000, shot.assurance_attackangle),
      loftDeg: gated(shot.loftangleX1000, shot.assurance_loftangle),
      lieDeg: gated(shot.lieangleX1000, shot.assurance_lieangle),
      faceImpactHMm: gated(
        shot.faceimpactLateralX1000,
        shot.assurance_faceimpactLateral,
        1,
      ),
      faceImpactVMm: gated(
        shot.faceimpactVerticalX1000,
        shot.assurance_faceimpactVertical,
        1,
      ),
    },
    assurance: {
      spin: shot.assurance_spin,
      clubSpeed: shot.assurance_clubspeed,
      clubPath: shot.assurance_clubpath,
      faceAngle: shot.assurance_faceangle,
      attackAngle: shot.assurance_attackangle,
      loftAngle: shot.assurance_loftangle,
      lieAngle: shot.assurance_lieangle,
      faceImpactLateral: shot.assurance_faceimpactLateral,
      faceImpactVertical: shot.assurance_faceimpactVertical,
    },
    smashFactor:
      shot.assurance_clubspeed !== 0 && shot.clubspeedX1000 !== 0
        ? shot.ballspeedx1000 / shot.clubspeedX1000
        : null,
    shotImgPath,
  };
}

/**
 * A.7 doesn't document an image-path field, but the schema passes unknown
 * fields through — surface one when present so shot detail can attach the
 * impact image without a schema change.
 */
function extractShotImgPath(shot: ShotDataEX1): string | null {
  const candidate = (shot as Record<string, unknown>)['shotimgpath'];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}
