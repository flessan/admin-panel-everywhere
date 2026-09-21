import { DataValidationError } from './schema.js';
const messages = {
  invalid_api_key: 'The credential was rejected. Reconnect with an authorized credential.',
  unauthenticated: 'Authentication is required. Reconnect.',
  token_expired: 'The session token expired. Reconnect.',
  invalid_token: 'The session token was rejected. Reconnect.',
  api_key_scope_forbidden: 'Your credential does not allow this operation.',
  collection_not_found: 'Collection not found. Check its exact name in the Telegraph console.',
  record_not_found: 'This record no longer exists. Refresh the collection.',
  invalid_query_filter: 'Filter rejected. Use indexed top-level string fields with exact-match values.',
  schema_validation_failed: 'Telegraph rejected the document schema. Check the field types and required fields in the console.',
  rate_limited: 'Telegraph rate limit reached. Wait before retrying; mutations are not retried automatically.',
  network_error: 'Request failed. Check connectivity and backend CORS permissions.',
  request_timeout: 'Request timed out. For creates, retry the unchanged draft to reuse its idempotency key.',
  invalid_request: 'Invalid request. Check the resource name, field values and required version.',
  invalid_response: 'The API response did not match the documented contract.',
  document_too_large: 'Document exceeds the server size limit.',
  not_connected: 'Connect to Telegraph to browse data.',
};
export function displayError(error) {
  if (error instanceof DataValidationError) return error.message;
  return messages[error?.code] ?? 'The operation failed. You can retry. No automatic overwrite was attempted.';
}
