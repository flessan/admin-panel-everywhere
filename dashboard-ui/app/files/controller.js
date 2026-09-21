import { FileInputError, fileError } from './errors.js';

const emptyObjects = () => ({ status: 'idle', items: [], commonPrefixes: [], hasMore: false, nextCursor: null, cursors: [null], page: 0, limit: 50, error: null });
const emptyDetails = () => ({ status: 'idle', key: null, metadata: null, error: null });
const initial = () => ({ epoch: 0, connected: false, bucket: null, prefix: '', delimiter: '/',
  buckets: { status: 'idle', items: [], source: 'unavailable', complete: false, error: null },
  objects: emptyObjects(), details: emptyDetails(), operation: { status: 'idle', kind: null, error: null },
  pendingDelete: null, notice: '', transfer: null, maxObjectBytes: null });

/** Transient client state. No bytes, credentials or object manifests are persisted. */
export function createFilesController() {
  let connection = null, state = initial(), generation = 0, listRevision = 0, detailRevision = 0, catalogRevision = 0;
  let listAbort = new AbortController(), detailAbort = new AbortController(), transferAbort = new AbortController();
  const listeners = new Set(), entered = new Set();
  const snapshot = () => structuredClone(state);
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const busy = () => state.operation.status === 'busy';
  const blocked = () => busy() || Boolean(state.pendingDelete);
  const addBucket = name => {
    entered.add(name);
    if (!state.buckets.items.some(item => item.name === name)) state.buckets.items.push({ name });
    state.buckets.status = 'ready';
  };
  function clearDetails() { detailAbort.abort(); detailAbort = new AbortController(); detailRevision++; state.details = emptyDetails(); }

  async function loadBuckets() {
    if (!connection || blocked()) return;
    const g = generation, revision = ++catalogRevision, storage = connection.storage;
    state.buckets.status = 'loading'; state.buckets.error = null; emit();
    try {
      const result = storage.listBuckets ? await storage.listBuckets() : { items: [], source: 'unavailable', complete: false };
      if (g !== generation || revision !== catalogRevision) return;
      const names = new Set([...result.items.map(item => item.name), ...entered]);
      state.buckets = { status: names.size ? 'ready' : 'empty', items: [...names].map(name => ({ name })),
        source: result.source, complete: result.complete, error: null };
    } catch (error) {
      if (g !== generation || revision !== catalogRevision) return;
      state.buckets.status = 'error'; state.buckets.error = fileError(error);
    }
    emit();
  }
  async function loadObjects() {
    if (!connection || !state.bucket) return;
    listAbort.abort(); listAbort = new AbortController();
    const g = generation, revision = ++listRevision, bucket = state.bucket, storage = connection.storage;
    state.objects.status = 'loading'; state.objects.error = null; state.objects.items = []; state.objects.commonPrefixes = []; emit();
    try {
      const result = await storage.listObjects(bucket, { prefix: state.prefix, delimiter: state.delimiter || undefined,
        limit: state.objects.limit, cursor: state.objects.cursors[state.objects.page], signal: listAbort.signal });
      if (g !== generation || revision !== listRevision) return;
      state.objects = { ...state.objects, ...result, status: result.items.length || result.commonPrefixes.length ? 'ready' : 'empty', error: null };
      addBucket(bucket);
    } catch (error) {
      if (g !== generation || revision !== listRevision) return;
      state.objects.status = 'error'; state.objects.error = fileError(error);
    }
    emit();
  }
  async function openBucket(bucket) {
    if (!connection || blocked()) return;
    clearDetails(); state.bucket = bucket; state.prefix = ''; state.objects = emptyObjects(); state.notice = ''; state.transfer = null;
    state.operation = { status: 'idle', kind: null, error: null }; await loadObjects();
  }
  async function navigate({ prefix = state.prefix, delimiter = state.delimiter, limit = state.objects.limit } = {}) {
    if (!connection || !state.bucket || blocked()) return;
    if (typeof prefix !== 'string' || !['', '/'].includes(delimiter) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new FileInputError('Use a string prefix and a page size from 1 to 100.');
    clearDetails(); state.prefix = prefix; state.delimiter = delimiter;
    state.objects = { ...emptyObjects(), limit }; state.notice = ''; state.transfer = null;
    await loadObjects();
  }
  async function page(direction) {
    if (blocked() || !['ready', 'empty'].includes(state.objects.status)) return;
    if (direction === 'next' && state.objects.hasMore && state.objects.nextCursor) {
      state.objects.cursors = [...state.objects.cursors.slice(0, state.objects.page + 1), state.objects.nextCursor]; state.objects.page++;
    } else if (direction === 'previous' && state.objects.page > 0) state.objects.page--;
    else return;
    clearDetails(); await loadObjects();
  }
  async function refresh() {
    if (blocked()) return;
    clearDetails(); state.objects.page = 0; state.objects.cursors = [null]; await loadObjects();
  }
  async function openObject(key) {
    if (!connection || !state.bucket || blocked()) return;
    clearDetails();
    const g = generation, revision = detailRevision, storage = connection.storage, bucket = state.bucket;
    state.details = { status: 'loading', key, metadata: null, error: null }; emit();
    try {
      const metadata = await storage.getObjectMetadata(bucket, key, { signal: detailAbort.signal });
      if (g !== generation || revision !== detailRevision) return;
      state.details = { status: 'ready', key, metadata, error: null };
    } catch (error) {
      if (g !== generation || revision !== detailRevision) return;
      state.details = { status: 'error', key, metadata: null, error: fileError(error) };
    }
    emit();
  }
  const begin = kind => { transferAbort.abort(); transferAbort = new AbortController(); state.operation = { kind, status: 'busy', error: null }; state.notice = ''; emit(); };
  const failure = error => { state.operation.status = 'error'; state.operation.error = fileError(error); emit(); };

  async function upload({ bucket, key, body, contentType, metadata = {}, acknowledgeOverwrite = false }) {
    if (!connection || blocked()) return false;
    const g = generation, storage = connection.storage;
    try {
      if (!acknowledgeOverwrite) throw new FileInputError('Acknowledge that PUT can replace an existing object before uploading.');
      if (!body || typeof body.size !== 'number') throw new FileInputError('Choose a file to upload.');
      if (state.maxObjectBytes !== null && body.size > state.maxObjectBytes) throw new FileInputError('File exceeds the 20 MiB upload limit.');
      if (!bucket || !key) throw new FileInputError('Enter an exact bucket and object key.');
      begin('upload');
      await storage.uploadObject(bucket, key, body, { contentType: contentType || body.type || 'application/octet-stream', metadata, signal: transferAbort.signal });
      if (g !== generation) return false;
      state.operation = { kind: 'upload', status: 'success', error: null }; state.notice = 'Object uploaded. The server may have replaced a previous version.';
      addBucket(bucket); clearDetails();
      if (state.bucket !== bucket || !key.startsWith(state.prefix)) state.prefix = key.slice(0, key.lastIndexOf('/') + 1);
      state.bucket = bucket; state.objects.page = 0; state.objects.cursors = [null];
      await loadObjects(); return g === generation;
    } catch (error) { if (g === generation) failure(error); return false; }
  }
  function requestDelete() {
    if (!connection || blocked() || state.details.status !== 'ready') return;
    state.pendingDelete = { bucket: state.bucket, key: state.details.key, metadata: state.details.metadata }; emit();
  }
  function cancelDelete() { if (!busy()) { state.pendingDelete = null; emit(); } }
  async function confirmDelete(confirmed) {
    if (!connection || busy() || !state.pendingDelete || confirmed !== true) return;
    const g = generation, target = state.pendingDelete, storage = connection.storage;
    begin('delete');
    try {
      await storage.deleteObject(target.bucket, target.key, { signal: transferAbort.signal });
      if (g !== generation) return;
      state.pendingDelete = null; clearDetails(); state.operation = { kind: 'delete', status: 'success', error: null };
      state.notice = 'Object deleted.'; state.objects.page = 0; state.objects.cursors = [null]; await loadObjects();
    } catch (error) { if (g === generation) failure(error); }
  }
  async function download({ range, ifNoneMatch } = {}) {
    if (!connection || blocked() || state.details.status !== 'ready') return null;
    const g = generation, bucket = state.bucket, key = state.details.key, storage = connection.storage, etag = state.details.metadata.etag;
    begin('download');
    try {
      const result = await storage.downloadObject(bucket, key, { range: range || undefined,
        ifMatch: ifNoneMatch === undefined ? etag ?? undefined : undefined, ifNoneMatch, signal: transferAbort.signal });
      if (g !== generation) return null;
      if (range && ![206, 304].includes(result.status)) throw new FileInputError('The server did not honor the range request. No download was saved.');
      state.operation = { kind: 'download', status: 'success', error: null };
      state.notice = result.status === 304 ? 'Object not modified. No bytes downloaded.' : result.status === 206 ? 'Partial object downloaded; the filename has a .part suffix.' : 'Object downloaded.';
      state.transfer = { status: result.status, size: result.data?.size ?? 0, contentRange: result.headers.get('content-range'),
        etag: result.headers.get('etag'), version: result.headers.get('x-telegraph-cloud-object-version'), contentType: result.headers.get('content-type') };
      emit();
      return result.status === 304 ? null : { ...result, key, partial: result.status === 206 };
    } catch (error) { if (g === generation) failure(error); return null; }
  }
  function objectUrl() {
    if (!connection || state.details.status !== 'ready' || !connection.storage.getObjectUrl) throw new FileInputError('An object URL is not available for this connection.');
    return connection.storage.getObjectUrl(state.bucket, state.details.key);
  }
  return {
    snapshot, subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    async connect(next) {
      generation++; listRevision++; detailRevision++;
      listAbort.abort(); detailAbort.abort(); transferAbort.abort();
      connection = next; entered.clear(); state = initial(); state.epoch = generation; state.connected = Boolean(next);
      state.maxObjectBytes = next?.metadata?.limits?.objectBytes ?? null; emit();
      if (next) await loadBuckets();
    },
    loadBuckets, openBucket, navigate, page, refresh, openObject, upload, requestDelete, cancelDelete, confirmDelete, download, objectUrl,
  };
}
