import { buildRequest, ApiInputError } from './request.js';
import { generateExamples } from './examples.js';
import { createRedactor } from '../connection/redaction.js';

const initial = epoch => ({ epoch, connected: false, source: null, status: 'idle', document: null, operations: [], selected: null,
  error: null, running: false, response: null, preview: null, examples: null, history: [], historySelected: null });
const safeError = error => error instanceof ApiInputError ? error.message : ({
  invalid_openapi: 'The service did not return a supported OpenAPI 3.0/3.1 document.',
  unsupported_operation: 'The connector does not permit this documented operation.',
  invalid_request: 'The request violates the connector policy. Check parameters, headers, body and mutation confirmation.',
  network_error: 'Request failed. Check connectivity and backend CORS permissions.',
  request_aborted: 'Request cancelled. A mutation may already have completed; no retry was attempted.',
  request_timeout: 'Request timed out. No automatic retry was attempted.',
}[error?.code] ?? 'API operation failed. No automatic retry was attempted.');

export function createApiController({ clock = () => Date.now(), historyLimit = 50 } = {}) {
  let connection = null, state = initial(0), epoch = 0, revision = 0, historyRevision = 0, sequence = 0;
  let pending = new AbortController();
  const listeners = new Set(), fallback = createRedactor();
  const snapshot = () => structuredClone(state);
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const sanitize = value => connection?.api.sanitize ? connection.api.sanitize(value) : fallback(value);
  function connect(next) {
    pending.abort(); pending = new AbortController(); epoch++; revision++;
    connection = next; state = initial(epoch); state.connected = Boolean(next);
    state.source = next ? sanitize(next.metadata?.baseUrl ?? null) : null; emit();
  }
  async function load() {
    if (!connection || state.running || state.status === 'loading') return;
    const current = epoch, api = connection.api, version = ++revision;
    pending.abort(); pending = new AbortController();
    state.status = 'loading'; state.error = null; state.selected = null; state.preview = null; state.examples = null; state.response = null; emit();
    try {
      const document = await api.discoverOpenApi({ refresh: true, signal: pending.signal });
      if (current !== epoch || version !== revision) return;
      const operations = await api.listEndpoints({ signal: pending.signal });
      if (current !== epoch || version !== revision) return;
      const scrub = api.sanitizeDocument ?? (value => fallback(value, { document: true }));
      state.document = scrub(document); state.operations = scrub(operations).map(operation => ({ ...operation, executable: operation.executable && ['inspect', 'previewRequest', 'sanitize', 'sanitizeDocument'].every(name => typeof api[name] === 'function') })); state.status = operations.length ? 'ready' : 'empty';
    } catch (error) { if (current !== epoch || version !== revision) return; state.status = 'error'; state.error = safeError(error); }
    emit();
  }
  function select(id) {
    if (state.running || state.status !== 'ready' || !state.operations.some(operation => operation.id === id)) return;
    revision++; state.selected = id; state.preview = null; state.examples = null; state.response = null; state.error = null; state.historySelected = null; emit();
  }
  async function perform(input, execute) {
    const operation = state.operations.find(item => item.id === state.selected);
    if (!connection || !operation || state.running) return;
    const api = connection.api, current = epoch, version = ++revision, h = historyRevision;
    const start = clock(); let preview = null;
    state.error = null; state.historySelected = null; state.response = null; state.preview = null; state.examples = null;
    try {
      if (!operation.executable || !api.previewRequest || (execute && !api.inspect)) throw new ApiInputError('This operation is documentation-only for the current connector.');
      const request = buildRequest(operation, input);
      if (execute && !['GET', 'HEAD'].includes(operation.method) && !request.allowMutation) throw new ApiInputError('Confirm execution of this non-read operation.');
      pending.abort(); pending = new AbortController();
      state.running = true; emit();
      // These descriptors are already redacted at the connector boundary.
      preview = await api.previewRequest({ ...request, signal: pending.signal });
      if (current !== epoch || version !== revision) return;
      if (pending.signal.aborted) throw new ApiInputError('Request cancelled. A mutation may already have completed; no retry was attempted.');
      state.preview = preview; state.examples = generateExamples(preview);
      if (execute) {
        const result = await api.inspect({ ...request, signal: pending.signal });
        if (current !== epoch || version !== revision) return;
        if (pending.signal.aborted) throw new ApiInputError('Request cancelled. A mutation may already have completed; no retry was attempted.');
        const response = result;
        state.response = response;
        if (h === historyRevision) state.history.unshift({ id: ++sequence, timestamp: new Date(start).toISOString(), elapsedMs: Math.max(0, clock() - start),
          operation: operation.id, request: preview, response });
      }
    } catch (error) {
      if (current !== epoch || version !== revision) return;
      state.error = safeError(error);
      if (execute && preview && h === historyRevision) state.history.unshift({ id: ++sequence, timestamp: new Date(start).toISOString(), elapsedMs: Math.max(0, clock() - start), operation: operation.id,
        request: preview, response: { status: Number.isInteger(error.status) ? error.status : null, error: state.error } });
    } finally {
      if (current === epoch && version === revision) { state.running = false; state.history = state.history.slice(0, historyLimit); emit(); }
    }
  }
  return { connect, snapshot, load, select, preview: input => perform(input, false), execute: input => perform(input, true),
    cancel() { pending.abort(); },
    clearHistory() { historyRevision++; state.history = []; state.historySelected = null; emit(); },
    selectHistory(id) { state.historySelected = state.history.some(entry => entry.id === id) ? id : null; emit(); },
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
  };
}
