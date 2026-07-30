export default {
  displayName: 'insights',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@golf/(.*)$': '<rootDir>/../$1/src/index.ts',
  },
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
};
