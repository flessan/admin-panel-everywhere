import { requireValue, ConnectionError } from './errors.js';
import { parseOpenApi } from './openapi-parser.js';
import { createRedactor } from './redaction.js';

/** OpenAPI is documentation, never permission to change the configured origin/auth. */
export function createOpenApiClient({ load, routes, assertOpen, redact = createRedactor() }) {
  let document = null, endpoints = [], revision = 0;
  async function discoverOpenApi({ refresh = false, signal } = {}) {
    assertOpen();
    if (!document || refresh) {
      const version = ++revision;
      const candidate = await load(signal);
      const catalog = parseOpenApi(candidate, { supports: id => routes.supports(id) });
      assertOpen();
      requireValue(version === revision, 'request_aborted');
      document = structuredClone(candidate); endpoints = catalog;
    }
    return structuredClone(document);
  }
  async function listEndpoints(options) { await discoverOpenApi(options); return structuredClone(endpoints); }
  async function endpointFor(options) {
    assertOpen(); await discoverOpenApi({ signal: options.signal });
    const endpoint = endpoints.find(entry => entry.id === options.endpointId);
    if (!endpoint?.executable) throw new ConnectionError('unsupported_operation');
    return endpoint;
  }
  async function execute({ endpointId, allowMutation = false, ...options } = {}) {
    const endpoint = await endpointFor({ endpointId, signal: options.signal });
    requireValue(['GET', 'HEAD'].includes(endpoint.method) || allowMutation === true);
    // Keep the established raw execute contract for programmatic connectors.
    return routes.request(endpoint.id, { ...options, inspection: false });
  }
  async function inspect({ endpointId, allowMutation = false, ...options } = {}) {
    const endpoint = await endpointFor({ endpointId, signal: options.signal });
    requireValue(['GET', 'HEAD'].includes(endpoint.method) || allowMutation === true);
    return routes.request(endpoint.id, { ...options, inspection: true });
  }
  async function previewRequest(options = {}) {
    const endpoint = await endpointFor(options);
    requireValue(typeof routes.describe === 'function', 'unsupported_operation');
    return routes.describe(endpoint.id, options);
  }
  return { discoverOpenApi, listEndpoints, execute, inspect, previewRequest,
    sanitize: value => redact(value), sanitizeDocument: value => redact(value, { document: true }),
    clear() { revision++; document = null; endpoints = []; } };
}
