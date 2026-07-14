import { Button, SectionTitle, tw } from '@golf/ui';
import { useRouter } from 'expo-router';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ClubPicker } from '@/components/ClubPicker';
import { ConnectionDot } from '@/components/ConnectionDot';
import { useFairwayStore, useServices, useSettings } from '@/services/context';

interface PracticeDrawerProps {
  open: boolean;
  onClose(): void;
}

/**
 * Left drawer holding everything the immersive practice view evicted:
 * connection, session start/end, club selection/quick-add, and navigation.
 */
export function PracticeDrawer({ open, onClose }: PracticeDrawerProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, store } = useServices();
  const connection = useFairwayStore((s) => s.connection);
  const disconnect = useFairwayStore((s) => s.disconnect);
  const session = useFairwayStore((s) => s.session);
  const sessionShots = useFairwayStore((s) => s.sessionShots);
  const startSession = useFairwayStore((s) => s.startSession);
  const endSession = useFairwayStore((s) => s.endSession);
  const environment = useSettings((s) => s.environment);

  const go = (href: '/connect' | '/sessions' | '/settings') => {
    onClose();
    router.push(href);
  };

  const latest = sessionShots[0] ?? null;

  const discardLatest = async () => {
    if (!latest) return;
    await data.setShotDiscarded(latest.id, true);
    store.setState({
      sessionShots: store
        .getState()
        .sessionShots.map((s) =>
          s.id === latest.id ? { ...s, discarded: true } : s,
        ),
      lastShot: null,
    });
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={tw`flex-1 flex-row`}>
        <View
          style={[
            tw`w-80 max-w-[85%] bg-ivory px-4 pb-6`,
            { paddingTop: insets.top + 12 },
          ]}
        >
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={tw`text-xl font-bold text-green-900`}>Fairway</Text>

            <SectionTitle title="Device" />
            <View style={tw`flex-row items-center justify-between`}>
              <ConnectionDot state={connection} />
              {connection === 'connected' ? (
                <Button
                  label="Disconnect"
                  variant="ghost"
                  compact
                  onPress={disconnect}
                />
              ) : (
                <Button
                  label="Connect"
                  variant="secondary"
                  compact
                  onPress={() => go('/connect')}
                />
              )}
            </View>

            <SectionTitle title="Session" />
            {session ? (
              <View style={tw`gap-2`}>
                <View style={tw`flex-row items-center justify-between`}>
                  <Text style={tw`text-sm text-ink`}>
                    {sessionShots.length} shots
                  </Text>
                  <Button
                    label="End session"
                    variant="ghost"
                    compact
                    onPress={() => {
                      void endSession();
                      onClose();
                    }}
                  />
                </View>
                {latest && !latest.discarded && (
                  <Button
                    label="Discard last shot"
                    variant="ghost"
                    compact
                    onPress={() => {
                      void discardLatest();
                      onClose();
                    }}
                  />
                )}
              </View>
            ) : (
              <Button
                label="Start session"
                compact
                onPress={() => {
                  void startSession(environment);
                  onClose();
                }}
              />
            )}

            <SectionTitle title="Club" />
            <ClubPicker />

            <SectionTitle title="More" />
            <Pressable onPress={() => go('/sessions')} style={tw`py-2.5`}>
              <Text style={tw`text-base font-medium text-green-700`}>
                Session history
              </Text>
            </Pressable>
            <Pressable onPress={() => go('/settings')} style={tw`py-2.5`}>
              <Text style={tw`text-base font-medium text-green-700`}>
                Settings
              </Text>
            </Pressable>
          </ScrollView>
        </View>
        <Pressable style={tw`flex-1 bg-ink/40`} onPress={onClose} />
      </View>
    </Modal>
  );
}
