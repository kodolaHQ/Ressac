/**
 * A test-only variable (RESSAC_TEST_*), or undefined in a packaged build: anyone who can set the app's environment
 * must not reach the e2e hooks (a folder of privileged actor modules, fake keychains…). Every chrome read goes
 * through here (test/test-env.test.ts checks it). `__RESSAC_PACKAGED__` is set by vite.config.ts; missing counts as packaged.
 */
export function testEnv(name: `RESSAC_TEST_${string}`): string | undefined {
  const dev = typeof __RESSAC_PACKAGED__ !== "undefined" && __RESSAC_PACKAGED__ === false;
  return (dev && Services.env.get(name)) || undefined;
}
