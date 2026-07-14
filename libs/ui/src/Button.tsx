import { ActivityIndicator, Pressable, Text } from 'react-native';

import { tw } from './styles/tw';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps {
  label: string;
  onPress(): void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
}

const containerByVariant: Record<ButtonVariant, string> = {
  primary: 'bg-green-700',
  secondary: 'bg-gold-500',
  ghost: 'bg-transparent border border-green-700',
  danger: 'bg-danger',
};

const labelByVariant: Record<ButtonVariant, string> = {
  primary: 'text-ivory',
  secondary: 'text-ink',
  ghost: 'text-green-700',
  danger: 'text-ivory',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  compact = false,
}: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) =>
        tw.style(
          'flex-row items-center justify-center rounded-xl',
          compact ? 'px-3 py-2' : 'px-5 py-3.5',
          containerByVariant[variant],
          (disabled || loading) && 'opacity-40',
          pressed && 'opacity-70',
        )
      }
    >
      {loading ? (
        <ActivityIndicator size="small" color={tw.color('ivory')} />
      ) : (
        <Text
          style={tw.style(
            'font-semibold',
            compact ? 'text-sm' : 'text-base',
            labelByVariant[variant],
          )}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
