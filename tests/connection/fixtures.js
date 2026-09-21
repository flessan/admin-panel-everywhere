// Minimal contract fixtures from the published OpenAPI/prose, never live project data.
export const config = Object.freeze({
  TELEGRAPH_URL: 'https://telegraph.example',
  TELEGRAPH_PROJECT: 'prj_test',
  TELEGRAPH_API_KEY: 'test-only-not-a-real-credential',
});
export const record = { data: { id: 'rec_one', title: 'hello', done: false, count: 0 }, version: 2,
  created_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z' };
export const spec = {
  openapi: '3.1.0', info: { title: 'Contract fixture', version: '1' },
  servers: [{ url: 'https://untrusted.example' }],
  paths: {
    '/openapi.json': { get: { operationId: 'get_openapi_json', security: [] } },
    '/api/health': { get: { operationId: 'get_api_health', security: [] } },
    '/api/db/{collection}': {
      get: { operationId: 'get_api_db_collection', parameters: [{ name: 'collection', in: 'path', required: true }] },
      post: { operationId: 'post_api_db_collection', requestBody: { required: true } },
    },
    '/api/db/{collection}/{recordId}': { get: {}, patch: {}, delete: {} },
    '/api/storage/{bucket}/{key}': { get: {}, head: {}, put: {}, delete: {} },
    '/api/auth/token': { post: {} },
    '/s3/{bucket}': { get: { security: [{ awsSigV4: [] }] } },
    '/api/auth/keys/rotate': { post: {} },
    'https://untrusted.example/exfiltrate': { get: {} },
  },
};
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
export function mockFetch(respond = () => json(record)) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    return respond(url, options);
  };
  return { calls, fetchImpl };
}
