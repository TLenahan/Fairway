import { tw } from '@golf/ui';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { createAppServices } from '@/services/app-services';
import { AppServices, ServicesProvider } from '@/services/context';

export default function RootLayout() {
  const [services, setServices] = useState<AppServices | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    createAppServices((err) => console.warn('[fairway]', err.message))
      .then((s) => mounted && setServices(s))
      .catch((err: Error) => mounted && setInitError(err.message));
    return () => {
      mounted = false;
    };
  }, []);

  if (initError) {
    return (
      <View style={tw`flex-1 items-center justify-center bg-ivory p-8`}>
        <Text style={tw`text-danger text-base font-semibold`}>
          Failed to start: {initError}
        </Text>
      </View>
    );
  }

  if (!services) {
    return (
      <View style={tw`flex-1 items-center justify-center bg-ivory`}>
        <ActivityIndicator size="large" color={tw.color('green-700')} />
      </View>
    );
  }

  return (
    <ServicesProvider services={services}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: tw.color('green-900') },
          headerTintColor: tw.color('ivory'),
          headerTitleStyle: { fontWeight: '600' },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="practice" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ title: 'Connect' }} />
        <Stack.Screen name="sessions/index" options={{ title: 'Sessions' }} />
        <Stack.Screen name="sessions/[id]" options={{ title: 'Session' }} />
        <Stack.Screen
          name="analysis/[sessionId]"
          options={{ title: 'AI Analysis' }}
        />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </ServicesProvider>
  );
}
