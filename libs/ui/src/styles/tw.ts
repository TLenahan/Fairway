import { create } from 'twrnc';

import { colors } from './colors';

/**
 * Project-configured twrnc instance — import `tw` from '@golf/ui' everywhere
 * (never the bare 'twrnc' default) so the palette stays consistent.
 */
export const tw = create({
  theme: {
    extend: {
      colors: {
        green: colors.green,
        gold: colors.gold,
        ink: colors.ink,
        ivory: colors.ivory,
        silver: colors.silver,
        sky: colors.sky,
        danger: colors.danger,
        warning: colors.warning,
        measured: colors.measured,
        computed: colors.computed,
      },
    },
  },
});
