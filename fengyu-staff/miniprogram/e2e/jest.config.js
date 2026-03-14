module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/e2e/**/*.test.js'],
  globalSetup: './setup.js',
  globalTeardown: './teardown.js',
  testTimeout: 30000,
}
