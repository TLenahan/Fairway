import { Pressable, Text } from 'react-native';

import { tw } from './styles/tw';

interface PillProps {
  label: string;
  selected?: boolean;
  onPress?(): void;
}

/** compact selectable chip — club picker, presets, scope choices */
export function Pill({ label, selected = false, onPress }: PillProps) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) =>
        tw.style(
          'rounded-full border px-3 py-1.5',
          selected ? 'border-green-700 bg-green-700' : 'border-silver bg-white',
          pressed && 'opacity-70',
        )
      }
    >
      <Text
        style={tw.style(
          'text-sm font-medium',
          selected ? 'text-ivory' : 'text-ink',
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}
