import { TASKS, POLICY, AiInputError, MAX_AI_BYTES } from './tasks.js';
import { captureScope, contextForModel, scrubPacket, bounded, bytes } from './context.js';
import { validateProposal } from './proposals.js';
import { aiProviders } from './providers.js';
const initial = epoch => ({ epoch, connected: false, status: 'idle', packet: null, output: '', review: null, actionable: false, staged: false, notice: '', error: null });
const fail = message => { throw new AiInputError(message); };

/** No database, no provider transport, no mutation capability. Only a human
 * handoff callback can stage a validated draft in existing workspaces. */
export function createAiController({ getSources, registry = aiProviders, handoff = () => { throw new AiInputError('No review workspace is installed.'); }, timeoutMs = 60000 } = {}) {
  let connection = null, state = initial(0), epoch = 0, revision = 0, prepared = null, accepted = null;
  let pending = new AbortController();
  const listeners = new Set();
  const snapshot = () => structuredClone(state), emit = () => { for (const listener of listeners) listener(snapshot()); };
  function invalidate(notice = 'Context or instructions changed. Prepare and review a new packet.') {
    pending.abort(); pending = new AbortController(); revision++; prepared = null; accepted = null;
    state = { ...initial(epoch), connected: Boolean(connection), notice }; emit();
  }
  const currentScope = () => captureScope(connection, getSources(), prepared?.source ?? 'tools');
  function fresh() {
    if (!prepared || !connection) return false;
    try { return prepared.connection === connection && prepared.signature === JSON.stringify(currentScope()); } catch { return false; }
  }
  function requireFresh() { if (!fresh()) { invalidate('Selection, data, schema, filters or connection changed. Recapture before continuing.'); fail('The reviewed AI context is stale. Prepare it again.'); } }
  function connect(next) { connection = next; epoch++; invalidate('No AI context has been shared.'); }
  function prepare({ task, instructions = '', source = 'tools', ...include } = {}) {
    invalidate('');
    if (!Object.hasOwn(TASKS, task)) fail('Choose a supported AI task.');
    if (typeof instructions !== 'string' || bytes(instructions) > 4096) fail('Instructions must be at most 4 KiB.');
    const scope = captureScope(connection, getSources(), source);
    if (['explain-record', 'transform-json', 'prepare-bulk'].includes(task) && !scope.records.length) fail('Select records in Tools before using this task.');
    if (task === 'transform-json' && scope.records.length !== 1) fail('Select exactly one record for a JSON transform.');
    if (task === 'explain-error' && (!include.includeErrors || !scope.error)) fail('Include an existing API error in the context for explanation.');
    if (task === 'generate-request' && (!include.includeOperations || scope.catalogStatus !== 'ready')) fail('Load OpenAPI and include its operations first.');
    if (task === 'suggest-data' && (!scope.schema || !include.includeSchemas)) fail('Provide and include the working collection schema first.');
    if (['generate-records', 'suggest-data', 'build-filters', 'transform-json', 'prepare-bulk'].includes(task) && (!scope.ready || !scope.collection)) fail('Load the selected working collection before generating an action draft.');
    const context = contextForModel(connection, scope, include);
    if (task === 'generate-request' && !context.openApi.operations.length) fail('Select an API operation first or include all loaded operations.');
    const packet = bounded(scrubPacket(connection, scope, { protocol: 'admin-ai-proposal/v1', policy: POLICY, task,
      instructions: connection.api.sanitize(instructions), context, outputExample: TASKS[task].example }));
    prepared = { connection, source, task, scope, validationScope: { ...scope, operations: scope.operations.filter(operation => context.openApi.operations.some(item => item.id === operation.id)) }, signature: JSON.stringify(scope), packet: structuredClone(packet) };
    state.packet = packet; state.status = 'review'; state.notice = 'Review the exact outgoing packet. Nothing has been sent.'; emit();
  }
  function shareText(confirmed = false) {
    requireFresh(); if (confirmed !== true) fail('Confirm that you reviewed the exact packet before sharing.');
    return JSON.stringify(prepared.packet, null, 2);
  }
  function accept(text) {
    requireFresh(); accepted = null; state.review = null; state.actionable = false; state.output = ''; state.staged = false;
    try {
      const result = validateProposal(text, prepared.task, prepared.validationScope, connection);
      accepted = result.proposal; state.review = scrubPacket(connection, prepared.scope, result.review); state.actionable = result.actionable;
      state.output = JSON.stringify(result.proposal, null, 2); state.status = 'proposal'; state.error = null;
      state.notice = result.actionable ? 'Validated draft only. Review the proposal, then hand it off for normal validation and confirmation.' : 'Explanation only. Nothing will be executed.';
      emit();
    } catch (error) {
      state.status = 'review'; state.error = safeError(error); emit(); throw new AiInputError(state.error);
    }
  }
  function safeError(error) {
    // Adapters have a separate fixed-error path. Only local validation messages
    // may be shown here, and the credential-owning scrubber still guards them.
    const message = ['AiInputError', 'DataValidationError', 'ApiInputError'].includes(error?.constructor?.name) ? error.message : 'AI response or handoff could not be validated. No operation was executed.';
    return connection?.api?.sanitize ? connection.api.sanitize(message) : message;
  }
  function importResponse(text) { if (state.status === 'generating') fail('Cancel the pending provider request before importing a response.'); accept(text); }
  async function generate(providerId, confirmed = false) {
    const prompt = shareText(confirmed);
    if (state.status === 'generating') return;
    const adapter = registry.get(providerId); if (!adapter) fail('Choose an installed provider, or copy the reviewed packet and paste a response manually.');
    const version = ++revision, current = epoch;
    pending.abort(); pending = new AbortController(); const request = pending, signal = request.signal;
    accepted = null; state.status = 'generating'; state.review = null; state.actionable = false; state.output = ''; state.error = null; emit();
    let timer, onAbort;
    try {
      const abort = new Promise((_, reject) => { onAbort = () => reject(new Error()); signal.addEventListener('abort', onAbort, { once: true }); });
      timer = setTimeout(() => request.abort(), timeoutMs);
      // The adapter receives only a reviewed string, never a connector, context
      // source callback, credential getter, mutation tool or permission flag.
      const text = await Promise.race([Promise.resolve().then(() => { if (signal.aborted || version !== revision || current !== epoch) throw new Error(); return adapter.generate({ prompt, signal }); }), abort]);
      if (current !== epoch || version !== revision || signal.aborted) return;
      if (registry.get(providerId) !== adapter) { invalidate('The selected provider changed. Review a new request.'); return; }
      requireFresh();
      if (typeof text !== 'string' || bytes(text) > MAX_AI_BYTES) fail('Provider response must be a bounded JSON string.');
      accept(text);
    } catch {
      if (current !== epoch || version !== revision) return;
      state.status = 'review'; state.error = 'Provider request failed, was cancelled/timed out, or returned an invalid proposal. No operation was executed; no automatic retry.'; emit();
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }
  function stage(confirmed = false) {
    requireFresh();
    if (confirmed !== true || !accepted || !state.actionable || state.staged || state.status === 'generating') fail('Review and acknowledge a valid, unstaged proposal first.');
    // Detach/consume before emitting changes in destination controllers. Source
    // subscriptions must not accidentally re-arm an already handed-off proposal.
    const proposal = structuredClone(accepted), scope = currentScope(), target = connection;
    try {
      const validated = validateProposal(JSON.stringify(proposal), prepared.task, { ...scope, operations: prepared.validationScope.operations }, connection);
      prepared = null; accepted = null; revision++;
      const result = handoff({ proposal: validated.proposal, scope, connection: target });
      if (result && typeof result.then === 'function') fail('AI handoffs must synchronously stage a draft, never execute async operations.');
      state.staged = true; state.actionable = false; state.status = 'staged'; state.notice = 'Draft handed off. Review and confirm it in the destination workspace; AI has not executed a mutation.'; emit();
    } catch (error) { invalidate('Handoff was not completed. Recapture after resolving the workspace state.'); throw new AiInputError(safeError(error)); }
  }
  return { snapshot, connect, prepare, shareText, importResponse, generate, stage, invalidate,
    clearProposal() {
      if (!prepared) return;
      pending.abort(); revision++; accepted = null; state.output = ''; state.review = null; state.actionable = false; state.staged = false; state.error = null; state.status = 'review'; emit();
    },
    sourcesChanged() { if (prepared && !fresh()) invalidate('Workspace context changed. Prepare and review again.'); },
    cancel() { if (state.status === 'generating') { pending.abort(); revision++; state.status = 'review'; state.error = 'AI request cancelled. Late output will be discarded; data already sent cannot be recalled.'; emit(); } },
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
  };
}
