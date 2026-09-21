import { requireValue } from '../../connection/errors.js';
import { collectionName } from './routes.js';

export function normalizeRecord(record) {
  requireValue(record && record.data && typeof record.data === 'object' && !Array.isArray(record.data), 'invalid_response');
  // Compatibility boundary: prose examples use data.id, OpenAPI Record uses id.
  const id = record.id ?? record.data.id;
  requireValue(typeof id === 'string' && id.length > 0 && Number.isInteger(record.version) && record.version > 0, 'invalid_response');
  requireValue(!(record.id && record.data.id && record.id !== record.data.id), 'invalid_response');
  return { id, data: record.data, version: record.version, createdAt: record.created_at, updatedAt: record.updated_at };
}

function documentBody(data) {
  requireValue(data && typeof data === 'object' && !Array.isArray(data));
  requireValue(!['id', 'version', 'created_at', 'updated_at', '_expected_version'].some(key => Object.hasOwn(data, key)));
  return data;
}
function version(value) {
  requireValue(Number.isInteger(value) && value > 0);
  return value;
}
export function pagination({ limit = 20, cursor } = {}) {
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100);
  requireValue(cursor === undefined || cursor === null || typeof cursor === 'string');
  return { limit, cursor };
}
export function normalizePage(payload, normalize = value => value) {
  requireValue(payload && Array.isArray(payload.data) && typeof payload.has_more === 'boolean', 'invalid_response');
  requireValue(payload.next_cursor == null || typeof payload.next_cursor === 'string', 'invalid_response');
  requireValue(!payload.has_more || (typeof payload.next_cursor === 'string' && payload.next_cursor.length > 0), 'invalid_response');
  return { items: payload.data.map(normalize), hasMore: payload.has_more, nextCursor: payload.next_cursor ?? null };
}

export function createDatabase({ routes, assertOpen, collections = [], createIdempotencyKey }) {
  requireValue(Array.isArray(collections), 'invalid_configuration');
  const descriptors = collections.map(value => {
    const input = typeof value === 'string' ? { name: value } : value;
    requireValue(input && typeof input === 'object', 'invalid_configuration');
    collectionName(input.name);
    requireValue(input.schema == null || typeof input.schema === 'object', 'invalid_configuration');
    return { name: input.name, schema: input.schema == null ? null : structuredClone(input.schema),
      schemaSource: input.schema == null ? 'unavailable' : 'configured' };
  });
  requireValue(new Set(descriptors.map(item => item.name)).size === descriptors.length, 'invalid_configuration');

  const database = {
    async listCollections() {
      assertOpen();
      // This is a configured resource catalog, NOT remote collection enumeration.
      return { items: structuredClone(descriptors), source: 'configured', complete: false };
    },
    async getCollection(name) {
      assertOpen();
      collectionName(name);
      return structuredClone(descriptors.find(item => item.name === name) ?? { name, schema: null, schemaSource: 'unavailable' });
    },
    async getCollectionSchema(name) {
      const resource = await database.getCollection(name);
      return { schema: resource.schema, source: resource.schemaSource };
    },
    async listRecords(collection, { limit, cursor, filters = {}, signal } = {}) {
      const filterEntries = Object.entries(filters);
      requireValue(filterEntries.length <= 4 && filterEntries.every(([key, value]) =>
        key !== 'cursor' && key !== 'limit' && typeof value === 'string'));
      const result = await routes.request('GET /api/db/{collection}', {
        pathParameters: { collection }, query: { ...filters, ...pagination({ limit, cursor }) }, signal,
      });
      return normalizePage(result.data, normalizeRecord);
    },
    async getRecord(collection, recordId, { signal } = {}) {
      return normalizeRecord((await routes.request('GET /api/db/{collection}/{recordId}', {
        pathParameters: { collection, recordId }, signal,
      })).data);
    },
    async createRecord(collection, data, { idempotencyKey = createIdempotencyKey(), signal } = {}) {
      requireValue(typeof idempotencyKey === 'string' && /^[\x21-\x7e]{1,128}$/.test(idempotencyKey));
      return normalizeRecord((await routes.request('POST /api/db/{collection}', {
        pathParameters: { collection }, json: documentBody(data), headers: { 'Idempotency-Key': idempotencyKey }, signal,
      })).data);
    },
    async updateRecord(collection, recordId, changes, { expectedVersion, signal } = {}) {
      return normalizeRecord((await routes.request('PATCH /api/db/{collection}/{recordId}', {
        pathParameters: { collection, recordId },
        json: { ...documentBody(changes), _expected_version: version(expectedVersion) }, signal,
      })).data);
    },
    async deleteRecord(collection, recordId, { expectedVersion, signal } = {}) {
      const { data } = await routes.request('DELETE /api/db/{collection}/{recordId}', {
        pathParameters: { collection, recordId }, json: { _expected_version: version(expectedVersion) }, signal,
      });
      return { deleted: true, version: data?.version ?? null, deletedAt: data?.deleted_at ?? data?.data?.deleted_at ?? null };
    },
  };
  return database;
}
