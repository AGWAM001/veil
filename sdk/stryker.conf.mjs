/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
const config = {
  packageManager: 'npm',
  reporters: ['progress', 'clear-text', 'json'],
  testRunner: 'jest',
  coverageAnalysis: 'perTest',
  mutate: ['src/utils.ts'],
  thresholds: { high: 80, low: 60, break: 0 },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json',
  },
  jest: {
    projectType: 'custom',
    // No configFile: this package keeps its jest config in package.json's
    // "jest" key, and naming a jest.config.js that does not exist made the
    // jest-runner throw MODULE_NOT_FOUND inside every sandbox before a single
    // mutant ran (the six-for-six red streak). Left unset, the loader falls
    // back to jest's own discovery order and finds the package.json config.
    enableFindRelatedTests: true,
  },
};

export default config;
