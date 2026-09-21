import { requireValue } from '../../connection/errors.js';
import { normalizePage, pagination } from './database.js';
import { bucketName } from './routes.js';

export const MAX_OBJECT_BYTES = 20971520;
function normalizeObject(value) {
  requireValue(value && typeof value.bucket === 'string' && typeof value.key === 'string' &&
    Number.isSafeInteger(value.size) && value.size >= 0, 'invalid_response');
  requireValue(value.version === undefined || (Number.isSafeInteger(value.version) && value.version > 0), 'invalid_response');
  requireValue(value.etag === undefined || typeof value.etag === 'string', 'invalid_response');
  requireValue(value.content_type === undefined || typeof value.content_type === 'string', 'invalid_response');
  return { bucket: value.bucket, key: value.key, size: value.size, contentType: value.content_type,
    etag: value.etag, version: value.version, createdAt: value.created_at, updatedAt: value.updated_at };
}
function metadata(headers) {
  const custom = Object.fromEntries([...headers].filter(([name]) => name.startsWith('x-amz-meta-')).map(([name, value]) => [name.slice(11), value]));
  const number = (name, minimum = 0) => {
    const raw = headers.get(name);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= minimum ? value : null;
  };
  return { contentType: headers.get('content-type'), size: number('content-length'),
    etag: headers.get('etag'), version: number('x-telegraph-cloud-object-version', 1),
    lastModified: headers.get('last-modified'), acceptRanges: headers.get('accept-ranges'), custom };
}
function validateRange(range) {
  if (range === undefined) return;
  const match = typeof range === 'string' && /^bytes=(\d*)-(\d*)$/.exec(range);
  requireValue(match && (match[1] || match[2]));
  const start = match[1] ? Number(match[1]) : null, end = match[2] ? Number(match[2]) : null;
  requireValue((start === null || Number.isSafeInteger(start)) && (end === null || Number.isSafeInteger(end)));
  requireValue(start === null ? end > 0 : end === null || end >= start);
}

export function createStorage(routes, { buckets = [], assertOpen = () => {} } = {}) {
  requireValue(Array.isArray(buckets), 'invalid_configuration');
  const known = [...new Set(buckets.map(bucketName))];
  return {
    async listBuckets() {
      assertOpen();
      // No documented remote enumeration endpoint. Never call /api/storage alone.
      return { items: known.map(name => ({ name })), source: 'configured', complete: false };
    },
    getObjectUrl(bucket, key) {
      const url = routes.url('GET /api/storage/{bucket}/{key}', { pathParameters: { bucket, key } });
      return { url, requiresAuthentication: true }; // Address only, not a public or presigned link.
    },
    async listObjects(bucket, { prefix, delimiter, limit = 50, cursor, signal } = {}) {
      requireValue(prefix === undefined || typeof prefix === 'string');
      requireValue(delimiter === undefined || typeof delimiter === 'string');
      const { data } = await routes.request('GET /api/storage/{bucket}', {
        pathParameters: { bucket }, query: { prefix, delimiter, ...pagination({ limit, cursor }) }, signal,
      });
      const commonPrefixes = data?.common_prefixes ?? [];
      requireValue(Array.isArray(commonPrefixes) && commonPrefixes.every(value => typeof value === 'string'), 'invalid_response');
      return { ...normalizePage(data, normalizeObject), commonPrefixes };
    },
    async getObjectMetadata(bucket, key, { signal } = {}) {
      const result = await routes.request('HEAD /api/storage/{bucket}/{key}', { pathParameters: { bucket, key }, signal });
      return { bucket, key, ...metadata(result.headers) };
    },
    async downloadObject(bucket, key, { range, ifMatch, ifNoneMatch, signal } = {}) {
      validateRange(range);
      const headers = {};
      if (range !== undefined) headers.Range = range;
      if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
      if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
      const result = await routes.request('GET /api/storage/{bucket}/{key}', { pathParameters: { bucket, key }, headers, signal });
      requireValue(result.status === 304 || result.data.size <= MAX_OBJECT_BYTES, 'invalid_response');
      return result;
    },
    async uploadObject(bucket, key, body, { contentType = 'application/octet-stream', metadata: custom = {}, signal } = {}) {
      requireValue(body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body));
      const size = body instanceof Blob ? body.size : body.byteLength;
      requireValue(size <= MAX_OBJECT_BYTES && custom && typeof custom === 'object' && !Array.isArray(custom) && Object.keys(custom).length <= 20);
      requireValue(typeof contentType === 'string' && /^[^\s;/]+\/[^\s;/]+(?:\s*;[^\r\n]*)?$/.test(contentType));
      const headers = { 'Content-Type': contentType }, names = new Set();
      for (const [name, value] of Object.entries(custom)) {
        requireValue(/^[a-zA-Z0-9-]+$/.test(name) && typeof value === 'string' && !/[\r\n]/.test(value) && !names.has(name.toLowerCase()));
        names.add(name.toLowerCase()); headers[`x-amz-meta-${name}`] = value;
      }
      const result = await routes.request('PUT /api/storage/{bucket}/{key}', { pathParameters: { bucket, key }, headers, body, signal });
      return normalizeObject(result.data?.data ?? result.data);
    },
    async deleteObject(bucket, key, { signal } = {}) {
      // Storage DELETE has no documented optimistic-write contract. Do not borrow DB preconditions.
      await routes.request('DELETE /api/storage/{bucket}/{key}', { pathParameters: { bucket, key }, signal });
      return { deleted: true };
    },
  };
}
