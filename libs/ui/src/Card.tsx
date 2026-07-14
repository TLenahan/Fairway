import { ReactNode } from 'react';
import { View, ViewStyle } from 'react-native';

import { tw } from './styles/tw';

interface CardProps {
  children: ReactNode;
  style?: ViewStyle;
}

export function Card({ children, style }: CardProps) {
  return (
    <View
      style={[
        tw`rounded-2xl bg-white p-4 shadow-sm border border-green-100`,
        style,
      ]}
    >
      {children}
    </View>
  );
}
