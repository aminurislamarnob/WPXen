// Dynamic config on top of app.json, which Expo still reads and passes in as
// `config`. Everything here is about push with the app closed (spec #149):
//
// - extra.eas.projectId: getExpoPushTokenAsync needs the EAS project to mint
//   a token. Read from EAS_PROJECT_ID (`eas init` prints it) so no project id
//   is committed; without it the app runs and says push is unavailable.
// - the expo-notifications plugin with background remote notifications
//   (after Orca's mobile/app.config.js), which a native build needs to be
//   woken by a push. Config plugins only apply to a development or release
//   build — Expo Go can't receive this app's pushes at all.
// - the APNs environment: the plugin defaults to development (sandbox), which
//   silently loses TestFlight / App Store pushes; a release build sets
//   WPXEN_APS_ENVIRONMENT=production.

function apsEnvironment() {
  return process.env.WPXEN_APS_ENVIRONMENT === 'production' ? 'production' : 'development';
}

function isNotificationsPlugin(plugin) {
  return plugin === 'expo-notifications' || (Array.isArray(plugin) && plugin[0] === 'expo-notifications');
}

module.exports = ({ config }) => {
  const projectId = (process.env.EAS_PROJECT_ID || '').trim();
  const eas = { ...(config.extra?.eas ?? {}) };
  if (projectId) eas.projectId = projectId;
  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []).filter((plugin) => !isNotificationsPlugin(plugin)),
      ['expo-notifications', { enableBackgroundRemoteNotifications: true, mode: apsEnvironment() }],
    ],
    extra: { ...(config.extra ?? {}), eas },
  };
};
