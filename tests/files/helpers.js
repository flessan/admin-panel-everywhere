export const object = { bucket: 'media', key: 'photos/test.txt', size: 3, contentType: 'text/plain', etag: 'opaque-list-tag', version: 4 };
export const meta = { ...object, etag: '"opaque-head-tag"', acceptRanges: 'bytes', lastModified: null, custom: { label: 'fixture' } };
export const page = (items = [object], extra = {}) => ({ items, hasMore: false, nextCursor: null, commonPrefixes: [], ...extra });
export function fakeStorage(overrides = {}) {
  const calls = [];
  const handlers = {
    listBuckets: async () => ({ items: [], source: 'configured', complete: false }),
    listObjects: async () => page(), getObjectMetadata: async () => meta,
    uploadObject: async () => object, deleteObject: async () => ({ deleted: true }),
    downloadObject: async () => ({ data: new Blob(['abc']), status: 200, headers: new Headers({ ETag: meta.etag }) }),
    ...overrides,
  };
  const storage = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, async (...args) => { calls.push({ method, args }); return handler(...args); }]));
  storage.getObjectUrl = () => ({ url: 'https://storage.example/api/storage/media/photos/test.txt', requiresAuthentication: true });
  return { calls, connection: { metadata: { limits: { objectBytes: 20971520 } }, storage } };
}
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; }
