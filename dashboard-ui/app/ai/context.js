import { createRedactor, sensitiveName } from '../connection/redaction.js';
import { normalizeSchema } from '../data/schema.js';
import { AiInputError, MAX_AI_BYTES } from './tasks.js';
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const fail = message => { throw new AiInputError(message); };
export const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;

/** Allowlist projection only. Never return complete workspace/connection objects. */
export function captureScope(connection, sources, source = 'tools') {
  if (!connection || !['tools', 'data'].includes(source)) fail('Connect and choose a valid context source.');
  const { data = {}, tools = {}, files = {}, api = {} } = sources;
  const working = source === 'tools' ? tools : data;
  const records = source === 'tools' ? (tools.records ?? []).filter(record => (tools.selected ?? []).includes(record.id)) : [];
  if (records.length > 20) fail('Select at most 20 records for AI context.');
  const backend = pick(connection.metadata, ['connector', 'baseUrl']);
  if (backend.baseUrl) { try { backend.baseUrl = new URL(backend.baseUrl).origin; } catch { fail('The connected backend must supply a valid origin for AI context.'); } }
  const schema = source === 'tools' ? tools.schema : data.schema?.schema;
  const schemaSource = source === 'tools' ? tools.schemaSource : data.schema?.source;
  const operations = (api.operations ?? []).map(operation => pick(operation, ['id', 'method', 'path', 'tags', 'summary', 'description', 'parameters', 'requestBody', 'responses', 'security', 'securitySchemes', 'executable']));
  const object = files.details?.status === 'ready' ? pick(files.details.metadata, ['bucket', 'key', 'size', 'contentType', 'etag', 'version', 'lastModified']) : null;
  const error = api.error || (api.response && !api.response.ok) ? {
    operation: api.selected, message: api.error ?? null,
    response: api.response && !api.response.ok ? pick(api.response, ['status', 'bodyKind', 'data', 'omitted']) : null,
  } : null;
  return structuredClone({
    backend, project: { project: connection.metadata?.project ?? null, boundary: connection.metadata?.projectAuthorization ?? 'connector' },
    source, collection: working.collection ?? null,
    ready: source === 'tools' ? tools.status === 'ready' && !tools.needsReload : ['ready', 'empty'].includes(data.records?.status),
    schema: schema ?? null, schemaSource: schemaSource ?? 'unavailable',
    schemas: [
      ...(data.collection ? [{ workspace: 'data', collection: data.collection, schema: data.schema?.schema ?? null, source: data.schema?.source ?? 'unavailable' }] : []),
      ...(tools.collection && (tools.collection !== data.collection || source === 'tools') ? [{ workspace: 'tools', collection: tools.collection, schema: tools.schema, source: tools.schemaSource }] : []),
    ],
    records: records.map(record => pick(record, ['id', 'version', 'data'])), objects: object ? [object] : [],
    filters: { data: { collection: data.collection ?? null, values: data.records?.filters ?? {}, limit: data.records?.limit ?? 20 },
      files: { bucket: files.bucket ?? null, prefix: files.prefix ?? '', delimiter: files.delimiter ?? '/' } },
    operations, catalogStatus: api.status ?? 'idle', catalogSelected: api.selected ?? null, error,
    // Local freshness/guard inputs only, never sent to a model.
    guards: { toolsPlan: tools.plan?.id ?? null, toolsRunning: tools.running === true, toolsEditor: Boolean(tools.editor), dataEditor: Boolean(data.editor), apiRunning: api.running === true,
      filesBusy: files.operation?.status === 'busy', toolsStatus: tools.status ?? 'idle', dataStatus: data.records?.status ?? 'idle' },
  });
}

