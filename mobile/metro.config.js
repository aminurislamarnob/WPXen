const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '..', 'shared');

const config = getDefaultConfig(projectRoot);

// The shared phone/desktop protocol lives outside mobile/ so both apps
// import one copy. Metro watches it on top of its defaults (after Orca's
// mobile/metro.config.js) — replacing the defaults drops what Expo set up.
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), sharedRoot]));
if (!config.resolver.sourceExts.includes('cjs')) {
  config.resolver.sourceExts.push('cjs');
}

// shared/ has no node_modules of its own. Walking up from it reaches the
// desktop's root node_modules, which Metro does not watch, so `tweetnacl`
// failed to resolve and the app did not bundle at all. Point it at the one
// copy mobile/ ships: the same module instance installSecureRandom() wires
// the PRNG into (src/crypto.ts), never a second copy with no PRNG.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  tweetnacl: path.resolve(projectRoot, 'node_modules', 'tweetnacl'),
};

module.exports = config;
