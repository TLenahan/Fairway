import {
  anatomicalAnglesDeg,
  calibrateFlatRaise,
  CalibrationPose,
  flatRaiseIssues,
  markleyAverage,
  qCanonical,
  qConj,
  qMul,
  Quat,
  RAD_TO_DEG,
  relativeQuat,
  rotationAngle,
} from '@golf/wrist';
import { WristCalibration, WristSample } from '@golf/types';
import { Button, Card, SectionTitle, tw } from '@golf/ui';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { useFairwayStore, useServices, useSettings } from '@/services/context';

/**
 * Anatomical calibration, mirroring the vendor's own flow: (1) hold the lead
 * arm straight out in front, forearm parallel to the ground, wrist flat —
 * confirm with a button; (2) slowly raise the forearm 30–45° with the elbow
 * still. The raise auto-captures. See @golf/wrist calibrateFlatRaise for the
 * math; the result persists in settings and applies to the live stream.
 */

const FLAT_SAMPLES = 100; // ~1 s of stillness for the zero reference
const RAISE_TARGET_DEG = 34; // auto-complete once the forearm lifted this far
const UI_THROTTLE_MS = 100; // sample events arrive ~100 Hz; render at ~10 Hz

type Stage = 'position' | 'flat' | 'raise' | 'done' | 'failed';

const pctOf = (fraction: number): `${number}%` =>
  `${Math.max(0, Math.min(100, fraction * 100))}%`;