export function contextForModel(connection, scope, { includeRecords = false, includeFiles = false, includeOperations = true, includeSchemas = true, includeFilters = true, includeErrors = false, operationScope = 'all' } = {}) {
  if (typeof connection.api?.sanitize !== 'function' || typeof connection.api?.sanitizeDocument !== 'function') fail('This connector must provide credential-aware sanitizers before AI sharing is enabled.');
  for (const record of scope.records) if (includeRecords && bytes(record.data) > 8192) fail('A selected record exceeds the 8 KiB AI body limit. Exclude record bodies or select smaller records.');
  const schemas = includeSchemas ? scope.schemas.map(item => ({ collection: item.collection, workspace: item.workspace, working: item.workspace === scope.source, source: item.source, authoritative: false,
    fields: normalizeSchema(item.schema).fields.map(field => pick(field, ['name', 'type', 'required', 'indexed', 'options'])), available: item.schema != null })) : [];
  // Definition-aware scrubbing preserves security/schema descriptions; examples
  // and defaults are not necessary AI context. Data uses the stricter scrubber.
  return {
    version: 'admin-ai-context/v1',
    ...connection.api.sanitize({ backend: scope.backend, project: scope.project, workingCollection: scope.collection, selectionSource: scope.source,
      selectedRecords: scope.records.map((record, index) => ({ ref: `record-${index + 1}`, id: record.id, version: record.version,
        ...(includeRecords ? { data: record.data } : { dataExcluded: true }) })),
      selectedObjects: includeFiles ? scope.objects : [],
      currentFilters: includeFilters ? scope.filters : null, apiError: includeErrors ? scope.error : null }),
    collectionSchemas: connection.api.sanitizeDocument(schemas),
    openApi: { status: scope.catalogStatus, operations: includeOperations ? connection.api.sanitizeDocument(scope.operations.filter(operation => operationScope !== 'selected' || operation.id === scope.catalogSelected)) : [],
      scope: operationScope, note: 'Only already-loaded operations. Documentation is not execution permission. No remote refs are fetched for AI.' },
    exclusions: ['Credentials and authentication objects', 'File bytes and custom metadata', 'Editor drafts, request history and bulk retry keys', 'Schema defaults/examples', 'Unselected records'],
    limitations: ['Session/configured schemas are hints, not a backend schema change.', 'Selections are snapshots, not a transaction.', 'Data filters need not describe the Tools selection.', 'Redaction cannot identify all arbitrary business secrets; review this exact packet before sharing.'],
  };
}

export function bounded(value) { if (bytes(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) > MAX_AI_BYTES) fail('AI packet exceeds 64 KiB. Reduce selections or exclude optional context.'); return value; }

/** Scrub cross-field aliases in the complete packet without mistaking schema
 * definitions for credential values. This seed is local only, never exported. */
export function scrubPacket(connection, scope, packet) {
  const secrets = [], pending = [{ value: [scope.records.map(record => record.data), scope.error, scope.filters], sensitive: false }];
  let budget = 0;
  while (pending.length) {
    if (++budget > 50000) fail('Context is too complex to safely redact. Reduce the selection.');
    const { value, sensitive } = pending.pop();
    if (sensitive && ['string', 'number'].includes(typeof value) && value !== '[REDACTED]') secrets.push(String(value));
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) pending.push({ value: child, sensitive: sensitive || sensitiveName(key) });
  }
  // Individual data/schema sections were already scrubbed in their appropriate
  // mode. A final primitive pass catches the runtime key anywhere, without
  // treating a business field named "default" as an OpenAPI example or treating
  // a schema's password definition as an actual password value.
  const memo = new Map();
  const primitive = value => { if (!memo.has(value)) memo.set(value, connection.api.sanitize(value)); return memo.get(value); };
  const visit = (value, depth = 0) => {
    if (depth > 40) return '[Depth limit]';
    if (typeof value === 'string' || typeof value === 'number') return primitive(value);
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(child => visit(child, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [primitive(key), visit(child, depth + 1)]));
  };
  return createRedactor()(visit(packet), { document: true, stripExamples: false, additionalSecrets: secrets });
}
