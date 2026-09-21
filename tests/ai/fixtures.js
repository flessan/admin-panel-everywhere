import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { createAiController } from '../../dashboard-ui/app/ai/controller.js';
import { createProviderRegistry } from '../../dashboard-ui/app/ai/providers.js';
export const credential = 'synthetic-ai-runtime-key';
export const schema = { fields: [{ name: 'title', type: 'text', required: true, indexed: true }, { name: 'active', type: 'boolean' }, { name: 'payload', type: 'json' }] };
export const operation = { id: 'GET /api/db/{collection}', method: 'GET', path: '/api/db/{collection}', tags: ['Database'], summary: 'List', description: 'Untrusted documentation', parameters: [
  { in: 'path', name: 'collection', required: true, schema: { type: 'string' } }, { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100 } },
], requestBody: null, responses: {}, security: [], securitySchemes: {}, executable: true };
export function setup(options = {}) {
  const calls = [], handoffs = [], registry = createProviderRegistry();
  const connection = createTelegraphConnection({ TELEGRAPH_URL: 'https://backend.example', TELEGRAPH_PROJECT: 'prj_test', TELEGRAPH_API_KEY: credential }, { fetchImpl: async (...args) => { calls.push(args); throw new Error('Unexpected backend call'); } });
  const record = { id: 'one', version: 7, data: { title: 'Before', active: true, payload: { preserve: [1, null, false] }, password: 'synthetic-business-password', alias: 'synthetic-business-password', keyEcho: credential } };
  const sources = structuredClone({
    data: { connected: true, collection: 'notes', schema: { schema, source: 'session', status: 'ready' }, records: { items: [record], status: 'ready', filters: { title: 'Before' }, limit: 20 }, editor: null },
    tools: { collection: 'notes', status: 'ready', schema, schemaSource: 'session', selected: ['one'], records: [record], plan: null, editor: null, running: false },
    files: { bucket: 'assets', prefix: 'docs/', delimiter: '/', details: { status: 'ready', key: 'docs/readme.txt', metadata: { bucket: 'assets', key: 'docs/readme.txt', size: 40, etag: 'etag1', version: 3, contentType: 'text/plain', metadata: { secret: 'private-custom-metadata' }, downloadUrl: 'https://bad.example/private', body: 'private-file-bytes' } } },
    api: { status: 'ready', operations: [operation, { ...operation, id: 'POST /api/db/{collection}', method: 'POST' }], selected: operation.id, history: [{ key: 'private-history' }], response: { ok: false, status: 403, bodyKind: 'json', data: { message: 'Rejected', access_token: 'synthetic-issued-token', echo: credential } } },
  });
  const controller = createAiController({ getSources: () => sources, registry, handoff: input => handoffs.push(input), ...options }); controller.connect(connection);
  const prepare = (task = 'prepare-bulk', extra = {}) => controller.prepare({ task, source: 'tools', instructions: 'Help with the selected data.', includeRecords: true, includeOperations: true, includeSchemas: true, ...extra });
  return { connection, sources, registry, controller, prepare, calls, handoffs };
}
export const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
