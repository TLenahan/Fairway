export default {
  displayName: 'mcp',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@golf/data/node$': '<rootDir>/../data/src/node.ts',
    '^@golf/(.*)$': '<rootDir>/../$1/src/index.ts',
  },
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
};
