/**
 * Runtime companion to tsconfig.base.json "paths" for the hub's swc-node
 * entry: yarn's workspace links resolve `@golf/<lib>` via package main, but
 * alias-only subpaths (`@golf/data/node`) need an explicit resolver hook.
 */
const { join } = require('node:path');
const { register } = require('tsconfig-paths');

register({
  baseUrl: join(__dirname, '../../..'),
  paths: {
    '@golf/data/node': ['libs/data/src/node.ts'],
    '@golf/monitor/testing': ['libs/monitor/src/testing/index.ts'],
    '@golf/*': ['libs/*/src/index.ts'],
  },
});
