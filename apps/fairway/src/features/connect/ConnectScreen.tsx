import {
  DiscoveredDevice,
  WristConnectionState,
  WristDevice,
} from '@golf/types';
import { Button, Card, SectionTitle, tw } from '@golf/ui';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { z } from 'zod';

import { ConnectionDot } from '@/components/ConnectionDot';
import { buildStamp } from '@/lib/build-info';
import { useFairwayStore, useServices, useSettings } from '@/services/context';
import { CaptureStatus } from '@/services/wrist-capture';

type WristConnection = z.infer<typeof WristConnectionState>;

// wrist states are a different enum from the monitor's ConnectionState, so
// they get their own dot palette instead of reusing ConnectionDot
const wristDotByState: Record<WristConnection, string> = {
  disconnected: 'bg-silver',
  scanning: 'bg-warning',
  connecting: 'bg-warning',
  connected: 'bg-green-500',
  error: 'bg-danger',
  unauthorized: 'bg-danger',
  poweredOff: 'bg-danger',
};

export default function ConnectScreen() {
  const router = useRouter();
  const { monitor, wrist, settings, wristCapture } = useServices();
  const connection = useFairwayStore((s) => s.connection);
  const connect = useFairwayStore((s) => s.connect);
  const wristConnection = useFairwayStore((s) => s.wristConnection);
  const wristBatteryPercent = useFairwayStore((s) => s.wristBatteryPercent);
  const startWristScan = useFairwayStore((s) => s.startWristScan);
  const stopWristScan = useFairwayStore((s) => s.stopWristScan);
  const connectWrist = useFairwayStore((s) => s.connectWrist);
  const disconnectWrist = useFairwayStore((s) => s.disconnectWrist);
  const savedIp = useSettings((s) => s.savedDeviceIp);

  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [manualIp, setManualIp] = useState(savedIp ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [wristDevices, setWristDevices] = useState<WristDevice[]>([]);
  const [wristError, setWristError] = useState<string | null>(null);
  const [wristBusy, setWristBusy] = useState(false);
  const [capture, setCapture] = useState<CaptureStatus>(wristCapture.status);
  const [lastCapture, setLastCapture] = useState<string | null>(null);

  useEffect(() => wristCapture.subscribe(setCapture), [wristCapture]);

  useEffect(() => {
    const onDevice = (device: DiscoveredDevice) =>
      setDevices((known) =>
        known.some((d) => d.serial === device.serial)
          ? known
          : [...known, device],
      );
    monitor.on('device', onDevice);
    monitor.startDiscovery();
    return () => {
      monitor.off('device', onDevice);
      monitor.stopDiscovery();
    };
  }, [monitor]);

  useEffect(() => {
    // re-emits for a known id carry fresh serial/battery — merge, don't dedupe
    const onWristDevice = (device: WristDevice) =>
      setWristDevices((known) =>
        known.some((d) => d.id === device.id)
          ? known.map((d) => (d.id === device.id ? device : d))
          : [...known, device],
      );
    wrist.on('device', onWristDevice);
    startWristScan();
    return () => {
      wrist.off('device', onWristDevice);
      stopWristScan();
    };
  }, [wrist, startWristScan, stopWristScan]);

  const connectTo = async (ip: string) => {
    setBusy(true);
    setError(null);
    try {
      await connect(ip);
      settings.getState().update({ savedDeviceIp: ip });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connectWristTo = async (deviceId: string) => {
    setWristBusy(true);
    setWristError(null);
    try {
      await connectWrist(deviceId);
    } catch (err) {
      setWristError(err instanceof Error ? err.message : String(err));
    } finally {
      setWristBusy(false);
    }
  };

  const toggleCapture = (): void => {
    setWristError(null);
    try {
      if (capture.recording) {
        const done = wristCapture.stop();
        setLastCapture(done.file);
      } else {
        wristCapture.start('session');
        setLastCapture(null);
      }
    } catch (err) {
      setWristError(err instanceof Error ? err.message : String(err));
    }
  };

  // expo-sharing, not RN's Share — Share.share({url}) is iOS-only and
  // silently drops the file on Android (found the hard way).
  const shareCapture = async (uri: string) => {
    try {
      await Sharing.shareAsync(uri, {
        mimeType: 'application/x-ndjson',
        dialogTitle: 'Share wrist capture',
      });
    } catch (err) {
      setWristError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <ScrollView
      style={tw`flex-1 bg-ivory`}
      contentContainerStyle={tw`p-4 pb-8`}
    >
      <ConnectionDot state={connection} />

      <Text style={tw`mt-1 text-xs text-silver`}>{buildStamp()}</Text>

      {connection === 'localNetworkDenied' && (
        <Card style={tw`mt-3 border-danger`}>
          <Text style={tw`font-semibold text-danger`}>
            Local Network access is required
          </Text>
          <Text style={tw`mt-1 text-sm text-ink`}>
            iOS blocked the connection. Open Settings → Privacy & Security →
            Local Network and enable Fairway, then try again.
          </Text>
        </Card>
      )}

      <SectionTitle title="Discovered devices" />
      {devices.length === 0 ? (
        <Text style={tw`text-sm text-silver`}>
          Listening for the EYE MINI beacon… make sure it's awake and on the
          same Wi-Fi.
        </Text>
      ) : (
        devices.map((device) => (
          <Card key={device.serial} style={tw`mb-2`}>
            <View style={tw`flex-row items-center justify-between`}>
              <View>
                <Text style={tw`font-semibold text-ink`}>
                  {device.model} · {device.ip}
                </Text>
                <Text style={tw`text-xs text-silver`}>
                  s/n {device.serial} · fw {device.swVersion}
                </Text>
              </View>
              <Button
                label="Connect"
                compact
                loading={busy}
                onPress={() => void connectTo(device.ip)}
              />
            </View>
          </Card>
        ))
      )}

      <SectionTitle title="Direct IP" />
      <View style={tw`flex-row items-center gap-2`}>
        <TextInput
          style={tw`flex-1 rounded-xl border border-silver bg-white px-3 py-2.5`}
          placeholder="192.168.1.10"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          value={manualIp}
          onChangeText={setManualIp}
        />
        <Button
          label="Connect"
          compact
          loading={busy}
          disabled={manualIp.trim().length === 0}
          onPress={() => void connectTo(manualIp.trim())}
        />
      </View>

      {error && connection !== 'localNetworkDenied' && (
        <Text style={tw`mt-3 text-sm text-danger`}>{error}</Text>
      )}

      <SectionTitle title="Wrist sensor" />
      <View style={tw`flex-row items-center justify-between`}>
        <View style={tw`flex-row items-center gap-2`}>
          <View
            style={tw.style(
              'h-2.5 w-2.5 rounded-full',
              wristDotByState[wristConnection],
            )}
          />
          <Text style={tw`text-sm text-ink`}>{wristConnection}</Text>
          {wristBatteryPercent !== null && (
            <Text style={tw`text-xs text-silver`}>
              {wristBatteryPercent}% battery
            </Text>
          )}
        </View>
        {wristConnection === 'connected' && (
          <View style={tw`flex-row gap-2`}>
            <Button
              label="Buzz"
              variant="secondary"
              compact
              onPress={() => wrist.vibrate(400)}
            />
            <Button
              label="Calibrate"
              variant="secondary"
              compact
              onPress={() => router.push('/calibrate')}
            />
            <Button
              label="Disconnect"
              variant="ghost"
              compact
              onPress={disconnectWrist}
            />
          </View>
        )}
      </View>
      {(wristConnection === 'unauthorized' ||
        wristConnection === 'poweredOff') && (
        <Text style={tw`mt-1 text-sm text-silver`}>
          {wristConnection === 'unauthorized'
            ? 'Bluetooth permission was denied — allow it for Fairway in system settings.'
            : 'Bluetooth is off — turn it on to scan.'}
        </Text>
      )}
      {wristDevices.length === 0 ? (
        wristConnection === 'scanning' && (
          <Text style={tw`mt-2 text-sm text-silver`}>
            Scanning for a HackMotion unit… make sure it's awake and the vendor
            app is closed.
          </Text>
        )
      ) : (
        <View style={tw`mt-2`}>
          {wristDevices.map((device) => (
            <Card key={device.id} style={tw`mb-2`}>
              <View style={tw`flex-row items-center justify-between`}>
                <View>
                  <Text style={tw`font-semibold text-ink`}>{device.name}</Text>
                  {device.serial && (
                    <Text style={tw`text-xs text-silver`}>
                      s/n {device.serial}
                    </Text>
                  )}
                </View>
                <Button
                  label="Connect"
                  compact
                  loading={wristBusy}
                  disabled={wristConnection === 'connected'}
                  onPress={() => void connectWristTo(device.id)}
                />
              </View>
            </Card>
          ))}
        </View>
      )}
      {wristConnection === 'connected' && (
        <Card style={tw`mt-2`}>
          <View style={tw`flex-row items-center justify-between`}>
            <View style={tw`flex-1 pr-3`}>
              <Text style={tw`font-semibold text-ink`}>Raw capture</Text>
              <Text style={tw`mt-0.5 text-xs text-silver`}>
                {capture.recording
                  ? `Recording — ${capture.frames} frames · ${(
                      capture.bytes / 1024
                    ).toFixed(0)} KB`
                  : 'Records every sensor frame for tuning swing detection.'}
              </Text>
            </View>
            <Button
              label={capture.recording ? 'Stop' : 'Record'}
              variant={capture.recording ? 'danger' : 'ghost'}
              compact
              onPress={toggleCapture}
            />
          </View>
          {lastCapture !== null && (
            <View style={tw`mt-3 flex-row items-center justify-between`}>
              <Text style={tw`flex-1 pr-3 text-xs text-silver`}>
                Saved {lastCapture.split('/').pop()}
              </Text>
              <Button
                label="Share"
                compact
                onPress={() => void shareCapture(lastCapture)}
              />
            </View>
          )}
        </Card>
      )}

      {wristError && (
        <Text style={tw`mt-3 text-sm text-danger`}>{wristError}</Text>
      )}
    </ScrollView>
  );
}
