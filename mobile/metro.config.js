const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// The shared phone/desktop protocol lives outside mobile/ so both apps
// import one copy. Metro watches it and resolves its .cjs files.
config.watchFolders = [path.resolve(__dirname, '..', 'shared')];
if (!config.resolver.sourceExts.includes('cjs')) {
  config.resolver.sourceExts.push('cjs');
}

module.exports = config;
