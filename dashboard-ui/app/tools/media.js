import { DataValidationError } from '../data/schema.js';
export const MAX_INSPECT_BYTES = 20 * 1024 * 1024;
/** Local inspection only. Never render active file contents or guess remote copy APIs. */
export async function inspectFile(file) {
  if (!file || !Number.isFinite(file.size) || file.size > MAX_INSPECT_BYTES) throw new DataValidationError('Choose a file no larger than 20 MiB for local inspection.');
  const bytes = await file.arrayBuffer();
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return { name: file.name, size: file.size, contentType: file.type || 'unknown',
    sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''), note: 'Local checksum only; not a server ETag, version or upload precondition.' };
}
