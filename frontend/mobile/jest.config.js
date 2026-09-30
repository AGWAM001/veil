const expoPreset = require('jest-expo/jest-preset');

/**
 * Jest setup for the mobile app.
 *
 * `jest-expo` supplies the React Native transform, module mocks, and test
 * environment. The only change is the transform allow-list: `@noble/ciphers`,
 * `@noble/hashes`, and — since stellar-sdk 17 — `@exodus/bytes`,
 * `uint8array-extras`, and `smol-toml` ship ESM only, and Jest cannot `require`
 * them untransformed. Metro handles them natively, so this affects tests alone.
 *
 * `setupFiles` appends `jest.setup.js` to the preset's own setup files rather
 * than replacing them, so the React Native and Expo environment stubs still
 * run first. It registers the AsyncStorage mock — see that file for why.
 */
module.exports = {
  ...expoPreset,
  setupFiles: [...expoPreset.setupFiles, '<rootDir>/jest.setup.js'],
  transformIgnorePatterns: expoPreset.transformIgnorePatterns.map((pattern) =>
    pattern.startsWith('/node_modules/(?!(') ? pattern.replace('(?!(', '(?!(@noble|@exodus|uint8array-extras|smol-toml|') : pattern
  ),
};
