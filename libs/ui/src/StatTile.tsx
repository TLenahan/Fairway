import { Text, View } from 'react-native';

import { tw } from './styles/tw';

interface StatTileProps {
  label: string;
  /** preformatted display value; pass null for "not measured" */
  value: string | null;
  unit?: string;
  /** computed (model) values render with the estimate treatment */
  estimate?: boolean;
  large?: boolean;
}

/**
 * Single metric readout. Renders an explicit em dash for null (never a fake
 * 0) and an "est." marker for computed values — the two data-integrity rules
 * every screen must follow.
 */
export function StatTile({
  label,
  value,
  unit,
  estimate = false,
  large = false,
}: StatTileProps) {
  return (
    <View style={tw`min-w-20 py-1`}>
      <View style={tw`flex-row items-center gap-1`}>
        <Text style={tw`text-xs uppercase tracking-wide text-silver`}>
          {label}
        </Text>
        {estimate && (
          <Text style={tw`text-[10px] font-semibold text-computed`}>est.</Text>
        )}
      </View>
      <View style={tw`flex-row items-baseline gap-1`}>
        <Text
          style={tw.style(
            'font-semibold',
            large ? 'text-3xl' : 'text-lg',
            value === null
              ? 'text-silver'
              : estimate
                ? 'text-computed'
                : 'text-ink',
          )}
        >
          {value ?? '—'}
        </Text>
        {value !== null && unit && (
          <Text style={tw`text-xs text-silver`}>{unit}</Text>
        )}
      </View>
    </View>
  );
}
