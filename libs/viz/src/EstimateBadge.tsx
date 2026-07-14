import { Text, TextStyle } from 'react-native';

/**
 * The "est." marker every computed (flight-model) value must carry
 * (BUILD_SPEC rule #6). Reused by the app so estimates look identical
 * everywhere.
 */
export const ESTIMATE_COLOR = '#5f8fb4';

export function EstimateBadge({ style }: { style?: TextStyle }) {
  return (
    <Text
      style={[
        { color: ESTIMATE_COLOR, fontSize: 10, fontWeight: '600' },
        style,
      ]}
    >
      est.
    </Text>
  );
}
