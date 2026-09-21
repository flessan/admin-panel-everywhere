// Messages are deliberately fixed: never interpolate URLs, headers, bodies or credentials.
const messages = {
  invalid_configuration: 'Connection configuration is missing or invalid.',
  not_connected: 'No connection has been selected.',
  connection_closed: 'This connection has been disconnected.',
  unsupported_operation: 'This operation is not supported by this connection.',
  invalid_request: 'The request is missing required values or contains disallowed values.',
  invalid_response: 'The service returned an unexpected response.',
  invalid_openapi: 'The service did not return a supported OpenAPI document.',
  request_failed: 'The service rejected the request.',
  network_error: 'The service could not be reached.',
  request_aborted: 'The request was cancelled.',
  request_timeout: 'The request timed out.',
  version_conflict: 'The record changed. Reload it before applying your changes.',
};

export class ConnectionError extends Error {
  constructor(code, { status, currentVersion } = {}) {
    super(messages[code] || messages.request_failed);
    this.name = 'ConnectionError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
    if (Number.isInteger(currentVersion)) this.currentVersion = currentVersion;
  }
}

export function requireValue(condition, code = 'invalid_request') {
  if (!condition) throw new ConnectionError(code);
}

export function unsupported() {
  throw new ConnectionError('unsupported_operation');
}
