/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch:         ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/scripts/**',
    '!src/config/**',
  ],
  coverageDirectory: 'coverage',
  verbose:           true,
  testTimeout:       15000,
  forceExit:         true,
};
