// Injects a build timestamp into the app config at evaluation time — i.e. when
// the dev server starts (`expo start`) or a production bundle is built. Exposed
// as expoConfig.extra.buildTimeMs and shown on the Connect screen so we can
// confirm the phone is running the current code. Everything else comes straight
// from app.json (single source of truth for the static config).
const appJson = require('./app.json');

module.exports = () => ({
  ...appJson.expo,
  extra: {
    ...(appJson.expo.extra ?? {}),
    buildTimeMs: Date.now(),
  },
});
