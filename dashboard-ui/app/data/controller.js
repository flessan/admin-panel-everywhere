import { parseDocument, editableData, initialDocument, normalizeSchema, validateWithSchema, changedFields, DataValidationError } from './schema.js';
import { displayError } from './errors.js';

const idleRecords = () => ({ status: 'idle', items: [], hasMore: false, nextCursor: null, error: null, cursors: [null], page: 0, limit: 20, filters: {} });
const idleShare = () => ({ status: 'idle', published: false, shareId: null, url: null, rawUrl: null, createdAt: null, error: null });
const initialState = () => ({ connected: false, collections: { status: 'idle', items: [], source: 'unavailable', complete: false, error: null },
  collection: null, schema: { status: 'idle', schema: null, source: 'unavailable', error: null }, share: idleShare(), records: idleRecords(), editor: null, notice: '' });

/** Transient view state only. All data operations delegate to the active connector. */
export function createDataController({ createKey = () => crypto.randomUUID() } = {}) {
  let connection = null;
  let state = initialState();
  let generation = 0, listRevision = 0, catalogRevision = 0, editorRevision = 0;
  let reads = new AbortController();
  const listeners = new Set();
  const enteredCollections = new Map();
  const sessionSchemas = new Map();
  const emit = () => { for (const listener of listeners) listener(structuredClone(state)); };
  const snapshot = () => structuredClone(state);
  const busy = () => Boolean(state.editor);
  const current = (g, revision) => generation === g && revision === listRevision;

  async function loadCollections() {
    if (!connection) return;
    const g = generation, revision = ++catalogRevision, db = connection.database;
    state.collections.status = 'loading'; state.collections.error = null; emit();
    try {
      const result = await db.listCollections();
      if (g !== generation || revision !== catalogRevision) return;
      const entries = new Map(result.items.map(item => [item.name, item]));
      for (const [name, descriptor] of enteredCollections) if (!entries.has(name)) entries.set(name, descriptor);
      state.collections = { items: [...entries.values()], source: result.source, complete: result.complete,
        status: entries.size ? 'ready' : 'empty', error: null };
    } catch (error) {
      if (g !== generation || revision !== catalogRevision) return;
      state.collections.status = 'error'; state.collections.error = displayError(error);
    }
    emit();
  }

  async function loadPage({ schema = false } = {}) {
    if (!connection || !state.collection) return;
    reads.abort(); reads = new AbortController();
    const signal = reads.signal, g = generation, revision = ++listRevision;
    const name = state.collection, db = connection.database;
    state.records.status = 'loading'; state.records.error = null; state.records.items = [];
    if (schema) state.schema = { status: 'loading', schema: null, source: 'unavailable', error: null };
    emit();
    const schemaTask = schema ? (async () => {
      try {
        const result = sessionSchemas.has(name) ? { schema: sessionSchemas.get(name), source: 'session' } : await db.getCollectionSchema(name);
        normalizeSchema(result.schema);
        if (current(g, revision)) state.schema = { ...result, status: 'ready', error: null };
      } catch (error) {
        if (current(g, revision)) state.schema = { status: 'error', schema: null, source: 'unavailable', error: displayError(error) };
      }
    })() : Promise.resolve();
    const shareTask = (async () => {
      try {
        const method = connection.database.getCollectionShare;
        if (typeof method !== 'function') {
          if (current(g, revision)) state.share = { ...idleShare(), status: 'unavailable' };
          return;
        }
        if (current(g, revision)) state.share = { ...idleShare(), status: 'loading' };
        const result = await method(name, { signal });
        if (current(g, revision)) state.share = { ...idleShare(), ...result, status: 'ready', error: null };
      } catch (error) {
        if (signal.aborted || g !== generation) return;
        if (current(g, revision)) state.share = { ...idleShare(), status: 'error', error: displayError(error) };
      }
    })();
    try {
      const result = await db.listRecords(name, { limit: state.records.limit, cursor: state.records.cursors[state.records.page], filters: state.records.filters, signal });
      if (!current(g, revision)) return;
      state.records = { ...state.records, ...result, status: result.items.length ? 'ready' : 'empty', error: null };
      // A manually entered name is registered only after a successful documented GET.
      if (!state.collections.items.some(item => item.name === name)) {
        const descriptor = { name, schema: null, schemaSource: 'unavailable' };
        enteredCollections.set(name, descriptor);
        state.collections.items.push(descriptor);
        state.collections.status = 'ready';
      }
    } catch (error) {
      if (!current(g, revision)) return;
      state.records.status = 'error'; state.records.error = displayError(error);
    }
    await Promise.all([schemaTask, shareTask]);
    if (current(g, revision)) emit();
  }

  async function loadShare() {
    if (!connection || !state.collection) return;
    const method = connection.database.getCollectionShare;
    if (typeof method !== 'function') {
      state.share = { ...idleShare(), status: 'unavailable' };
      return;
    }
    state.share = { ...idleShare(), status: 'loading' };
    emit();
    try {
      const result = await method(state.collection);
      state.share = { ...idleShare(), ...result, status: 'ready', error: null };
    } catch (error) {
      state.share = { ...idleShare(), status: 'error', error: displayError(error) };
    }
  }

  async function openCollection(name) {
    if (!connection || busy()) return;
    // Validate via connector; never turn a name into a URL in the view/controller.
    state.collection = name; state.records = idleRecords(); state.notice = '';
    await loadPage({ schema: true });
  }
  async function refresh() {
    if (busy()) return;
    state.records.cursors = [null]; state.records.page = 0;
    await loadPage({ schema: true });
  }
  async function page(direction) {
    if (busy() || !['ready', 'empty'].includes(state.records.status)) return;
    if (direction === 'next') {
      if (!state.records.hasMore || !state.records.nextCursor) return;
      state.records.cursors = [...state.records.cursors.slice(0, state.records.page + 1), state.records.nextCursor];
      state.records.page++;
    } else if (direction === 'previous' && state.records.page > 0) state.records.page--;
    else return;
    await loadPage();
  }
  async function setQuery({ filters = {}, limit = state.records.limit } = {}) {
    if (busy()) return;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DataValidationError('Page size must be 1–100.');
    if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).length > 4 || Object.values(filters).some(value => typeof value !== 'string')) {
      throw new DataValidationError('Use at most four exact-match string filters.');
    }
    state.records = { ...idleRecords(), filters: structuredClone(filters), limit };
    await loadPage();
  }

  async function openEditor(mode, id) {
    if (!connection || busy() || !state.collection || !['ready', 'empty'].includes(state.records.status) || state.schema.status === 'loading') return;
    if (!['create', 'edit', 'duplicate', 'delete', 'raw'].includes(mode)) return;
    const revision = ++editorRevision, g = generation, db = connection.database, name = state.collection;
    state.editor = { revision, mode, status: 'loading', record: null, draft: '{}', error: null, conflict: null, latest: null, attempt: null };
    emit();
    try {
      const record = mode === 'create' ? null : await db.getRecord(name, id, { signal: reads.signal });
      if (g !== generation || revision !== editorRevision) return;
      const draft = initialDocument(state.schema.schema, record?.data ?? {}, mode === 'create');
      state.editor = { ...state.editor, status: 'ready', record, draft: JSON.stringify(draft, null, 2) };
    } catch (error) {
      if (g !== generation || revision !== editorRevision) return;
      state.editor.status = 'error'; state.editor.error = displayError(error);
    }
    emit();
  }
  function setDraft(text) { if (state.editor?.status === 'ready') state.editor.draft = text; }
  function closeEditor() {
    if (state.editor?.status === 'saving') return;
    editorRevision++; state.editor = null; emit();
  }

  async function save() {
    const editor = state.editor;
    if (!connection || !editor || editor.status !== 'ready' || editor.conflict || editor.mode === 'raw') return;
    const g = generation, revision = editorRevision, db = connection.database, name = state.collection;
    editor.error = null;
    let payload;
    try {
      if (editor.mode !== 'delete') {
        payload = parseDocument(editor.draft);
        validateWithSchema(state.schema.schema, payload);
        if (editor.mode === 'edit') {
          payload = changedFields(editor.record.data, payload);
          if (!Object.keys(payload).length) throw new DataValidationError('No changes to save.');
        } else {
          const serialized = JSON.stringify(payload);
          if (editor.attempt && editor.attempt.body !== serialized) throw new DataValidationError('A previous create attempt may have succeeded. Retry its unchanged draft, or cancel and refresh before starting another create.');
          editor.attempt ??= { body: serialized, key: createKey() };
        }
      }
    } catch (error) { editor.error = displayError(error); emit(); return; }
    editor.status = 'saving'; emit();
    try {
      if (editor.mode === 'delete') await db.deleteRecord(name, editor.record.id, { expectedVersion: editor.record.version });
      else if (editor.mode === 'edit') await db.updateRecord(name, editor.record.id, payload, { expectedVersion: editor.record.version });
      else await db.createRecord(name, payload, { idempotencyKey: editor.attempt.key });
      if (g !== generation || revision !== editorRevision) return;
      state.notice = editor.mode === 'delete' ? 'Record deleted.' : 'Record saved.';
      state.editor = null; editorRevision++;
      state.records.cursors = [null]; state.records.page = 0;
      await loadPage();
    } catch (error) {
      if (g !== generation || revision !== editorRevision) return;
      editor.status = 'ready';
      if (['edit', 'delete'].includes(editor.mode) && (error?.code === 'version_conflict' || error?.status === 409)) {
        editor.conflict = { currentVersion: error.currentVersion ?? null };
        editor.error = 'Version conflict. Your draft is preserved. Compare the latest record before making another decision.';
      } else {
        editor.error = displayError(error);
        // A definite validation/auth rejection did not create a document; allow correction.
        if ([400, 401, 403, 404, 413, 429].includes(error?.status)) editor.attempt = null;
      }
      emit();
    }
  }

  async function compareLatest() {
    if (!state.editor?.conflict || state.editor.status !== 'ready') return;
    const editor = state.editor, revision = editorRevision, g = generation;
    editor.status = 'loading-latest'; emit();
    try {
      const latest = await connection.database.getRecord(state.collection, editor.record.id, { signal: reads.signal });
      if (g !== generation || revision !== editorRevision) return;
      editor.latest = latest; editor.error = null;
    } catch (error) {
      if (g !== generation || revision !== editorRevision) return;
      editor.error = displayError(error);
    }
    editor.status = 'ready'; emit();
  }
  function useLatest() {
    const editor = state.editor;
    if (!editor?.latest || editor.status !== 'ready') return;
    // Explicit discard/review action; never silently rebase or replay a write.
    editor.record = editor.latest; editor.latest = null; editor.conflict = null; editor.error = null;
    editor.draft = JSON.stringify(editableData(editor.record.data), null, 2); editor.revision = ++editorRevision;
    emit();
  }
  async function publishShare({ regenerate = false } = {}) {
    if (!connection || !state.collection || state.share.status === 'loading' || state.share.status === 'publishing') return state.share;
    const method = connection.database.publishCollectionJson;
    if (typeof method !== 'function') return { ...state.share, status: 'unavailable' };
    const g = generation, name = state.collection;
    state.share.status = 'publishing'; state.share.error = null; emit();
    try {
      const result = await method(name, { regenerate });
      if (g !== generation || state.collection !== name) return result;
      state.share = { ...idleShare(), ...result, status: 'ready', error: null };
      state.notice = regenerate ? 'Public JSON link regenerated.' : 'Collection published as public JSON.';
      emit();
      return state.share;
    } catch (error) {
      if (g !== generation || state.collection !== name) return state.share;
      state.share.status = 'ready'; state.share.error = displayError(error); emit();
      throw error;
    }
  }

  async function revokeShare() {
    if (!connection || !state.collection || !['ready', 'error'].includes(state.share.status) || !state.share.published) return;
    const method = connection.database.revokeCollectionJson;
    if (typeof method !== 'function') return;
    const g = generation, name = state.collection;
    state.share.status = 'publishing'; state.share.error = null; emit();
    try {
      await method(name);
      if (g !== generation || state.collection !== name) return;
      state.share = { ...idleShare(), status: 'ready' };
      state.notice = 'Public JSON link revoked.';
      emit();
    } catch (error) {
      if (g !== generation || state.collection !== name) return;
      state.share.status = 'ready'; state.share.error = displayError(error); emit();
      throw error;
    }
  }

  function applySchema(schema) {
    if (!state.collection || busy()) return;
    normalizeSchema(schema);
    sessionSchemas.set(state.collection, structuredClone(schema));
    state.schema = { status: 'ready', source: 'session', schema: structuredClone(schema), error: null };
    emit();
  }

  return {
    snapshot, subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    async connect(next) {
      reads.abort(); reads = new AbortController(); generation++; listRevision++; editorRevision++;
      connection = next; enteredCollections.clear(); sessionSchemas.clear(); state = initialState(); state.connected = Boolean(next); emit();
      if (next) await loadCollections();
    },
    loadCollections, openCollection, refresh, page, setQuery, openEditor, setDraft, closeEditor, save, compareLatest, useLatest, applySchema,
    loadShare, publishShare, revokeShare,
  };
}
