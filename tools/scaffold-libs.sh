#!/bin/bash
# One-shot generator for the nine @golf/* lib skeletons (WP0).
set -euo pipefail
cd "$(dirname "$0")/.."

LIBS="types monitor data flight-model analytics analysis viz store ui"

for LIB in $LIBS; do
  mkdir -p "libs/$LIB/src"

  # tags: viz/ui are UI libs; types is the leaf; everything else util
  case "$LIB" in
    viz|ui) TYPE_TAG="type:ui" ;;
    types)  TYPE_TAG="type:types" ;;
    *)      TYPE_TAG="type:util" ;;
  esac

  # deps: everything except types depends on @golf/types; zod where schemas live
  case "$LIB" in
    types)
      DEPS='"zod": "^3.24.4"' ;;
    store)
      DEPS='"@golf/types": "workspace:*", "zustand": "^5.0.2"' ;;
    analysis)
      DEPS='"@golf/types": "workspace:*", "@golf/analytics": "workspace:*", "zod": "^3.24.4"' ;;
    *)
      DEPS='"@golf/types": "workspace:*"' ;;
  esac

  cat > "libs/$LIB/package.json" <<EOF
{
  "name": "@golf/$LIB",
  "version": "0.0.1",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": { $DEPS }
}
EOF

  cat > "libs/$LIB/project.json" <<EOF
{
  "\$schema": "../../node_modules/nx/schemas/project-schema.json",
  "name": "$LIB",
  "sourceRoot": "libs/$LIB/src",
  "projectType": "library",
  "tags": ["scope:golf", "$TYPE_TAG", "lib:$LIB"]
}
EOF

  if [ "$LIB" = "viz" ] || [ "$LIB" = "ui" ]; then
    JSX='"jsx": "react-jsx",'
    INCLUDE='"src/**/*.ts", "src/**/*.tsx", "jest.config.ts"'
  else
    JSX=''
    INCLUDE='"src/**/*.ts", "jest.config.ts"'
  fi

  cat > "libs/$LIB/tsconfig.json" <<EOF
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    $JSX
    "noEmit": true,
    "types": ["node", "jest"]
  },
  "include": [$INCLUDE]
}
EOF

  cat > "libs/$LIB/jest.config.ts" <<EOF
export default {
  displayName: '$LIB',
  testEnvironment: 'node',
  transform: {
    '^.+\\\\.[tj]sx?\$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@golf/(.*)\$': '<rootDir>/../\$1/src/index.ts',
  },
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/src/**/*.spec.tsx'],
};
EOF

  cat > "libs/$LIB/eslint.config.mjs" <<EOF
import rootConfig from '../../eslint.config.mjs';

export default rootConfig;
EOF

  if [ ! -f "libs/$LIB/src/index.ts" ]; then
    cat > "libs/$LIB/src/index.ts" <<EOF
// @golf/$LIB — implemented in its work package (see handoff/WORK_PACKAGES.md).
export {};
EOF
  fi
done

echo "scaffolded: $LIBS"
