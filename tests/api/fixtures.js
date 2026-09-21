// Deliberately synthetic documents/credentials; no live backend access in tests.
export const document = {
  openapi: '3.1.0', info: { title: 'Fixture API', version: '1' },
  servers: [{ url: 'https://untrusted.example' }], security: [{ bearerApi: [] }],
  components: {
    securitySchemes: { bearerApi: { type: 'http', scheme: 'bearer' } },
    parameters: { Collection: { name: 'collection', in: 'path', required: true, schema: { type: 'string' } } },
    schemas: { Document: { type: 'object', properties: { title: { type: 'string' }, password: { type: 'string', example: 'do-not-import-this-value' } }, additionalProperties: true } },
  },
  paths: {
    '/api/health': { get: { tags: ['Platform'], summary: 'Health check', security: [], responses: { 200: { description: 'Healthy' } } } },
    '/openapi.json': { get: { tags: ['Platform'], security: [] } },
    '/api/db/{collection}': {
      parameters: [{ $ref: '#/components/parameters/Collection' }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000 } }],
      get: { tags: ['Database'], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }, { name: '', in: 'query', description: 'Dynamic exact-match filter' }] },
      post: { tags: ['Database'], parameters: [{ in: 'header', name: 'Idempotency-Key', schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } } } },
    },
    '/api/auth/token': { post: { tags: ['Platform'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { expires_in: { type: 'integer' } } } } } } } },
    '/api/storage/{bucket}/{key}': {
      parameters: [{ name: 'bucket', in: 'path', required: true, schema: { type: 'string' } }, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
      get: { tags: ['Storage'], parameters: [{ name: 'Range', in: 'header', schema: { type: 'string' } }] },
      put: { tags: ['Storage'], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
      head: { tags: ['Storage'] },
    },
    '/s3/{bucket}': { get: { tags: ['S3'], security: [{ awsSigV4: [] }], summary: 'Signing required' } },
    '/not-approved': { get: { tags: ['Future'] } },
  },
};
export const credential = 'opaque-fixture-credential-not-real';
export const config = { TELEGRAPH_URL: 'https://backend.example', TELEGRAPH_PROJECT: 'prj_fixture', TELEGRAPH_API_KEY: credential };
export const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const flush = () => new Promise(resolve => setTimeout(resolve, 0));
export const parameter = (name, value, location = 'path') => ({ name, in: location, value, included: true });
