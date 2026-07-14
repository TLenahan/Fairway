import { DiscoveredDevice } from '@golf/types';
import { Button, Card, SectionTitle, tw } from '@golf/ui';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { ConnectionDot } from '@/components/ConnectionDot';
import { useFairwayStore, useServices, useSettings } from '@/services/context';

export default function ConnectScreen() {
  const router = useRouter();
  const { monitor, settings } = useServices();
  const connection = useFairwayStore((s) => s.connection);
  const connect = useFairwayStore((s) => s.connect);
  const savedIp = useSettings((s) => s.savedDeviceIp);

  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [manualIp, setManualIp] = useState(savedIp ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <View style={tw`flex-1 bg-ivory p-4`}>
      <ConnectionDot state={connection} />

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
    </View>
  );
}
