export default {
  displayName: 'hub',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@golf/data/node$': '<rootDir>/../../libs/data/src/node.ts',
    '^@golf/monitor/testing$': '<rootDir>/../../libs/monitor/src/testing/index.ts',
    '^@golf/(.*)$': '<rootDir>/../../libs/$1/src/index.ts',
  },
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
};
