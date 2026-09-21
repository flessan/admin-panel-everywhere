export class FileInputError extends Error {}
export function fileError(error) {
  if (error instanceof FileInputError) return error.message;
  const codes = {
    invalid_request: 'Invalid storage request. Check the bucket, key, range, content type and metadata.',
    object_too_large: 'Object exceeds the documented 20 MiB upload limit.',
    invalid_object_key: 'The object key is not accepted by the service.',
    invalid_response: 'The storage response did not match the documented contract.',
    network_error: 'Storage request failed. Check connectivity and backend CORS permissions.',
    request_timeout: 'Storage request timed out. A write may have completed; refresh before retrying.',
    request_aborted: 'Storage request cancelled. A write may already have completed.',
    bucket_not_found: 'Bucket not found. Check its exact name; uploading may create it implicitly.',
    object_not_found: 'Object not found. Refresh the listing.',
    range_not_satisfiable: 'The byte range is outside this object. Refresh metadata and choose a valid range.',
    precondition_failed: 'The ETag changed. Refresh object details before downloading again.',
  };
  const statuses = {
    401: 'Authentication failed or expired. Reconnect with an authorized credential.',
    403: 'Your credential does not allow this storage operation.',
    404: 'Bucket or object not found. Refresh and check the exact name.',
    412: 'The ETag changed. Refresh object details before downloading again.',
    413: 'Object exceeds the documented 20 MiB upload limit.',
    416: 'The byte range is outside this object. Refresh metadata and choose a valid range.',
    429: 'Storage rate limit reached. Wait before retrying; writes are not retried automatically.',
  };
  return codes[error?.code] ?? statuses[error?.status] ?? 'Storage operation failed. No automatic retry was attempted.';
}
