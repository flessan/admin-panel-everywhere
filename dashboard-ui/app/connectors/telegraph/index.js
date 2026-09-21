import { defineConnection } from '../../connection/contract.js';
import { createBearerAuthentication } from '../../connection/authentication.js';
import { createRequestClient, validateOrigin } from '../../connection/request-client.js';
import { createOpenApiClient } from '../../connection/openapi.js';
import { requireValue } from '../../connection/errors.js';
import { createRoutes } from './routes.js';
import { createDatabase } from './database.js';
import { createStorage, MAX_OBJECT_BYTES } from './storage.js';

/**
 * Explicit runtime input only. Never reads process.env, import.meta.env, DOM,
 * browser storage or globals containing configuration. No requests at creation.
 */
export function createTelegraphConnection(configuration = {}, {
  fetchImpl, logger, timeoutMs, collections = [], buckets = [],
  createIdempotencyKey = () => globalThis.crypto.randomUUID(),
} = {}) {
  requireValue(configuration && typeof configuration === 'object', 'invalid_configuration');
  const baseUrl = validateOrigin(configuration.TELEGRAPH_URL);
  const project = configuration.TELEGRAPH_PROJECT;
  requireValue(typeof project === 'string' && /^prj_[A-Za-z0-9_-]+$/.test(project), 'invalid_configuration');
  const session = createBearerAuthentication(configuration.TELEGRAPH_API_KEY);
  const client = createRequestClient({ baseUrl, getCredential: session.getCredential, fetchImpl, logger, timeoutMs });
  const routes = createRoutes(client);
  const api = createOpenApiClient({ routes, assertOpen: client.assertOpen, redact: client.redact,
    load: async signal => (await routes.request('GET /openapi.json', { signal })).data });
  const database = createDatabase({ routes, assertOpen: client.assertOpen, collections, createIdempotencyKey });
  const capabilities = Object.freeze({ collectionDiscovery: 'configured', schemaDiscovery: 'configured',
    collectionManagement: false, documentCrud: true, storage: true, bucketDiscovery: 'configured', openapi: true });

  return defineConnection({
    metadata: { limits: Object.freeze({ objectBytes: MAX_OBJECT_BYTES }), connector: 'telegraph', baseUrl, managementUrl: new URL('/console', baseUrl).href, project, projectAuthorization: 'credential', capabilities },
    authentication: session.public,
    discovery: { discoverOpenApi: api.discoverOpenApi, listEndpoints: api.listEndpoints },
    database,
    storage: createStorage(routes, { buckets, assertOpen: client.assertOpen }),
    api: { discoverOpenApi: api.discoverOpenApi, listEndpoints: api.listEndpoints, execute: api.execute, inspect: api.inspect, previewRequest: api.previewRequest, sanitize: api.sanitize, sanitizeDocument: api.sanitizeDocument },
    disconnect() { session.public.clear(); client.close(); api.clear(); },
  });
}
