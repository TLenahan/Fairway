import { ConnectionState } from '@golf/types';
import { Text, View } from 'react-native';
import { z } from 'zod';

import { tw } from '@golf/ui';

type Connection = z.infer<typeof ConnectionState>;

interface ConnectionDotProps {
  state: Connection;
}

const dotByState: Record<Connection, string> = {
  disconnected: 'bg-silver',
  discovering: 'bg-warning',
  connecting: 'bg-warning',
  connected: 'bg-green-500',
  error: 'bg-danger',
  localNetworkDenied: 'bg-danger',
};

const labelByState: Record<Connection, string> = {
  disconnected: 'Disconnected',
  discovering: 'Discovering…',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Connection error',
  localNetworkDenied: 'Local Network access denied',
};

export function ConnectionDot({ state }: ConnectionDotProps) {
  return (
    <View style={tw`flex-row items-center gap-2`}>
      <View style={tw.style('h-2.5 w-2.5 rounded-full', dotByState[state])} />
      <Text style={tw`text-sm text-ink`}>{labelByState[state]}</Text>
    </View>
  );
}
