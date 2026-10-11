// WPXen Mobile's own lint: the root eslint config ignores mobile/ (the
// desktop gate never touches it), so this flat config scopes linting here.
import { defineConfig } from 'eslint/config';
import expoConfig from 'eslint-config-expo/flat.js';

export default defineConfig([
  ...expoConfig,
  {
    ignores: ['dist/*'],
  },
]);
