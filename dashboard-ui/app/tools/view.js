import { AiInputError } from '../ai/tasks.js';
import { displayError } from '../data/errors.js';
import { MAX_INPUT_BYTES, MAX_RECORDS, csvFields } from './documents.js';
import { createDownloadManager } from '../files/download.js';
import { inspectFile } from './media.js';

export function mountToolsView(document, controller, { navigate = () => {}, dataContext = () => null, downloads = createDownloadManager(document) } = {}) {
  const $ = id => document.getElementById(id);
  const node = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
  let state, epoch = -1, editorSignature = '', planId = null, readRevision = 0, mediaRevision = 0;
  const sections = ['import', 'export', 'bulk', 'json', 'duplicate', 'api', 'media'];
  function section(name) {
    for (const key of sections) { $(`tools-${key}-panel`).hidden = key !== name; $(`tools-${key}-tab`).setAttribute('aria-selected', String(key === name)); }
  }
  for (const name of sections) $(`tools-${name}-tab`).onclick = () => section(name);
  const act = async action => {
    $('tools-local-error').textContent = '';
    try { await action(); } catch (error) { render(controller.snapshot()); $('tools-local-error').textContent = displayError(error); }
  };
  const invalidate = () => { $('tools-confirm').checked = false; act(() => controller.invalidate()); };
  $('tools-open-form').onsubmit = event => { event.preventDefault(); readRevision++; act(() => controller.load($('tools-collection').value.trim())); };
  $('tools-use-data').onclick = () => act(() => {
    const data = dataContext();
    if (!data?.collection) { $('tools-local-error').textContent = 'Open a Data collection first, or enter its exact name here.'; return; }
    $('tools-collection').value = data.collection;
    readRevision++; return controller.useDataPage(data);
  });
  $('tools-reload').onclick = () => { readRevision++; act(() => controller.load(state.collection, { schema: state.schema, schemaSource: state.schemaSource })); };
  $('tools-more').onclick = () => act(() => controller.load(state.collection, { more: true }));
  $('tools-select-all').onchange = () => act(() => controller.selectAll($('tools-select-all').checked));
  $('tools-schema-form').onsubmit = event => { event.preventDefault(); act(() => {
    let schema; try { schema = JSON.parse($('tools-schema-input').value); } catch { $('tools-local-error').textContent = 'Enter valid schema JSON.'; return; }
    controller.applySchema(schema);
  }); };
  $('tools-import-text').oninput = () => { readRevision++; invalidate(); }; $('tools-import-format').onchange = () => { readRevision++; invalidate(); }; $('tools-patch').oninput = invalidate;
  $('tools-import-file').onchange = async () => {
    invalidate(); const file = $('tools-import-file').files?.[0], current = ++readRevision, connectionEpoch = epoch, collection = state.collection;
    if (!file) return;
    if (file.size > MAX_INPUT_BYTES) { $('tools-local-error').textContent = 'Import files must not exceed 5 MiB.'; return; }
    try {
      const bytes = await file.arrayBuffer(), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (current !== readRevision || connectionEpoch !== epoch || collection !== state.collection || state.running || state.plan?.jobs.some(job => job.attempts)) return;
      $('tools-import-text').value = text; $('tools-import-format').value = /\.csv$/i.test(file.name) ? 'csv' : 'json'; invalidate();
    } catch { if (current === readRevision && connectionEpoch === epoch) $('tools-local-error').textContent = 'Unable to read a UTF-8 import file.'; }
  };
  $('tools-prepare-import').onclick = () => act(() => controller.prepareImport($('tools-import-text').value, $('tools-import-format').value));
  $('tools-prepare-update').onclick = () => act(() => controller.prepareBulk('update', $('tools-patch').value));
  $('tools-prepare-delete').onclick = () => act(() => controller.prepareBulk('delete'));
  $('tools-prepare-duplicate').onclick = () => act(() => controller.prepareBulk('duplicate'));
  $('tools-load-json').onclick = () => act(() => controller.openJson());
  $('tools-json-input').oninput = () => { $('tools-confirm').checked = false; act(() => controller.setDraft($('tools-json-input').value)); };
  $('tools-format-json').onclick = () => act(() => controller.formatJson());
  $('tools-prepare-json').onclick = () => act(() => controller.prepareJson());
  function execute(retry) {
    const confirmed = $('tools-confirm').checked, collection = $('tools-confirm-collection').value;
    $('tools-confirm').checked = false; act(() => controller.run({ confirmed, collection, retry }));
  }
  $('tools-run').onclick = () => execute(false); $('tools-retry').onclick = () => execute(true);
  $('tools-stop').onclick = () => controller.cancel();
  $('tools-discard').onclick = () => act(() => { controller.discard($('tools-discard-ack').checked); $('tools-discard-ack').checked = false; });
  $('tools-export-download').onclick = () => act(() => {
    const result = controller.exportData($('tools-export-format').value, $('tools-export-scope').value);
    downloads.save({ data: new Blob([result.text], { type: result.type }), key: `${state.collection}-documents.${result.extension}` });
    $('tools-export-notice').textContent = `Exported ${$('tools-export-scope').value === 'loaded' ? state.records.length : state.selected.length} loaded records.${result.escaped ? ` ${result.escaped} CSV cells were prefixed with an apostrophe for spreadsheet safety; use JSON for an exact round trip.` : ''}`;
  });
  $('tools-report-download').onclick = () => act(() => {
    const report = controller.report(); if (report) downloads.save({ data: new Blob([JSON.stringify(report, null, 2)]), key: `${state.collection}-operation-report.json` });
  });
  $('tools-open-api').onclick = () => navigate('api'); $('tools-open-files').onclick = () => navigate('files');
  $('tools-media-file').onchange = async () => {
    const current = ++mediaRevision, connectionEpoch = epoch; $('tools-media-result').textContent = 'Inspecting locally…';
    try {
      const info = await inspectFile($('tools-media-file').files?.[0]);
      if (current === mediaRevision && connectionEpoch === epoch) $('tools-media-result').textContent = JSON.stringify(info, null, 2);
    } catch (error) { if (current === mediaRevision && connectionEpoch === epoch) $('tools-media-result').textContent = displayError(error); }
  };
  function render(next) {
    state = next;
    if (state.epoch !== epoch) {
      epoch = state.epoch; readRevision++; mediaRevision++; downloads.clear(); editorSignature = ''; planId = null;
      for (const id of ['tools-collection', 'tools-import-text', 'tools-schema-input', 'tools-json-input', 'tools-confirm-collection', 'tools-import-file', 'tools-media-file']) $(id).value = '';
      $('tools-patch').value = '{}'; $('tools-confirm').checked = false; $('tools-discard-ack').checked = false;
      for (const id of ['tools-local-error', 'tools-export-notice', 'tools-media-result']) $(id).textContent = '';
    }
    const locked = state.running || state.plan?.jobs.some(job => job.attempts > 0), ready = state.status === 'ready';
    $('tools-state').textContent = !state.connected ? 'Connect to use remote productivity tools.' : `${state.collection ?? 'Choose a collection'} · ${state.status} · ${state.records.length} loaded · ${state.selected.length} selected${state.hasMore ? ' · more records exist' : ''}${state.needsReload ? ' · reload required after writes' : ''}`;
    $('tools-error').textContent = state.error ?? ''; $('tools-notice').textContent = state.notice;
    $('tools-context-controls').disabled = !state.connected || locked || state.status === 'loading';
    $('tools-reload').disabled = !state.collection || locked || state.status === 'loading';
    $('tools-more').disabled = !ready || !state.hasMore || locked || state.needsReload || state.records.length >= MAX_RECORDS;
    $('tools-inputs').disabled = !ready || locked || state.needsReload;
    $('tools-select-all').disabled = !ready || locked || state.needsReload || !state.records.length;
    $('tools-select-all').checked = Boolean(state.records.length) && state.selected.length === state.records.length;
    $('tools-select-all').indeterminate = state.selected.length > 0 && state.selected.length < state.records.length;
    $('tools-schema-state').textContent = `Schema: ${state.schemaSource}. Session/configured metadata is advisory; backend validation remains authoritative.`;
    try { csvFields(state.schema); $('tools-csv-state').textContent = 'CSV available for scalar fields; null, nested and uneven records may still require JSON.'; }
    catch { $('tools-csv-state').textContent = 'CSV requires an explicit scalar-only schema. JSON remains available.'; }
    const focusedRecord = document.activeElement?.dataset.record;
    const table = $('tools-records'); table.replaceChildren();
    const head = node('thead'), header = node('tr'); for (const label of ['Select', 'Record ID', 'Reviewed version', 'Document preview']) header.append(node('th', label)); head.append(header); table.append(head);
    const body = node('tbody');
    for (const record of state.records) {
      const row = node('tr'), cell = node('td'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.includes(record.id);
      checkbox.disabled = !ready || locked || state.needsReload; checkbox.setAttribute('aria-label', `Select ${record.id}`); checkbox.dataset.record = record.id;
      checkbox.onchange = () => act(() => controller.select(record.id, checkbox.checked)); cell.append(checkbox); row.append(cell, node('td', record.id), node('td', String(record.version)), node('td', JSON.stringify(record.data).slice(0, 240))); body.append(row);
    }
    table.append(body);
    if (focusedRecord) [...table.querySelectorAll('input')].find(input => input.dataset.record === focusedRecord)?.focus();
    const signature = state.editor ? `${state.editor.revision}:${state.editor.record.id}` : '';
    if (signature !== editorSignature) { editorSignature = signature; $('tools-json-input').value = state.editor?.draft ?? ''; }
    $('tools-json-meta').textContent = state.editor ? `${state.editor.record.id} · expected version ${state.editor.record.version}` : 'Select one record and load its current version.';
    $('tools-json-input').disabled = !state.editor || locked;
    $('tools-format-json').disabled = !state.editor || locked; $('tools-prepare-json').disabled = !state.editor || locked;
    $('tools-plan').hidden = !state.plan;
    if (planId !== state.plan?.id) { planId = state.plan?.id; $('tools-confirm').checked = false; $('tools-confirm-collection').value = ''; $('tools-discard-ack').checked = false; }
    $('tools-progress').replaceChildren(); $('tools-diff').replaceChildren(); $('tools-results').replaceChildren();
    if (state.plan) {
      const { jobs, collection, kind } = state.plan, completed = jobs.filter(job => ['succeeded', 'failed', 'skipped'].includes(job.status)).length;
      $('tools-plan-title').textContent = `${kind} · ${jobs.length} records · ${collection}`;
      const progress = node('progress'); progress.max = jobs.length; progress.value = completed; progress.setAttribute('aria-label', 'Completed batch jobs');
      $('tools-progress').append(progress, node('span', ` ${completed}/${jobs.length} processed · ${jobs.filter(job => job.status === 'succeeded').length} succeeded · ${jobs.filter(job => job.status === 'failed').length} failed${state.stopping ? ' · stopping after current request' : state.running ? ' · running (paced)' : ''}`));
      for (const job of jobs) {
        const detail = node('details'); detail.open = kind === 'json'; detail.append(node('summary', `Row ${job.index} · ${job.method} · ${job.id ?? job.sourceId ?? 'new server ID'}${job.version ? ` · expected version ${job.version}` : ''}`), node('pre', JSON.stringify(job.method === 'delete' ? { delete: job.before } : job.diff, null, 2))); $('tools-diff').append(detail);
        $('tools-results').append(node('li', `Row ${job.index}: ${job.status} · attempts ${job.attempts}${job.resultId ? ` · ${job.resultId}` : ''}${job.error ? ` · ${job.error.message}` : ''}`));
      }
      $('tools-run').textContent = jobs.some(job => job.attempts) ? 'Resume pending jobs' : 'Execute reviewed plan';
      $('tools-run').disabled = state.running || !jobs.some(job => job.status === 'pending');
      $('tools-retry').disabled = state.running || !jobs.some(job => job.status === 'failed' && job.error?.retryable);
    }
    $('tools-stop').disabled = !state.running; $('tools-discard').disabled = state.running;
    $('tools-confirm').disabled = state.running; $('tools-confirm-collection').disabled = state.running;
    $('tools-export-download').disabled = !ready || state.running || state.needsReload;
  }
  const unsubscribe = controller.subscribe(render);
  return { stageAi(proposal, dataPage = null) {
    if (state.running || state.plan || state.editor || $('tools-import-text').value.trim() || $('tools-import-file').value || !['', '{}'].includes($('tools-patch').value.trim()) || $('tools-schema-input').value.trim()) {
      throw new AiInputError('Finish or explicitly clear the existing Tools plan, editor, import, patch and schema drafts first. AI will not overwrite them.');
    }
    readRevision++; $('tools-confirm').checked = false; $('tools-confirm-collection').value = '';
    if (dataPage) controller.useDataPage(dataPage);
    if (proposal.kind === 'create-records') {
      controller.prepareImport(JSON.stringify(proposal.documents), 'json'); section('import');
    } else if (['transform-json', 'bulk-edit'].includes(proposal.kind)) {
      controller.prepareBulk('update', JSON.stringify(proposal.changes)); section('bulk');
    } else throw new AiInputError('Unsupported Tools proposal.');
  }, dispose() { unsubscribe(); downloads.clear(); readRevision++; mediaRevision++; } };
}
