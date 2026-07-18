import { tw } from '@golf/ui';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useFairwayStore } from '@/services/context';

/**
 * App-wide toast for an unexpected HackMotion drop (see WristSlice.wristAlert).
 * A silent mid-session death once cost a full range trip of wrist data, so this
 * is loud and dismissable, with a one-tap path to reconnect. Rendered once at
 * the root, above the navigator.
 */
export function WristToast() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const alert = useFairwayStore((s) => s.wristAlert);
  const dismiss = useFairwayStore((s) => s.dismissWristAlert);

  if (alert === null) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[
        tw`absolute inset-x-0 px-3`,
        { top: insets.top + 8 },
      ]}
    >
      <View
        style={tw`flex-row items-center gap-3 rounded-xl border border-danger bg-white px-4 py-3 shadow-lg`}
      >
        <View style={tw`h-2.5 w-2.5 rounded-full bg-danger`} />
        <Text style={tw`flex-1 text-sm text-ink`}>{alert}</Text>
        <Pressable
          onPress={() => {
            dismiss();
            router.push('/connect');
          }}
          style={tw`rounded-lg bg-green-700 px-3 py-1.5`}
        >
          <Text style={tw`text-xs font-semibold text-ivory`}>Reconnect</Text>
        </Pressable>
        <Pressable onPress={dismiss} hitSlop={8} style={tw`px-1`}>
          <Text style={tw`text-lg text-silver`}>×</Text>
        </Pressable>
      </View>
    </View>
  );
}
