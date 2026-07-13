const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);

// Monorepo: watch the whole workspace so @golf/* source edits hot-reload.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.join(__dirname, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];

config.resolver.alias = {
  '@': path.resolve(__dirname, 'src'),
};

// Force a SINGLE copy of these packages regardless of which file imports them.
// Workspace packages (e.g. @golf/viz) live in the repo-root node_modules, so a
// bare `import 'react'` from inside one can resolve to a different copy than
// the app's and yields two React instances. Pinning resolution to the app's
// entry keeps React/React Native/SVG singletons across packages.
const singletonPackages = ['react', 'react-dom', 'react-native', 'react-native-svg'];
const isSingletonModule = (moduleName) => {
  const name = String(moduleName);
  return singletonPackages.some(
    (pkg) => name === pkg || name.startsWith(`${pkg}/`),
  );
};

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (isSingletonModule(moduleName)) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(__dirname, 'index.ts') },
      moduleName,
      platform,
    );
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

module.exports = config;
