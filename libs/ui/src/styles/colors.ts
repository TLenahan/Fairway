/**
 * Fairway palette — golf greens with a gold CTA accent, plus semantic tones
 * for the measured/computed distinction that runs through the whole app.
 */
export const colors = {
  // brand
  green: {
    50: '#eef6ef',
    100: '#d6e9d9',
    300: '#8fc49a',
    500: '#3f7d4f',
    700: '#1f5631',
    900: '#0b3d2e',
  },
  gold: {
    100: '#f7ecd0',
    300: '#e8cd8a',
    500: '#d4af37',
    700: '#a8862a',
  },
  ink: '#131a16',
  ivory: '#faf8f2',
  silver: '#9aa4a0',
  sky: '#5f8fb4',
  danger: '#b8433c',
  warning: '#c98a2d',
  // semantic: sensor-measured vs model-computed
  measured: '#1f5631',
  computed: '#5f8fb4',
} as const;
