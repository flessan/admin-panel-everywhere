import { AiInputError } from '../ai/tasks.js';
import { buildRequest } from './request.js';
import { sensitiveName } from '../connection/redaction.js';

/** Backend-neutral view: no route construction, authentication state or network API. */
export function mountApiView(document, controller) {
  const $ = id => document.getElementById(id);
  const node = (tag, text, attrs = {}) => {
    const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    return element;
  };
  const pre = value => node('pre', JSON.stringify(value, null, 2));
  const button = (label, action) => { const element = node('button', label, { type: 'button' }); element.onclick = action; return element; };
  const field = (label, element) => { const wrapper = node('label', label); wrapper.append(element); return wrapper; };
  const schema = (title, value) => { const details = node('details'); details.append(node('summary', title), pre(value)); return details; };
  let state, epoch = -1, renderedOperation = null, inputs = [], copyRevision = 0;
  const tabs = ['overview', 'explorer', 'openapi', 'history'];
  function tab(name) {
    for (const panel of tabs) { $(`api-${panel}-panel`).hidden = panel !== name; $(`api-${panel}-tab`).setAttribute('aria-selected', String(panel === name)); }
  }
  for (const name of tabs) $(`api-${name}-tab`).onclick = () => tab(name);
  $('api-load').onclick = () => controller.load();
  $('api-history-clear').onclick = () => controller.clearHistory();
  $('api-cancel').onclick = () => controller.cancel();
  let draftDirty = false;
  $('api-request-form').addEventListener('input', () => { draftDirty = true; });
  $('api-request-form').addEventListener('change', () => { draftDirty = true; });
  $('api-reset-draft').onclick = () => { if (!state.running) { controller.select(state.selected); renderOperation(state.operations.find(item => item.id === state.selected)); } };
  function collect() {
    return { parameters: inputs.map(({ parameter, include, input }) => ({ name: parameter.name, in: parameter.in, included: include.checked, value: input.value })),
      extraQuery: $('api-extra-query').value, extraHeaders: $('api-extra-headers').value,
      contentType: $('api-content-type').value, bodyText: $('api-body-text').value,
      file: $('api-body-file').files?.[0], allowMutation: $('api-mutation-ack').checked };
  }
  $('api-request-form').onsubmit = event => { event.preventDefault(); const input = collect(); $('api-mutation-ack').checked = false; controller.execute(input); };
  $('api-preview').onclick = () => controller.preview(collect());
  for (const kind of ['curl', 'javascript']) $(`api-copy-${kind}`).onclick = async () => {
    const current = ++copyRevision, currentEpoch = epoch, textarea = $(`api-${kind}`);
    try {
      await document.defaultView.navigator.clipboard.writeText(textarea.value);
      if (current === copyRevision && currentEpoch === epoch) $('api-copy-status').textContent = 'Copied redacted example. Supply placeholders at runtime.';
    } catch {
      if (current !== copyRevision || currentEpoch !== epoch) return;
      textarea.focus(); textarea.select(); $('api-copy-status').textContent = 'Clipboard unavailable. Select and copy the example manually.';
    }
  };
  function bodyMode() {
    const mime = $('api-content-type').value;
    $('api-body-file-label').hidden = mime !== 'application/octet-stream';
    $('api-body-text-label').hidden = !mime || mime === 'application/octet-stream';
    $('api-body-file').value = ''; $('api-body-text').value = '';
  }
  $('api-content-type').onchange = bodyMode;
  function renderOperation(operation) {
    draftDirty = false; renderedOperation = operation?.id ?? null; inputs = []; copyRevision++;
    $('api-request-form').reset(); $('api-parameters').replaceChildren(); $('api-operation-details').replaceChildren();
    $('api-body-schema').replaceChildren(); $('api-content-type').replaceChildren(node('option', 'No body', { value: '' }));
    $('api-copy-status').textContent = '';
    $('api-editor').hidden = !operation;
    if (!operation) { bodyMode(); return; }
    $('api-operation-title').textContent = `${operation.method} ${operation.path}`;
    const details = $('api-operation-details');
    details.append(node('p', operation.summary), node('p', operation.description), node('p', operation.executable
      ? 'Execution allowed by this connector. Authentication is provided by the in-memory connection.'
      : 'Documentation only: the connector does not support execution/signing for this operation. No unsigned or Bearer substitute is generated.'),
    node('h3', 'Authentication requirements'), pre(operation.security.length ? operation.security : 'Public — no authentication required by this operation.'),
    schema('Security schemes', operation.securitySchemes), schema('Documented responses', operation.responses));
    if (operation.deprecated) details.append(node('p', 'Deprecated operation', { class: 'warning' }));
    for (const warning of operation.warnings) details.append(node('p', warning, { class: 'help' }));
    for (const parameter of operation.parameters) {
      const row = node('div', undefined, { class: 'api-parameter' });
      row.append(node('h4', `${parameter.in ?? 'unresolved'} · ${parameter.name || '(dynamic / unnamed parameter)'}${parameter.required ? ' · required' : ''}`),
        node('p', parameter.description ?? ''), schema('Parameter schema / serialization', parameter));
      if (parameter.name && !parameter.$ref && !sensitiveName(parameter.name) && ['path', 'query', 'header'].includes(parameter.in)) {
        const include = node('input', undefined, { type: 'checkbox' }); include.checked = Boolean(parameter.required || parameter.in === 'path');
        include.disabled = include.checked;
        const input = node('input', undefined, { type: 'text', autocomplete: 'off', 'data-parameter': parameter.name, 'data-location': parameter.in });
        row.append(field('Include parameter ', include), field('Value ', input)); inputs.push({ parameter, input, include });
      } else row.append(node('p', sensitiveName(parameter.name) ? 'Credential field: managed by the connection; never entered in a URL.' : 'No automatic editor. Inspect the schema; use extra query only if explicitly documented.', { class: 'help' }));
      $('api-parameters').append(row);
    }
    const contents = operation.requestBody?.content ?? {};
    for (const mime of Object.keys(contents)) $('api-content-type').append(node('option', mime, { value: mime }));
    if (Object.keys(contents).length) $('api-content-type').value = Object.keys(contents)[0];
    $('api-body-schema').append(schema(operation.requestBody?.required ? 'Request body schema · required' : 'Request body schema · optional', operation.requestBody));
    $('api-body-section').hidden = !operation.requestBody;
    $('api-mutation-label').hidden = ['GET', 'HEAD'].includes(operation.method);
    bodyMode();
  }
  function render(next) {
    state = next;
    if (epoch !== state.epoch) {
      epoch = state.epoch; renderedOperation = null; renderOperation(null); tab('overview');
      $('api-search').value = ''; $('api-curl').value = ''; $('api-javascript').value = '';
    }
    $('api-state').textContent = !state.connected ? 'Connect to load the API catalog.' : ({ idle: 'Load the connected backend’s OpenAPI catalog.', loading: 'Loading OpenAPI…', ready: `${state.operations.length} documented operations`, empty: 'No operations in this document.', error: 'OpenAPI could not be loaded.' }[state.status]);
    $('api-source').textContent = state.source ? `Connected origin: ${state.source}` : '';
    $('api-error').textContent = state.error ?? '';
    $('api-load').disabled = !state.connected || state.running || state.status === 'loading';
    $('api-load').textContent = state.document ? 'Reload OpenAPI' : 'Load OpenAPI';
    const operation = state.operations.find(item => item.id === state.selected);
    if ((operation?.id ?? null) !== renderedOperation) renderOperation(operation);
    $('api-request-controls').disabled = state.running || !operation?.executable;
    $('api-cancel').disabled = !state.running;
    $('api-execute').textContent = state.running ? 'Working…' : 'Execute request';
    $('api-overview-summary').textContent = state.document
      ? `${state.document.info?.title ?? 'OpenAPI'} · ${state.document.info?.version ?? ''} — ${state.operations.length} documented, ${state.operations.filter(item => item.executable).length} executable, ${state.operations.filter(item => !item.executable).length} documentation-only.` : 'No API document loaded.';
    $('api-spec').textContent = state.document ? JSON.stringify(state.document, null, 2) : 'Load OpenAPI to inspect the document.';
    renderList();
    for (const kind of ['curl', 'javascript']) {
      $(`api-${kind}`).value = state.examples?.[kind] ?? '';
      $(`api-copy-${kind}`).disabled = !state.examples?.[kind];
    }
    $('api-request-preview').textContent = state.preview ? JSON.stringify(state.preview, null, 2) : 'Generate examples or execute to see the redacted request.';
    $('api-response-status').textContent = state.response ? `HTTP ${state.response.status} · ${state.response.ok ? 'OK' : 'Non-success response'} · ${state.response.bodyKind}` : 'No response yet.';
    $('api-response-headers').textContent = state.response ? JSON.stringify(state.response.headers, null, 2) : '';
    $('api-response-body').textContent = state.response ? (typeof state.response.data === 'string' ? state.response.data : JSON.stringify(state.response.data, null, 2)) : '';
    $('api-history-list').replaceChildren();
    for (const entry of state.history) {
      const row = node('li'); row.append(button(`${entry.timestamp} · ${entry.operation} · ${entry.response.status ?? 'No HTTP response'} · ${entry.elapsedMs} ms`, () => controller.selectHistory(entry.id)));
      $('api-history-list').append(row);
    }
    $('api-history-empty').hidden = state.history.length > 0;
    $('api-history-details').textContent = JSON.stringify(state.history.find(item => item.id === state.historySelected) ?? null, null, 2);
  }
  function renderList() {
    const groups = new Map(), search = $('api-search').value.toLowerCase();
    for (const operation of state.operations) {
      if (!`${operation.method} ${operation.path} ${operation.summary} ${operation.tags.join(' ')}`.toLowerCase().includes(search)) continue;
      for (const tag of operation.tags) { if (!groups.has(tag)) groups.set(tag, []); groups.get(tag).push(operation); }
    }
    $('api-operation-list').replaceChildren();
    for (const [tag, operations] of groups) {
      const group = node('section'), list = node('ul'); group.append(node('h3', tag), list);
      for (const operation of operations) {
        const row = node('li'), choose = button(`${operation.method} ${operation.path}${operation.executable ? '' : ' · docs only'}`, () => controller.select(operation.id));
        choose.dataset.operation = operation.id; choose.disabled = state.running || state.status !== 'ready';
        choose.setAttribute('aria-pressed', String(state.selected === operation.id)); row.append(choose); list.append(row);
      }
      $('api-operation-list').append(group);
    }
    if (!groups.size) $('api-operation-list').append(node('p', 'No matching documented operations.'));
  }
  $('api-search').oninput = renderList;
  const unsubscribe = controller.subscribe(render);
  return { stageRequest(proposal) {
    const operation = state.operations.find(item => item.id === proposal.endpointId);
    if (state.running || state.status !== 'ready' || !operation?.executable || !['GET', 'HEAD'].includes(operation.method)) throw new AiInputError('Load an executable read-only API operation first.');
    if (draftDirty) throw new AiInputError('Reset the existing API request inputs before handing off a new AI draft.');
    const parameters = proposal.parameters.map(parameter => ({ ...parameter, included: true }));
    buildRequest(operation, { parameters });
    controller.select(operation.id); renderOperation(operation);
    for (const field of inputs) {
      const value = parameters.find(parameter => parameter.name === field.parameter.name && parameter.in === field.parameter.in);
      if (value) { field.include.checked = true; field.input.value = String(value.value); }
    }
    draftDirty = true; tab('explorer');
    $('api-copy-status').textContent = 'AI draft staged. Review all inputs, then explicitly preview or execute. No request has been sent.';
  }, enter() { if (state.connected && state.status === 'idle') controller.load(); }, dispose: unsubscribe };
}
