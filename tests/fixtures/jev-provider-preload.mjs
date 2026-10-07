/**
 * Routes the delivered JEv client's fixed TypeSafe endpoint to the controlled test origin named by
 * JEV_TEST_PROVIDER_ORIGIN. Tests load this module into a real `jev-mcp` child process through
 * NODE_OPTIONS so the package still performs its own request, response validation and error
 * mapping; only the external provider response is supplied.
 */
const FIXED_ORIGIN = 'https://api.typesafe.ai';
const FIXED_PATH = '/v1/systemone';
const fixtureOrigin = process.env.JEV_TEST_PROVIDER_ORIGIN;
const nativeFetch = globalThis.fetch;

if (fixtureOrigin === undefined) {
  throw new Error('JEV_TEST_PROVIDER_ORIGIN is not set');
}

globalThis.fetch = (input, init) => {
  const destination = new URL(
    typeof input === 'string' || input instanceof URL ? String(input) : input.url,
  );
  if (destination.origin !== FIXED_ORIGIN || destination.pathname !== FIXED_PATH) {
    throw new Error(`unexpected fetch destination ${destination.href}`);
  }
  return nativeFetch(new URL(destination.pathname + destination.search, fixtureOrigin), init);
};
