import { Session } from '@golf/types';
import { Card, tw } from '@golf/ui';
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Text, View } from 'react-native';

import { useServices } from '@/services/context';

const formatDate = (epochMs: number) =>
  new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export default function SessionsScreen() {
  const { data } = useServices();
  const [sessions, setSessions] = useState<Session[]>([]);

  useFocusEffect(
    useCallback(() => {
      void data.listSessions().then(setSessions);
    }, [data]),
  );

  return (
    <View style={tw`flex-1 bg-ivory p-4`}>
      <FlatList
        data={sessions}
        keyExtractor={(session) => session.id}
        ListEmptyComponent={
          <Text style={tw`py-8 text-center text-silver`}>
            No sessions yet — go hit some balls.
          </Text>
        }
        renderItem={({ item }) => (
          <Link href={`/sessions/${item.id}`} asChild>
            <Card style={tw`mb-2`}>
              <View style={tw`flex-row items-center justify-between`}>
                <View>
                  <Text style={tw`font-semibold text-ink`}>
                    {item.name ?? 'Session'}
                  </Text>
                  <Text style={tw`text-xs text-silver`}>
                    {formatDate(item.startedAt)}
                    {item.endedAt ? '' : ' · active'}
                    {item.environment.presetName
                      ? ` · ${item.environment.presetName}`
                      : ''}
                  </Text>
                </View>
                <Text style={tw`text-green-700`}>›</Text>
              </View>
            </Card>
          </Link>
        )}
      />
    </View>
  );
}