export default function CalibrateScreen() {
  const router = useRouter();
  const { wrist } = useServices();
  const wristConnection = useFairwayStore((s) => s.wristConnection);
  const updateSettings = useSettings((s) => s.update);

  const [stage, setStage] = useState<Stage>('position');
  const [liftDeg, setLiftDeg] = useState(0);
  const [flatProgress, setFlatProgress] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const [liveAngles, setLiveAngles] = useState<[number, number, number] | null>(
    null,
  );

  // per-sample work happens in refs — 100 Hz must not re-render 100×/s
  const stageRef = useRef<Stage>('position');
  const neutralRef = useRef<CalibrationPose[]>([]);
  const raiseRef = useRef<CalibrationPose[]>([]);
  const qBFlatRef = useRef<Quat | null>(null);
  const calibrationRef = useRef<WristCalibration | null>(null);
  const lastUiRef = useRef(0);

  const enter = (next: Stage): void => {
    stageRef.current = next;
    setStage(next);
  };

  useEffect(() => {
    const onSample = (s: WristSample): void => {
      const now = Date.now();
      const uiDue = now - lastUiRef.current >= UI_THROTTLE_MS;
      const at = stageRef.current;

      if (at === 'flat') {
        neutralRef.current.push({ qA: s.qA, qB: s.qB });
        if (uiDue) {
          lastUiRef.current = now;
          setFlatProgress(neutralRef.current.length / FLAT_SAMPLES);
        }
        if (neutralRef.current.length >= FLAT_SAMPLES) {
          qBFlatRef.current = markleyAverage(
            neutralRef.current.map((p) => p.qB),
          );
          raiseRef.current = [];
          enter('raise');
        }
        return;
      }

      if (at === 'raise') {
        const flat = qBFlatRef.current;
        if (flat === null) return;
        raiseRef.current.push({ qA: s.qA, qB: s.qB });
        const lift = rotationAngle(qMul(qConj(flat), s.qB)) * RAD_TO_DEG;
        if (uiDue) {
          lastUiRef.current = now;
          setLiftDeg(lift);
        }
        if (lift >= RAISE_TARGET_DEG) {
          const { calibration, quality } = calibrateFlatRaise(
            neutralRef.current,
            raiseRef.current,
          );
          const problems = flatRaiseIssues(quality);
          if (problems.length > 0) {
            setIssues(problems);
            enter('failed');
            return;
          }
          calibrationRef.current = calibration;
          wrist.setCalibration(calibration);
          updateSettings({ wristCalibration: calibration });
          enter('done');
        }
        return;
      }

      if (at === 'done' && uiDue) {
        // live verification: cup the wrist → extension climbs positive
        const calibration = calibrationRef.current;
        if (calibration === null) return;
        lastUiRef.current = now;
        const qAnat = qCanonical(
          qMul(qConj(calibration.qRef), relativeQuat(s.qA, s.qB)),
        );
        setLiveAngles(anatomicalAnglesDeg(calibration.frame, qAnat));
      }
    };

    wrist.setEmitSamples(true);
    wrist.on('sample', onSample);
    return () => {
      wrist.off('sample', onSample);
      wrist.setEmitSamples(false);
    };
  }, [wrist, updateSettings]);

  const restart = (): void => {
    neutralRef.current = [];
    raiseRef.current = [];
    qBFlatRef.current = null;
    setFlatProgress(0);
    setLiftDeg(0);
    setIssues([]);
    enter('position');
  };

  const beginFlat = (): void => {
    neutralRef.current = [];
    setFlatProgress(0);
    enter('flat');
  };

  return (
    <ScrollView
      style={tw`flex-1 bg-ivory`}
      contentContainerStyle={tw`p-4 pb-8`}
    >
      <SectionTitle title="Calibrate wrist sensor" />

      {wristConnection !== 'connected' ? (
        <Card style={tw`border-warning`}>
          <Text style={tw`font-semibold text-ink`}>
            Connect the wrist sensor first
          </Text>
          <View style={tw`mt-2 self-start`}>
            <Button
              label="Go to connect"
              variant="secondary"
              compact
              onPress={() => router.push('/connect')}
            />
          </View>
        </Card>
      ) : (
        <>
          {stage === 'position' && (
            <Card>
              <Text style={tw`font-semibold text-ink`}>
                1 · Get in position
              </Text>
              <Text style={tw`mt-1 text-sm text-ink`}>
                Hold your lead arm straight out in front of you, forearm
                parallel to the ground. Make a fist with a flat top — your
                wrist flat and straight in line with the forearm.
              </Text>
              <View style={tw`mt-3`}>
                <Button label="It's in position" onPress={beginFlat} />
              </View>
            </Card>
          )}

          {stage === 'flat' && (
            <Card>
              <Text style={tw`font-semibold text-ink`}>
                Hold still — capturing the flat position…
              </Text>
              <View style={tw`mt-2 h-1.5 rounded-full bg-green-100`}>
                <View
                  style={[
                    tw`h-1.5 rounded-full bg-green-700`,
                    { width: pctOf(flatProgress) },
                  ]}
                />
              </View>
            </Card>
          )}

          {stage === 'raise' && (
            <Card>
              <Text style={tw`font-semibold text-ink`}>
                2 · Slowly raise your forearm
              </Text>
              <Text style={tw`mt-1 text-sm text-ink`}>
                Keep the elbow still and the wrist flat — lift about 30–45°
                without rotating or drifting sideways.
              </Text>
              <Text style={tw`mt-2 text-3xl font-bold text-green-700`}>
                {Math.round(liftDeg)}°
              </Text>
              <View style={tw`mt-1 h-1.5 rounded-full bg-green-100`}>
                <View
                  style={[
                    tw`h-1.5 rounded-full bg-green-700`,
                    { width: pctOf(liftDeg / RAISE_TARGET_DEG) },
                  ]}
                />
              </View>
            </Card>
          )}

          {stage === 'failed' && (
            <Card style={tw`border-danger`}>
              <Text style={tw`font-semibold text-danger`}>
                That capture didn't pass
              </Text>
              {issues.map((issue) => (
                <Text key={issue} style={tw`mt-1 text-sm text-ink`}>
                  • {issue}
                </Text>
              ))}
              <View style={tw`mt-3 self-start`}>
                <Button label="Try again" onPress={restart} />
              </View>
            </Card>
          )}

          {stage === 'done' && (
            <Card style={tw`border-green-700`}>
              <Text style={tw`font-semibold text-green-700`}>
                Calibrated ✓ — saved for future sessions
              </Text>
              <Text style={tw`mt-1 text-sm text-ink`}>
                Check it: cup your wrist (extension should go positive), then
                bow it (negative).
              </Text>
              {liveAngles && (
                <View style={tw`mt-2 flex-row gap-4`}>
                  <View>
                    <Text style={tw`text-xs uppercase text-silver`}>
                      Extension
                    </Text>
                    <Text style={tw`text-2xl font-bold text-ink`}>
                      {Math.round(liveAngles[0])}°
                    </Text>
                  </View>
                  <View>
                    <Text style={tw`text-xs uppercase text-silver`}>
                      Deviation
                    </Text>
                    <Text style={tw`text-2xl font-bold text-ink`}>
                      {Math.round(liveAngles[1])}°
                    </Text>
                  </View>
                  <View>
                    <Text style={tw`text-xs uppercase text-silver`}>
                      Rotation
                    </Text>
                    <Text style={tw`text-2xl font-bold text-ink`}>
                      {Math.round(liveAngles[2])}°
                    </Text>
                  </View>
                </View>
              )}
              <View style={tw`mt-3 flex-row gap-2`}>
                <Button label="Redo" variant="ghost" compact onPress={restart} />
                <Button
                  label="Done"
                  compact
                  onPress={() => router.back()}
                />
              </View>
            </Card>
          )}
        </>
      )}
    </ScrollView>
  );
}
