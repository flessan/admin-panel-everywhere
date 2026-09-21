import { AiInputError } from '../ai/tasks.js';
import { createSchemaForm } from './forms.js';
import { normalizeSchema, parseDocument, canUseForm } from './schema.js';
import { displayError } from './errors.js';
import { createSpreadsheet } from './sheet.js';

export function mountDataView(document, controller) {
  const $ = id => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action, disabled = false) => {
    const node = el('button', text); node.type = 'button'; node.disabled = disabled;
    node.addEventListener('click', action); return node;
  };
  let state, editorSignature = null, editorMode = 'json', form = null, schemaSource = null, readyRevision = null;
  const spreadsheet = createSpreadsheet(document, controller);
  let focusBeforeEditor = null, focusBeforeEditorLabel = null;
  const showTab = name => {
    $('records-panel').hidden = name !== 'records'; $('schema-panel').hidden = name !== 'schema';
    $('records-tab').setAttribute('aria-selected', String(name === 'records'));
    $('schema-tab').setAttribute('aria-selected', String(name === 'schema'));
  };
  $('records-tab').onclick = () => showTab('records');
  $('schema-tab').onclick = () => showTab('schema');
  $('reload-collections').onclick = () => controller.loadCollections();
  $('open-collection-form').onsubmit = event => {
    event.preventDefault();
    if (spreadsheet.isDirty()) {
      $('records-state').textContent = 'Save spreadsheet changes before opening another collection.';
      return;
    }
    showTab('records'); controller.openCollection($('collection-input').value.trim());
  };
  $('refresh-records').onclick = () => {
    if (spreadsheet.isDirty()) {
      $('records-state').textContent = 'Save spreadsheet changes before refreshing.';
      return;
    }
    controller.refresh();
  };
  $('create-record').onclick = () => spreadsheet.addRow();
  $('sheet-add-row').onclick = () => spreadsheet.addRow();
  $('sheet-add-column').onclick = () => spreadsheet.addColumn();
  $('sheet-save').onclick = () => spreadsheet.save();
