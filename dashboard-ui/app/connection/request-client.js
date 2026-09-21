import { ConnectionError, requireValue } from './errors.js';
import { createRedactor } from './redaction.js';
import { inspectResponse } from './inspection.js';

const errorCodes = new Set([
  'version_conflict', 'unauthenticated', 'invalid_api_key', 'invalid_token', 'token_expired',
  'api_key_scope_forbidden', 'record_not_found', 'collection_not_found', 'object_not_found',
  'bucket_not_found', 'rate_limited', 'invalid_json', 'invalid_query_filter',
  'invalid_expected_version', 'schema_validation_failed', 'managed_field_not_allowed',
  'document_too_large', 'object_too_large', 'invalid_object_key', 'empty_patch',
  'range_not_satisfiable', 'precondition_failed',
  'invalid_token_request', 'invalid_token_ttl', 'invalid_jwt_issuer', 'internal_error',
]);
const permittedHeaders = new Set(['accept', 'content-type', 'if-match', 'if-none-match', 'range', 'idempotency-key']);
const credentialName = /authorization|cookie|password|secret|token|api[-_]?key|credential/i;

export function validateOrigin(value) {
  try {
    requireValue(typeof value === 'string' && value === value.trim(), 'invalid_configuration');
    const url = new URL(value);
    requireValue(url.protocol === 'https:' && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash, 'invalid_configuration');
    return url.origin;
  } catch {
    throw new ConnectionError('invalid_configuration');
  }
}

/** The only fetch boundary. All dependencies use browser/Workers Web APIs. */
export function createRequestClient({ baseUrl, getCredential, fetchImpl = globalThis.fetch, logger, timeoutMs = 30000 }) {
  const origin = validateOrigin(baseUrl);
  requireValue(typeof fetchImpl === 'function' && typeof getCredential === 'function' &&
    Number.isFinite(timeoutMs) && timeoutMs > 0, 'invalid_configuration');
  const redact = createRedactor(getCredential);
  let closed = false;
  const pending = new Set();
  const assertOpen = () => requireValue(!closed, 'connection_closed');
  // Only fixed event names, methods and numeric statuses ever reach diagnostics.
  const log = (event, method, status) => {
    try { logger?.(Object.freeze({ event, method, ...(Number.isInteger(status) ? { status } : {}) })); }
    catch { /* Diagnostics must not change request behavior. */ }
  };

  // Shared by requests and credential-free resource-address copying.
  function resolveUrl({ path, query = {} }) {
    assertOpen();
    requireValue(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[?#\\\s]/.test(path));
    // Reject traversal and encoded separators before URL normalization can change the path.
    for (const segment of path.split('/').slice(1)) {
      let decoded;
      try { decoded = decodeURIComponent(segment); } catch { throw new ConnectionError('invalid_request'); }
      requireValue(decoded !== '.' && decoded !== '..' && !/[\\/\x00-\x1f\x7f]/.test(decoded));
    }
    const credential = getCredential();
    const url = new URL(path, origin);
    requireValue(url.origin === origin);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      requireValue(!credentialName.test(key) && ['string', 'number', 'boolean'].includes(typeof value));
      url.searchParams.set(key, String(value));
    }
    // Refuse accidental use of the active secret anywhere in the URL.
    if (credential) {
      let decoded = url.href;
      for (let pass = 0; pass < 4; pass++) {
        requireValue(!decoded.includes(credential) && !decoded.includes(encodeURIComponent(credential)));
        try { decoded = decodeURIComponent(decoded); } catch { break; }
      }
    }
    return url.href;
  }

  function validateHeaders(headers = {}) {
    let values;
    try { values = new Headers(headers); } catch { throw new ConnectionError('invalid_request'); }
    for (const key of values.keys()) requireValue(permittedHeaders.has(key) || /^x-amz-meta-[a-z0-9-]+$/.test(key));
    return values;
  }

  async function request({ path, method = 'GET', query = {}, headers = {}, json, body,
    responseType = 'json', authenticated = true, signal, inspection = false } = {}) {
    assertOpen();
    requireValue(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method));
    requireValue(['json', 'blob', 'text', 'none'].includes(responseType));
    const credential = getCredential();
    if (authenticated) requireValue(Boolean(credential), 'not_connected');
    const url = resolveUrl({ path, query });
    const requestHeaders = validateHeaders(headers);
    requireValue(!(json !== undefined && body !== undefined));
    requireValue(!['GET', 'HEAD'].includes(method) || (json === undefined && body === undefined));
    if (json !== undefined) {
      try { body = JSON.stringify(json); } catch { throw new ConnectionError('invalid_request'); }
      if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
    }
    if (authenticated) requestHeaders.set('Authorization', `Bearer ${credential}`);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    log('request_started', method);
    try {
      const response = await fetchImpl(url, {
        method, headers: requestHeaders, body, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      if (inspection) {
        const inspected = await inspectResponse(response, method, redact);
        assertOpen();
        requireValue(!controller.signal.aborted, 'request_aborted');
        log('request_inspected', method, response.status);
        return inspected;
      }
      const notModified = response.status === 304 && method === 'GET' && requestHeaders.has('If-None-Match');
      if (!response.ok && !notModified) {
        let payload;
        try { payload = await response.json(); } catch { /* Never echo upstream text. */ }
        const code = errorCodes.has(payload?.error) ? payload.error : 'request_failed';
        throw new ConnectionError(code, { status: response.status, currentVersion: payload?.current_version });
      }
      let data = null;
      if (method !== 'HEAD' && response.status !== 204 && !notModified && responseType !== 'none') {
        try { data = await response[responseType](); }
        catch { throw new ConnectionError('invalid_response', { status: response.status }); }
      }
      assertOpen();
      requireValue(!controller.signal.aborted, 'request_aborted');
      log('request_succeeded', method, response.status);
      return { data, status: response.status, headers: response.headers };
    } catch (error) {
      const safeError = controller.signal.aborted
        ? new ConnectionError(timedOut ? 'request_timeout' : 'request_aborted')
        : error instanceof ConnectionError ? error : new ConnectionError('network_error');
      log('request_failed', method, safeError.status);
      throw safeError; // Never attach the original error, URL, body, headers or cause.
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending.delete(controller);
    }
  }

  return Object.freeze({ request, resolveUrl, validateHeaders, redact, assertOpen, close() {
    closed = true;
    for (const controller of pending) controller.abort();
    pending.clear();
  } });
}
