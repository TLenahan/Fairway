import {
  validateApiKey,
  DEFAULT_MODEL,
  DEEP_ANALYSIS_MODEL,
} from '@golf/analysis';
import { Button, Card, Pill, SectionTitle, tw } from '@golf/ui';
import { fetch as expoFetch } from 'expo/fetch';
import { useEffect, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';

import { ENVIRONMENT_PRESETS } from '@/constants/environments';
import { clearApiKey, getApiKey, setApiKey } from '@/services/api-key';
import { useFairwayStore, useServices, useSettings } from '@/services/context';

type KeyStatus = 'unknown' | 'saved' | 'valid' | 'invalid' | 'none';

export default function SettingsScreen() {
  const { monitor } = useServices();
  const settings = useSettings((s) => s);
  const connection = useFairwayStore((s) => s.connection);

  const [keyInput, setKeyInput] = useState('');
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('unknown');
  const [keyBusy, setKeyBusy] = useState(false);
  const [customAltitude, setCustomAltitude] = useState(
    String(Math.round(settings.environment.altitudeM)),
  );

  useEffect(() => {
    void getApiKey().then((key) => setKeyStatus(key ? 'saved' : 'none'));
  }, []);

  const saveAndValidateKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setKeyBusy(true);
    try {
      const valid = await validateApiKey(
        key,
        expoFetch as unknown as typeof fetch,
      );
      if (valid) {
        await setApiKey(key);
        setKeyInput('');
      }
      setKeyStatus(valid ? 'valid' : 'invalid');
    } catch {
      // network failure ≠ bad key; save it and let analysis surface errors
      await setApiKey(key);
      setKeyInput('');
      setKeyStatus('saved');
    } finally {
      setKeyBusy(false);
    }
  };

  const applyAltitude = () => {
    const altitudeM = Number(customAltitude);
    if (!Number.isFinite(altitudeM) || altitudeM < -400 || altitudeM > 6000)
      return;
    settings.setEnvironment({
      altitudeM,
      temperatureC: settings.environment.temperatureC,
      presetName: null,
    });
  };

  const setHandedness = (handedness: 'right' | 'left') => {
    settings.update({ handedness });
    if (connection === 'connected') {
      void monitor.setHandedness(handedness);
    }
  };

  return (
    <ScrollView
      style={tw`flex-1 bg-ivory`}
      contentContainerStyle={tw`p-4 pb-16`}
    >
      <SectionTitle title="Units (display only — data stays SI)" />
      <View style={tw`flex-row gap-2`}>
        <Pill
          label="mph / yards"
          selected={settings.speedUnit === 'mph'}
          onPress={() =>
            settings.update({ speedUnit: 'mph', distanceUnit: 'yards' })
          }
        />
        <Pill
          label="m/s / meters"
          selected={settings.speedUnit === 'ms'}
          onPress={() =>
            settings.update({ speedUnit: 'ms', distanceUnit: 'meters' })
          }
        />
      </View>

      <SectionTitle title="Environment (feeds the flight model)" />
      <View style={tw`flex-row flex-wrap gap-2`}>
        {ENVIRONMENT_PRESETS.map((preset) => (
          <Pill
            key={preset.presetName ?? String(preset.altitudeM)}
            label={preset.presetName ?? `${preset.altitudeM} m`}
            selected={settings.environment.presetName === preset.presetName}
            onPress={() => {
              settings.setEnvironment(preset);
              setCustomAltitude(String(Math.round(preset.altitudeM)));
            }}
          />
        ))}
      </View>
      <View style={tw`mt-2 flex-row items-center gap-2`}>
        <TextInput
          style={tw`w-28 rounded-xl border border-silver bg-white px-3 py-2`}
          value={customAltitude}
          onChangeText={setCustomAltitude}
          keyboardType="number-pad"
        />
        <Text style={tw`text-sm text-silver`}>m altitude</Text>
        <Button label="Apply" variant="ghost" compact onPress={applyAltitude} />
      </View>

      <SectionTitle title="Handedness" />
      <View style={tw`flex-row gap-2`}>
        <Pill
          label="Right"
          selected={settings.handedness === 'right'}
          onPress={() => setHandedness('right')}
        />
        <Pill
          label="Left"
          selected={settings.handedness === 'left'}
          onPress={() => setHandedness('left')}
        />
      </View>

      <SectionTitle title="AI analysis" />
      <Card>
        <Text style={tw`text-sm text-ink`}>
          Anthropic API key —{' '}
          {keyStatus === 'none'
            ? 'not set'
            : keyStatus === 'invalid'
              ? 'REJECTED (401)'
              : keyStatus === 'valid'
                ? 'validated ✓'
                : 'saved'}
        </Text>
        <View style={tw`mt-2 flex-row items-center gap-2`}>
          <TextInput
            style={tw`flex-1 rounded-xl border border-silver bg-white px-3 py-2`}
            placeholder="sk-ant-…"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            value={keyInput}
            onChangeText={setKeyInput}
          />
          <Button
            label="Save"
            compact
            loading={keyBusy}
            disabled={keyInput.trim().length === 0}
            onPress={() => void saveAndValidateKey()}
          />
        </View>
        {keyStatus !== 'none' && (
          <Button
            label="Remove key"
            variant="ghost"
            compact
            onPress={() => {
              void clearApiKey().then(() => setKeyStatus('none'));
            }}
          />
        )}
        <View style={tw`mt-3 flex-row items-center justify-between`}>
          <View>
            <Text style={tw`text-sm text-ink`}>Deep analysis</Text>
            <Text style={tw`text-xs text-silver`}>
              {settings.deepAnalysis ? DEEP_ANALYSIS_MODEL : DEFAULT_MODEL}
            </Text>
          </View>
          <Switch
            value={settings.deepAnalysis}
            onValueChange={(deepAnalysis) => settings.update({ deepAnalysis })}
            trackColor={{ true: tw.color('green-500') }}
          />
        </View>
      </Card>

      <SectionTitle title="Device" />
      <Card>
        <Text style={tw`text-sm text-ink`}>
          Saved IP: {settings.savedDeviceIp ?? 'none'}
        </Text>
        {settings.savedDeviceIp && (
          <Button
            label="Forget device"
            variant="ghost"
            compact
            onPress={() => settings.update({ savedDeviceIp: null })}
          />
        )}
      </Card>
    </ScrollView>
  );
}