$('publish-json').onclick = () => {
    if (!state?.collection) return;
    renderPublicJsonDialog(state);
    const dialog = $('public-json-dialog');
    if (!dialog.open) (dialog.showModal ? dialog.showModal() : dialog.setAttribute('open', ''));
  };
  $('public-json-close').onclick = () => $('public-json-dialog').close?.();
  $('public-json-dialog').addEventListener('cancel', () => {});
  $('public-json-publish').onclick = async () => {
    try { await controller.publishShare(); } catch { /* state renders the connector error */ }
  };
  $('public-json-regenerate').onclick = async () => {
    try { await controller.publishShare({ regenerate: true }); } catch { /* state renders the connector error */ }
  };
  $('public-json-revoke').onclick = async () => {
    try { await controller.revokeShare(); } catch { /* state renders the connector error */ }
  };
  $('previous-page').onclick = () => controller.page('previous');
  $('next-page').onclick = () => controller.page('next');
  let aiFilters = null;
  const clearAiFilters = () => { aiFilters = null; $('data-ai-filters').hidden = true; $('data-ai-filter-preview').textContent = ''; };
  $('data-ai-discard-filters').onclick = clearAiFilters;
  $('data-ai-apply-filters').onclick = async () => {
    if (!aiFilters || state.editor || !['ready', 'empty'].includes(state.records.status)) return;
    const { filters, limit } = aiFilters; clearAiFilters();
    try { await controller.setQuery({ filters, limit }); } catch (error) { $('filter-error').textContent = displayError(error); }
  };
  $('filter-form').onsubmit = async event => {
    event.preventDefault(); clearAiFilters(); $('filter-error').textContent = '';
    if (spreadsheet.isDirty()) {
      $('filter-error').textContent = 'Save spreadsheet changes before changing filters.';
      return;
    }
    try {
      const field = $('filter-field').value.trim();
      const filters = Object.fromEntries(Object.entries(state.records.filters));
      if (field) Object.defineProperty(filters, field, { value: $('filter-value').value, enumerable: true, configurable: true });
      await controller.setQuery({ filters, limit: Number($('page-size').value) });
    } catch (error) { $('filter-error').textContent = displayError(error); }
  };
  $('clear-filters').onclick = () => { if (spreadsheet.isDirty()) { $('filter-error').textContent = 'Save spreadsheet changes before changing filters.'; return; } clearAiFilters(); $('filter-field').value = ''; $('filter-value').value = ''; controller.setQuery({ filters: {} }); };
  $('schema-form').onsubmit = event => {
    event.preventDefault(); $('schema-error').textContent = '';
    try {
      let schema;
      try { schema = JSON.parse($('schema-input').value); } catch { throw new Error('invalid'); }
      controller.applySchema(schema);
    } catch (error) { $('schema-error').textContent = error.name === 'DataValidationError' ? error.message : 'Enter valid schema JSON.'; }
  };
  $('close-editor').onclick = () => controller.closeEditor();
  $('record-dialog').addEventListener('cancel', event => { event.preventDefault(); controller.closeEditor(); });
  $('record-editor').onsubmit = event => {
    event.preventDefault(); $('editor-local-error').textContent = '';
    if (state.editor.mode !== 'delete') {
      try {
        const draft = editorMode === 'form' ? JSON.stringify(form.read(), null, 2) : $('json-editor').value;
        controller.setDraft(draft);
      } catch (error) { $('editor-local-error').textContent = displayError(error); return; }
    }
    controller.save();
  };
  $('editor-mode').onchange = () => {
    try {
      if (editorMode === 'form') controller.setDraft(JSON.stringify(form.read(), null, 2));
      else { parseDocument($('json-editor').value); controller.setDraft($('json-editor').value); }
      editorMode = $('editor-mode').value;
      editorSignature = null;
      renderEditor(controller.snapshot(), false);
    } catch (error) { $('editor-local-error').textContent = displayError(error); $('editor-mode').value = editorMode; }
  };

  function renderCollections(s) {
    $('collection-state').textContent = ({ idle: 'Connect to load collections.', loading: 'Loading collections…', empty: 'No collection names available.', error: s.collections.error, ready: `${s.collections.items.length} known collection(s)` })[s.collections.status];
    $('collection-state').setAttribute('role', s.collections.status === 'error' ? 'alert' : 'status');
    $('collection-limit').hidden = s.collections.complete;
    const discovery = $('collection-limit').closest('.discovery-note'); if (discovery) discovery.hidden = s.collections.complete;
    $('collection-list').replaceChildren();
    for (const item of s.collections.items) {
      const node = button(item.name, () => { if (spreadsheet.isDirty()) return; showTab('records'); controller.openCollection(item.name); }, Boolean(s.editor) || spreadsheet.isDirty());
      node.className = 'collection-link'; node.setAttribute('aria-current', item.name === s.collection ? 'page' : 'false');
      const li = el('li'); li.append(node); $('collection-list').append(li);
    }
    $('reload-collections').disabled = !s.connected || Boolean(s.editor) || s.collections.status === 'loading';
    $('open-collection').disabled = !s.connected || Boolean(s.editor) || spreadsheet.isDirty();
  }
  function renderRecords(s) {
    const dirty = spreadsheet.isDirty();
    $('collection-title').textContent = s.collection ?? 'Choose a collection';
    renderPublicJsonDialog(s);
    spreadsheet.render(s);
    $('records-state').textContent = ({ idle: 'Open a collection to browse its records.', loading: 'Loading rows…', empty: 'No rows yet — add one to start building this collection.', error: s.records.error, ready: `${s.records.items.length} rows loaded · edit cells directly` })[s.records.status];
    $('records-state').setAttribute('role', s.records.status === 'error' ? 'alert' : 'status');
    $('refresh-records').disabled = !s.collection || dirty || s.records.status === 'loading';
    $('create-record').disabled = !s.collection;
    $('data-tools').disabled = !['ready', 'empty'].includes(s.records.status) || dirty || s.schema.status === 'loading';
    $('previous-page').disabled = dirty || s.records.status === 'loading' || s.records.page === 0;
    $('next-page').disabled = dirty || !['ready', 'empty'].includes(s.records.status) || !s.records.hasMore || !s.records.nextCursor;
    $('page-label').textContent = `Page ${s.records.page + 1}`;
    $('filter-fields').disabled = !s.collection || dirty || s.records.status === 'loading';
    $('page-size').value = String(s.records.limit);
    $('active-filters').textContent = Object.keys(s.records.filters).length ? `Applied: ${JSON.stringify(s.records.filters)}` : 'No filters applied.';
    $('notice').textContent = s.notice;
  }
  function renderPublicJsonDialog(s) {
    const share = s.share || {};
    const dialog = $('public-json-dialog');
    const supported = typeof controller.publishShare === 'function' && ['ready', 'loading', 'publishing', 'error', 'unavailable'].includes(share.status);
    const working = share.status === 'loading' || share.status === 'publishing';
    const published = Boolean(share.published && share.url);
    $('public-json-title').textContent = s.collection ? `Publish JSON · ${s.collection}` : 'Publish JSON';
    $('public-json-description').textContent = published
      ? 'This collection is published as a public, read-only JSON feed. Anyone with the link can read it; no API key is required.'
      : 'Publish this collection as a public, read-only JSON feed. The link is separate from your developer API key.';
    $('public-json-status').textContent = share.status === 'loading' ? 'Checking current publish status…'
      : share.status === 'publishing' ? (published ? 'Updating public link…' : 'Publishing…')
      : share.status === 'error' ? share.error || 'The publish status could not be loaded.'
      : share.status === 'unavailable' ? 'This connector does not expose public JSON publishing.'
      : published ? 'Published and publicly readable.' : 'Not currently published.';
    $('public-json-error').hidden = !(share.error && share.status !== 'error');
    $('public-json-error').textContent = share.error || '';
    $('public-json-published').hidden = !published;
    $('public-json-url').value = published ? share.url : '';
    $('public-json-raw-url').value = published ? share.rawUrl : '';
    $('public-json-copy').dataset.copyText = published ? share.url : '';
    $('public-json-copy-raw').dataset.copyText = published ? share.rawUrl : '';
    $('public-json-copy').disabled = !published || working;
    $('public-json-copy-raw').disabled = !published || working;
    $('public-json-publish').hidden = published;
    $('public-json-regenerate').hidden = !published;
    $('public-json-revoke').hidden = !published;
    for (const id of ['public-json-publish', 'public-json-regenerate', 'public-json-revoke']) $(id).disabled = !supported || working;
    $('public-json-close').disabled = working;
    $('publish-json').disabled = !s.connected || !s.collection || spreadsheet.isDirty() || !['ready', 'empty'].includes(s.records.status) || share.status === 'unavailable';
    $('publish-json-status').textContent = published ? 'Public' : share.status === 'error' ? 'Unavailable' : share.status === 'loading' ? 'Checking…' : '';
  }

  function renderSchema(s) {
    $('schema-state').textContent = s.schema.status === 'loading' ? 'Loading schema…' : s.schema.status === 'error' ? s.schema.error :
      s.schema.schema == null ? 'No authoritative schema metadata available. JSON records remain usable; server validation is authoritative.' : `Schema source: ${s.schema.source}. Session/configured descriptors are hints, not backend schema changes.`;
    $('schema-state').setAttribute('role', s.schema.status === 'error' ? 'alert' : 'status');
    $('schema-json').textContent = JSON.stringify(s.schema.schema, null, 2);
    $('apply-schema').disabled = !s.collection || Boolean(s.editor);
    if (schemaSource !== s.schema.schema && s.schema.status === 'ready') {
      const { fields } = normalizeSchema(s.schema.schema);
      $('indexed-fields').replaceChildren();
      for (const field of fields.filter(field => field.indexed && ['text', 'select'].includes(field.type))) {
        const option = el('option'); option.value = field.name; $('indexed-fields').append(option);
      }
      schemaSource = s.schema.schema;
    }
  }
  function renderEditor(s, resetMode = true) {
    const editor = s.editor, dialog = $('record-dialog');
    if (!editor) {
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
        // Table rows are re-rendered during reads/editor transitions. Restore to
        // the equivalent live action, not the detached button that opened it.
        const action = focusBeforeEditorLabel ? [...$('record-table').querySelectorAll('button')].find(button => button.getAttribute('aria-label') === focusBeforeEditorLabel) : null;
        const target = action ?? (focusBeforeEditor?.isConnected && !focusBeforeEditor.disabled ? focusBeforeEditor : $('collection-title'));
        target.focus(); focusBeforeEditorLabel = null;
      }
      editorSignature = null; readyRevision = null; return;
    }
    if (!dialog.open) {
      focusBeforeEditor = document.activeElement;
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    const signature = JSON.stringify([editor.revision, editor.status, editor.error, editor.conflict, editor.latest]);
    if (signature === editorSignature) return;
    const newEditor = editor.status === 'ready' && readyRevision !== editor.revision;
    if (newEditor) readyRevision = editor.revision;
    editorSignature = signature;
    $('editor-title').textContent = ({ create: 'Create record', edit: 'Edit record', duplicate: 'Duplicate record', delete: 'Delete record', raw: 'Raw record JSON' })[editor.mode];
    $('editor-meta').textContent = editor.record ? `${editor.record.id} · version ${editor.record.version}` : 'The server assigns the ID and version.';
    $('editor-error').textContent = editor.error ?? '';
    $('editor-local-error').textContent = '';
    $('editor-status').textContent = ({ loading: 'Loading current record…', saving: 'Saving…', 'loading-latest': 'Loading latest version…' })[editor.status] ?? '';
    $('editor-content').replaceChildren(); form = null;
    $('editor-controls').hidden = !['create', 'edit', 'duplicate'].includes(editor.mode) || !editor.record && editor.mode !== 'create';
    const editable = ['create', 'edit', 'duplicate'].includes(editor.mode);
    let data = {};
    try { data = parseDocument(editor.draft); } catch { /* Invalid drafts stay visible in JSON mode. */ }
    const formAvailable = canUseForm(s.schema.schema, data) && normalizeSchema(s.schema.schema).fields.length > 0;
    if (resetMode && newEditor) editorMode = formAvailable ? 'form' : 'json';
    if (!formAvailable) editorMode = 'json';
    $('form-mode-option').disabled = !formAvailable;
    $('editor-mode').value = editorMode;
    $('editor-hint').textContent = formAvailable ? 'Optional fields have explicit presence controls. Unmodeled fields are preserved.' : normalizeSchema(s.schema.schema).reason || 'Use JSON for these record values.';
    if (editable) {
      if (editorMode === 'form') {
        form = createSchemaForm(document, s.schema.schema, data); form.revision = editor.revision;
        $('editor-content').append(form.element);
      } else {
        const label = el('label', 'Document JSON'); label.htmlFor = 'json-editor';
        const input = el('textarea'); input.id = 'json-editor'; input.rows = 16; input.spellcheck = false; input.value = editor.draft;
        input.addEventListener('input', () => controller.setDraft(input.value));
        $('editor-content').append(label, input);
      }
    } else if (editor.record) {
      if (editor.mode === 'delete') $('editor-content').append(el('p', 'Delete this record at the version shown? This sends a versioned deletion to Telegraph; it cannot be undone here.', 'warning'));
      const preview = el('pre', JSON.stringify(editor.record, null, 2)); preview.id = 'record-json-preview'; preview.tabIndex = 0;
      const copy = el('button', 'Copy JSON'); copy.type = 'button'; copy.dataset.copyTarget = preview.id; copy.className = 'copy-technical';
      $('editor-content').append(copy, preview);
    }
    $('conflict-panel').replaceChildren();
    if (editor.conflict) {
      const panel = $('conflict-panel');
      panel.append(el('h3', 'Version conflict'), el('p', `Server version: ${editor.conflict.currentVersion ?? 'unknown'}. No automatic retry or overwrite.`));
      panel.append(el('h4', 'Your preserved draft'), el('pre', editor.draft));
      panel.append(button('Compare latest', () => controller.compareLatest(), editor.status !== 'ready'));
      if (editor.latest) {
        panel.append(el('h4', 'Latest server record'), el('pre', JSON.stringify(editor.latest, null, 2)));
        panel.append(button(editor.mode === 'delete' ? 'Review this version for deletion' : 'Discard my draft and edit latest', () => controller.useLatest(), editor.status !== 'ready'));
      }
    }
    $('editor-fields').disabled = !['ready'].includes(editor.status) || Boolean(editor.conflict);
    $('save-record').classList.toggle('danger-outline', editor.mode === 'delete');
    $('save-record').classList.toggle('primary', editor.mode !== 'delete');
    $('save-record').hidden = editor.mode === 'raw';
    $('save-record').textContent = editor.mode === 'delete' ? 'Confirm delete' : editor.mode === 'duplicate' ? 'Create duplicate' : 'Save record';
    $('save-record').disabled = editor.status !== 'ready' || Boolean(editor.conflict);
    $('close-editor').disabled = editor.status === 'saving';
    if (newEditor && editable) $('editor-content').querySelector('textarea:not(:disabled),input:not([type=checkbox]):not(:disabled),select:not(:disabled)')?.focus();
  }
  const dispose = controller.subscribe(s => {
    if (aiFilters && (!s.connected || s.collection !== aiFilters.collection || JSON.stringify(s.schema) !== aiFilters.schema)) clearAiFilters();
    state = s; renderCollections(s); renderRecords(s); renderSchema(s); renderEditor(s);
    $('data-ai-apply-filters').disabled = Boolean(s.editor) || !['ready', 'empty'].includes(s.records.status);
  });
  return { dispose, stageFilters({ filters, limit }) {
    if (aiFilters || state.editor || !['ready', 'empty'].includes(state.records.status)) throw new AiInputError('Close the Data editor, finish loading and discard any pending AI filter draft first.');
    aiFilters = { filters: structuredClone(filters), limit, collection: state.collection, schema: JSON.stringify(state.schema) };
    $('data-ai-filter-preview').textContent = JSON.stringify({ collection: state.collection, filters, limit }, null, 2);
    $('data-ai-filters').hidden = false; showTab('records');
  } };
}
