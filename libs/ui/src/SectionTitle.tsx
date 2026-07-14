import { Text } from 'react-native';

import { tw } from './styles/tw';

interface SectionTitleProps {
  title: string;
}

export function SectionTitle({ title }: SectionTitleProps) {
  return (
    <Text style={tw`mb-2 mt-4 text-sm font-semibold uppercase text-green-700`}>
      {title}
    </Text>
  );
}
