import { requireValue } from './errors.js';

/**
 * @typedef {{id: string, data: Object, version: number, createdAt?: string, updatedAt?: string}} RecordEnvelope
 * @typedef {{items: Array, hasMore: boolean, nextCursor: string|null}} Page
 * @typedef {{name: string, schema: Object|null, schemaSource: string}} CollectionDescriptor
 *
 * Every connector exposes the same six namespaces. Unsupported operations reject
 * with ConnectionError('unsupported_operation'), never fake empty remote results.
 * API workstation extensions (inspect, previewRequest, sanitize, sanitizeDocument)
 * are optional for legacy connectors; without them UI execution stays disabled.
 * See docs/connection-architecture.md for method arguments and capability semantics.
 */
const methods = {
  authentication: ['clear'],
  discovery: ['discoverOpenApi', 'listEndpoints'],
  database: ['listCollections', 'getCollection', 'getCollectionSchema', 'listRecords', 'getRecord', 'createRecord', 'updateRecord', 'deleteRecord'],
  storage: ['listObjects', 'getObjectMetadata', 'downloadObject', 'uploadObject', 'deleteObject'],
  api: ['discoverOpenApi', 'listEndpoints', 'execute'],
};

export function defineConnection(parts) {
  requireValue(parts && parts.metadata && typeof parts.disconnect === 'function', 'invalid_configuration');
  for (const [namespace, names] of Object.entries(methods)) {
    requireValue(names.every(name => typeof parts[namespace]?.[name] === 'function'), 'invalid_configuration');
    Object.freeze(parts[namespace]);
  }
  Object.freeze(parts.metadata);
  return Object.freeze(parts);
}
