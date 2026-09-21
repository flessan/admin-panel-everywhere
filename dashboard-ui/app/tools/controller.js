import { editableData, parseDocument, normalizeSchema, changedFields, DataValidationError } from '../data/schema.js';
import { displayError } from '../data/errors.js';
import { MAX_RECORDS, importDocuments, exportDocuments, validateDocument, documentDiff } from './documents.js';
const initial = epoch => ({ epoch, connected: false, collection: null, schema: null, schemaSource: 'unavailable', status: 'idle',
  records: [], selected: [], hasMore: false, cursor: null, error: null, notice: '', editor: null, plan: null, running: false, stopping: false, needsReload: false });
const fail = message => { throw new DataValidationError(message); };
function failure(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (status === 409 || error?.code === 'version_conflict') return { code: 'version_conflict', status, currentVersion: Number.isInteger(error?.currentVersion) && error.currentVersion > 0 ? error.currentVersion : null, message: 'Version conflict. Reload and review a NEW plan; this job will not be retried.', retryable: false, uncertain: false, pause: false };
  if (status === 429 || error?.code === 'rate_limited') return { code: 'rate_limited', status, message: 'Rate limited. Wait at least 60 seconds before resuming/retrying.', retryable: true, uncertain: false, pause: true };
  const transient = ['network_error', 'request_timeout', 'request_aborted'].includes(error?.code) || status >= 500;
  return { code: transient ? 'outcome_unknown' : 'request_rejected', status,
    message: transient ? 'Outcome may be unknown. No automatic retry. Retry only this unchanged job, or inspect the backend before discarding.' : displayError(error),
    retryable: transient, uncertain: transient, pause: transient || [401, 403].includes(status) || ['not_connected', 'connection_closed', 'invalid_api_key', 'unauthenticated', 'token_expired', 'invalid_token', 'api_key_scope_forbidden', 'unsupported_operation'].includes(error?.code) };
}
export function createToolsController({ createKey = () => crypto.randomUUID(), spacingMs = 3100, clock = () => Date.now(),
  wait = (ms, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
  }) } = {}) {
  let connection = null, epoch = 0, revision = 0, planRevision = 0, state = initial(0);
  let requests = new AbortController(), pacing = new AbortController(), lastWriteAt = null;
  const listeners = new Set(), seenCursors = new Set();
  const snapshot = () => structuredClone(state), emit = () => { for (const listener of listeners) listener(snapshot()); };
  const locked = () => state.running || state.plan?.jobs.some(job => job.attempts > 0);
  const editable = () => { if (!connection || state.status !== 'ready') fail('Load a collection first.'); if (locked()) fail('Discard the previous plan explicitly before changing inputs.'); if (state.needsReload) fail('Reload the collection after writes or uncertain outcomes before preparing another plan.'); };
  const selected = () => { const records = state.records.filter(record => state.selected.includes(record.id)); if (!records.length) fail('Select at least one record.'); return records; };
  const clearPrepared = () => { state.plan = null; state.error = null; };
  function connect(next) {
    requests.abort(); pacing.abort(); requests = new AbortController(); pacing = new AbortController();
    epoch++; revision++; connection = next; state = initial(epoch); state.connected = Boolean(next); lastWriteAt = null; seenCursors.clear(); emit();
  }
  function useDataPage(data) {
    if (!connection || locked()) fail('Finish or discard the existing plan before using another page.');
    if (!data?.connected || !data.collection || !['ready', 'empty'].includes(data.records?.status) || data.editor) fail('Load a Data page and close its editor first.');
    const records = data.records.items;
    if (!Array.isArray(records) || records.length > MAX_RECORDS || records.some(record => typeof record.id !== 'string' || !record.id || !Number.isInteger(record.version) || record.version < 1 || !record.data || typeof record.data !== 'object' || Array.isArray(record.data))) fail('The Data page has invalid record envelopes.');
    normalizeSchema(data.schema.schema);
    requests.abort(); requests = new AbortController(); revision++; seenCursors.clear();
    state = { ...initial(epoch), connected: true, collection: data.collection, status: 'ready', records: structuredClone(records),
      schema: structuredClone(data.schema.schema), schemaSource: data.schema.source,
      notice: 'Using exactly the current Data page (including its filters), not the whole collection. Refresh that page in Data and use it again for a fresh view. Reload collection here starts an unfiltered first page.' };
    emit();
  }
  async function load(collection, { more = false, schema, schemaSource = 'session' } = {}) {
    if (!connection || locked()) return;
    if (more && (!state.hasMore || state.records.length >= MAX_RECORDS || state.needsReload)) return;
    const current = epoch, version = ++revision, db = connection.database;
    requests.abort(); requests = new AbortController(); const signal = requests.signal;
    state.error = null; clearPrepared(); state.editor = null; state.status = 'loading';
    if (!more) { state.collection = collection; state.records = []; state.selected = []; state.cursor = null; state.hasMore = false; state.schema = null; state.schemaSource = 'unavailable'; seenCursors.clear(); }
    emit();
    try {
      const descriptor = more ? { schema: state.schema, source: state.schemaSource } : schema !== undefined ? { schema, source: schemaSource } : await db.getCollectionSchema(collection);
      if (current !== epoch || version !== revision) return;
      normalizeSchema(descriptor.schema);
      const result = await db.listRecords(collection, { limit: Math.min(20, MAX_RECORDS - state.records.length), cursor: more ? state.cursor : null, signal });
      if (current !== epoch || version !== revision) return;
      if (result.hasMore && (!result.nextCursor || seenCursors.has(result.nextCursor))) fail('Pagination did not advance. Reload before continuing.');
      const merged = new Map(state.records.map(record => [record.id, record]));
      for (const record of result.items) { if (!merged.has(record.id)) merged.set(record.id, structuredClone(record)); }
      if (merged.size > MAX_RECORDS) fail('The connector exceeded the 100-record workspace limit.');
      state.records = [...merged.values()]; state.schema = structuredClone(descriptor.schema); state.schemaSource = descriptor.source;
      state.hasMore = result.hasMore; state.cursor = result.nextCursor; if (result.nextCursor) seenCursors.add(result.nextCursor);
      state.status = 'ready'; state.needsReload = false; state.notice = 'Loaded records are not a transaction snapshot. Versions are checked by the backend on every write.';
    } catch (error) { if (current !== epoch || version !== revision) return; state.status = 'error'; state.error = displayError(error); }
    emit();
  }
  function select(id, included) {
    editable(); if (!state.records.some(record => record.id === id)) return;
    clearPrepared(); state.editor = null;
    state.selected = included ? [...new Set([...state.selected, id])] : state.selected.filter(value => value !== id); emit();
  }
  function selectAll(included) { editable(); clearPrepared(); state.editor = null; state.selected = included ? state.records.map(record => record.id) : []; emit(); }
  function applySchema(schema) { editable(); normalizeSchema(schema); clearPrepared(); state.editor = null; state.schema = structuredClone(schema); state.schemaSource = 'session'; emit(); }
  function invalidate() { if (locked()) return; clearPrepared(); emit(); }
  function plan(kind, jobs) {
    if (!jobs.length || jobs.length > MAX_RECORDS) fail('Prepare between 1 and 100 records.');
    state.plan = { id: ++planRevision, kind, collection: state.collection, retryAt: 0,
      jobs: jobs.map((job, index) => ({ ...job, index: index + 1, status: job.noop ? 'skipped' : 'pending', attempts: 0, error: null })) };
    state.error = null; emit();
  }
  function prepareImport(text, format) {
    editable(); clearPrepared(); const documents = importDocuments(text, format, state.schema);
    plan('import', documents.map(data => ({ method: 'create', data, key: createKey(), diff: documentDiff({}, data) })));
  }
  function prepareBulk(kind, text = '{}') {
    editable(); clearPrepared(); const records = selected();
    if (!['update', 'delete', 'duplicate'].includes(kind)) fail('Unsupported batch action.');
    const patch = kind === 'update' ? parseDocument(text) : null;
    if (patch && !Object.keys(patch).length) fail('Supply at least one top-level field to update.');
    const jobs = records.map(record => {
      const before = editableData(record.data);
      if (kind === 'delete') return { method: 'delete', id: record.id, version: record.version, before };
      if (kind === 'duplicate') { const data = validateDocument(before, state.schema); return { method: 'create', sourceId: record.id, data, key: createKey(), diff: documentDiff({}, data) }; }
      const after = validateDocument({ ...before, ...patch }, state.schema), data = changedFields(before, after);
      return { method: 'update', id: record.id, version: record.version, data, diff: documentDiff(before, after), noop: !Object.keys(data).length };
    });
    plan(kind, jobs);
  }
  async function openJson() {
    editable(); clearPrepared(); const records = selected(); if (records.length !== 1) fail('Select exactly one record for the JSON editor.');
    const current = epoch, version = ++revision, db = connection.database, name = state.collection;
    state.editor = null; state.status = 'loading'; emit();
    try {
      const record = structuredClone(await db.getRecord(name, records[0].id, { signal: requests.signal }));
      if (current !== epoch || version !== revision) return;
      state.records = state.records.map(item => item.id === record.id ? record : item);
      state.editor = { record, draft: JSON.stringify(editableData(record.data), null, 2), revision: version };
      state.status = 'ready';
    } catch (error) { if (current !== epoch || version !== revision) return; state.status = 'ready'; state.error = displayError(error); }
    emit();
  }
  function setDraft(text) { editable(); if (!state.editor) return; clearPrepared(); state.editor.draft = text; emit(); }
  function formatJson() { editable(); if (!state.editor) fail('Load one selected record first.'); const data = validateDocument(parseDocument(state.editor.draft), state.schema); state.editor.draft = JSON.stringify(data, null, 2); clearPrepared(); state.editor.revision++; emit(); }
  function prepareJson() {
    editable(); clearPrepared(); if (!state.editor) fail('Load one selected record first.');
    const { record, draft } = state.editor, data = validateDocument(parseDocument(draft), state.schema), changes = changedFields(record.data, data);
    if (!Object.keys(changes).length) fail('No changes to save.');
    plan('json', [{ method: 'update', id: record.id, version: record.version, data: changes, diff: documentDiff(record.data, data) }]);
  }
  async function run({ confirmed = false, collection, retry = false } = {}) {
    if (!connection || state.running || !state.plan) return;
    if (confirmed !== true || collection !== state.plan.collection) fail('Confirm the exact target collection before executing.');
    if (clock() < state.plan.retryAt) fail('Rate limit cooldown: wait at least 60 seconds before retrying/resuming.');
    const current = epoch, batch = state.plan, db = connection.database;
    const jobs = batch.jobs.filter(job => retry ? job.status === 'failed' && job.error?.retryable : job.status === 'pending');
    if (!jobs.length) return;
    state.running = true; state.stopping = false; state.error = null; pacing = new AbortController(); emit();
    try {
      for (const job of jobs) {
        if (current !== epoch || state.stopping) break;
        const delay = lastWriteAt == null ? 0 : Math.max(0, spacingMs - (clock() - lastWriteAt));
        if (delay) await wait(delay, pacing.signal);
        if (current !== epoch || state.stopping) break;
        job.status = 'running'; job.attempts++; job.error = null; emit(); lastWriteAt = clock();
        try {
          let result;
          if (job.method === 'create') result = await db.createRecord(batch.collection, structuredClone(job.data), { idempotencyKey: job.key, signal: requests.signal });
          else if (job.method === 'update') result = await db.updateRecord(batch.collection, job.id, structuredClone(job.data), { expectedVersion: job.version, signal: requests.signal });
          else result = await db.deleteRecord(batch.collection, job.id, { expectedVersion: job.version, signal: requests.signal });
          if (current !== epoch) return;
          job.status = 'succeeded'; job.resultId = result?.id ?? job.id; state.needsReload = true;
          if (job.method === 'delete') { state.records = state.records.filter(record => record.id !== job.id); state.selected = state.selected.filter(id => id !== job.id); }
          else if (job.method === 'update') state.records = state.records.map(record => record.id === job.id ? structuredClone(result) : record);
        } catch (error) {
          if (current !== epoch) return;
          job.status = 'failed'; job.error = failure(error); state.needsReload = true;
          if (job.error.code === 'rate_limited') batch.retryAt = clock() + 60000;
          if (job.error.pause) { state.notice = 'Batch paused. Inspect results; retry eligible failures or resume pending jobs explicitly.'; emit(); break; }
        }
        emit();
      }
    } finally {
      if (current === epoch) { state.running = false; state.notice = state.stopping ? 'Stopped after the current request. Completed writes were not rolled back.' : 'Review every result. No automatic retries or rollbacks. Discard the plan and reload to see fresh data.'; state.stopping = false; emit(); }
    }
  }
  function discard(confirmed = false) { if (state.running) return; if (locked() && !confirmed) fail('Confirm discarding results and retry keys. Unknown outcomes must be checked in the backend first.'); state.plan = null; state.editor = null; state.error = null; emit(); }
  function exportData(format, scope = 'selected') {
    if (state.running || state.status !== 'ready') fail('Wait for the current operation.');
    if (state.needsReload) fail('Discard the plan and reload before exporting a fresh view.');
    return exportDocuments(scope === 'loaded' ? state.records : selected(), format, state.schema);
  }
  function report() { return state.plan ? structuredClone({ collection: state.plan.collection, kind: state.plan.kind, jobs: state.plan.jobs.map(({ index, id, sourceId, version, status, attempts, resultId, error }) => ({ index, id, sourceId, version, status, attempts, resultId, error })) }) : null; }
  return { connect, snapshot, load, useDataPage, select, selectAll, applySchema, invalidate, prepareImport, prepareBulk, openJson, setDraft, formatJson, prepareJson, run, discard, exportData, report,
    cancel() { if (state.running) { state.stopping = true; pacing.abort(); emit(); } },
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
  };
}
