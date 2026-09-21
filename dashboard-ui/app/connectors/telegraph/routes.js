import { requireValue, ConnectionError } from '../../connection/errors.js';

export function segment(value) {
  requireValue(typeof value === 'string' && value.length > 0 && !['.', '..'].includes(value) && !/[\\/\x00-\x1f\x7f]/.test(value));
  return encodeURIComponent(value);
}
export function collectionName(value) {
  requireValue(typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value));
  return value;
}
export function bucketName(value) {
  requireValue(typeof value === 'string' && /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/.test(value));
  return value;
}
function objectKey(value) {
  requireValue(typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 1024);
  return value.split('/').map(part => part === '' ? '' : segment(part)).join('/');
}

// Local allowlist is independent of untrusted OpenAPI servers/security declarations.
// S3 and dashboard management are intentionally absent.
const policies = new Map([
  ['GET /openapi.json', { public: true }],
  ['GET /.well-known/jwks.json', { public: true }],
  ['GET /api/health', { public: true }],
  ['POST /api/auth/token', {}],
  ['GET /api/db/{collection}', { query: ['limit', 'cursor'], filters: true }],
  ['POST /api/db/{collection}', {}],
  ['GET /api/db/{collection}/{recordId}', {}],
  ['PATCH /api/db/{collection}/{recordId}', {}],
  ['DELETE /api/db/{collection}/{recordId}', {}],
  ['GET /api/storage/{bucket}', { query: ['prefix', 'delimiter', 'cursor', 'limit'] }],
  ['GET /api/storage/{bucket}/{key}', { query: ['download'], responseType: 'blob' }],
  ['HEAD /api/storage/{bucket}/{key}', {}],
  ['PUT /api/storage/{bucket}/{key}', {}],
  ['DELETE /api/storage/{bucket}/{key}', {}],
]);

export function createRoutes(client) {
  function resolve(id, pathParameters, query) {
    const policy = policies.get(id);
    if (!policy) throw new ConnectionError('unsupported_operation');
    const [method, template] = id.split(' ');
    const expected = [...template.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    requireValue(Object.keys(pathParameters).every(key => expected.includes(key)));
    const path = template.replace(/\{([^}]+)\}/g, (_, name) => {
      const value = pathParameters[name];
      if (name === 'collection') return collectionName(value);
      if (name === 'bucket') return bucketName(value);
      if (name === 'key') return objectKey(value);
      return segment(value);
    });
    for (const key of Object.keys(query)) {
      requireValue(policy.query?.includes(key) || (policy.filters && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)));
    }
    return { policy, method, path };
  }
  return {
    supports: id => policies.has(id),
    describe(id, { pathParameters = {}, query = {}, headers = {}, json, body } = {}) {
      const { policy, method, path } = resolve(id, pathParameters, query);
      const values = Object.fromEntries(client.validateHeaders(headers));
      requireValue(!(json !== undefined && body !== undefined));
      requireValue(!['GET', 'HEAD'].includes(method) || (json === undefined && body === undefined));
      if (json !== undefined && !values['content-type']) values['content-type'] = 'application/json';
      if (!policy.public) values.authorization = '[REDACTED]';
      const url = client.resolveUrl({ path, query });
      const bodyKind = json !== undefined ? 'json' : typeof body === 'string' ? 'text' : body === undefined ? 'none' : 'binary';
      const payload = json !== undefined ? json : typeof body === 'string' ? body : body === undefined ? null : { size: body.size ?? body.byteLength, note: 'Binary body omitted' };
      const [safeUrl, safeHeaders, safeBody] = client.redact([url, values, payload]);
      const preview = { method, url: safeUrl, headers: safeHeaders, authentication: policy.public ? 'none' : 'bearer', body: safeBody, bodyKind };
      requireValue(preview.url === url); // Do not turn detected URL credentials into executable placeholders.
      if (preview.bodyKind !== 'binary' && new TextEncoder().encode(JSON.stringify(preview.body)).length > 65536) {
        preview.body = '[Body omitted: exceeds the 64 KiB preview limit. Supply the original at runtime.]';
        preview.bodyKind = 'text'; preview.bodyOmitted = true;
      }
      return preview;
    },
    url(id, { pathParameters = {}, query = {} } = {}) {
      const { path } = resolve(id, pathParameters, query);
      return client.resolveUrl({ path, query });
    },
    async request(id, { pathParameters = {}, query = {}, ...options } = {}) {
      const { policy, method, path } = resolve(id, pathParameters, query);
      // Pick request options explicitly: a caller cannot override path, method or auth.
      return client.request({ path, method, query, authenticated: !policy.public,
        headers: options.headers, json: options.json, body: options.body,
        signal: options.signal, inspection: options.inspection === true, responseType: options.responseType || policy.responseType || 'json' });
    },
  };
}
