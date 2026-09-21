import { fileError } from './errors.js';
import { createDownloadManager } from './download.js';

export function formatBytes(value) {
  if (!Number.isFinite(value)) return 'Not exposed';
  if (value < 1024) return `${value} B`;
  return `${(value / (value < 1048576 ? 1024 : 1048576)).toFixed(2)} ${value < 1048576 ? 'KiB' : 'MiB'} (${value} bytes)`;
}
export function mountFilesView(document, controller, { downloads = createDownloadManager(document), clipboard = document.defaultView?.navigator.clipboard } = {}) {
  const $ = id => document.getElementById(id);
  const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const button = (label, action, disabled) => { const node = el('button', label); node.type = 'button'; node.disabled = Boolean(disabled); node.onclick = action; return node; };
  let focusBeforeDelete = null;
  let state, lastEpoch = null, lastBucket = null, lastPrefix = null, lastDetails = null;
  const on = (id, action) => { $(id).onclick = action; };
  const report = error => { $('files-local-error').textContent = fileError(error); };
  on('reload-buckets', () => controller.loadBuckets());
  $('open-bucket-form').onsubmit = event => { event.preventDefault(); controller.openBucket($('bucket-input').value.trim()); };
  $('prefix-form').onsubmit = async event => {
    event.preventDefault(); $('files-local-error').textContent = '';
    try { await controller.navigate({ prefix: $('prefix-input').value, delimiter: $('folder-mode').checked ? '/' : '', limit: Number($('files-page-size').value) }); }
    catch (error) { report(error); }
  };
  on('files-refresh', () => controller.refresh());
  on('files-previous', () => controller.page('previous'));
  on('files-next', () => controller.page('next'));
  on('files-root', () => controller.navigate({ prefix: '' }));
  on('files-up', () => { const trimmed = state.prefix.replace(/\/$/, ''); controller.navigate({ prefix: trimmed.slice(0, trimmed.lastIndexOf('/') + 1) }); });
  on('object-refresh', () => controller.openObject(state.details.key));
  $('upload-file').onchange = () => {
    const file = $('upload-file').files[0];
    if (!file) return;
    $('upload-key').value = state.prefix + file.name;
    $('upload-type').value = file.type || 'application/octet-stream';
    $('upload-size').textContent = formatBytes(file.size);
    $('upload-local-error').textContent = file.size > (state.maxObjectBytes ?? Infinity) ? 'File exceeds the 20 MiB upload limit.' : '';
  };
  $('upload-form').onsubmit = async event => {
    event.preventDefault(); $('upload-local-error').textContent = '';
    let metadata;
    try { metadata = JSON.parse($('upload-metadata').value || '{}'); }
    catch { $('upload-local-error').textContent = 'Custom metadata must be a JSON object of string values.'; return; }
    const success = await controller.upload({ bucket: $('upload-bucket').value.trim(), key: $('upload-key').value,
      body: $('upload-file').files[0], contentType: $('upload-type').value, metadata,
      acknowledgeOverwrite: $('upload-ack').checked });
    if (success) { $('upload-file').value = ''; $('upload-size').textContent = ''; $('upload-ack').checked = false; }
  };
  $('download-form').onsubmit = async event => {
    event.preventDefault(); $('files-local-error').textContent = '';
    const epoch = state.epoch;
    const result = await controller.download({ range: $('download-range').value.trim() || undefined });
    if (result && state.epoch === epoch) { try { downloads.save(result); } catch { $('files-local-error').textContent = 'Bytes received, but the browser could not save the download. Try again.'; } }
  };
  on('copy-object-url', async () => {
    try {
      const info = controller.objectUrl(); $('object-url').value = info.url;
      $('copy-result').textContent = 'Authenticated API address only. No credentials are included; this is not a public sharing link.';
      const epoch = state.epoch, key = state.details.key, bucket = state.bucket;
      try {
        if (!clipboard?.writeText) throw new Error();
        await clipboard.writeText(info.url);
        if (state.epoch === epoch && state.details.key === key && state.bucket === bucket) $('copy-result').textContent = 'API address copied. The recipient still needs their own authorized Bearer credential.';
      } catch {
        if (state.epoch === epoch && state.details.key === key && state.bucket === bucket) { $('object-url').focus(); $('object-url').select(); $('copy-result').textContent = 'Clipboard unavailable. Copy the selected credential-free API address manually.'; }
      }
    } catch (error) { report(error); }
  });
  on('delete-object', () => { focusBeforeDelete = $('delete-object'); controller.requestDelete(); });
  on('cancel-object-delete', () => controller.cancelDelete());
  $('delete-object-form').onsubmit = event => { event.preventDefault(); controller.confirmDelete($('delete-object-ack').checked); };
  $('object-delete-dialog').addEventListener('cancel', event => { event.preventDefault(); controller.cancelDelete(); });

  const unsubscribe = controller.subscribe(s => {
    state = s;
    if (lastEpoch !== s.epoch) {
      downloads.clear(); $('upload-form').reset(); $('upload-size').textContent = ''; $('upload-local-error').textContent = '';
      $('files-local-error').textContent = ''; $('bucket-input').value = ''; $('object-url').value = ''; $('copy-result').textContent = '';
      lastBucket = null; lastPrefix = null; lastDetails = null; lastEpoch = s.epoch;
    }
    const busy = s.operation.status === 'busy', blocked = busy || Boolean(s.pendingDelete), loaded = ['ready', 'empty'].includes(s.objects.status);
    if (lastBucket !== s.bucket || lastPrefix !== s.prefix) {
      $('prefix-input').value = s.prefix; $('upload-bucket').value = s.bucket ?? '';
      $('upload-key').value = s.prefix + ($('upload-file').files[0]?.name ?? '');
      lastBucket = s.bucket; lastPrefix = s.prefix;
    }
    $('bucket-state').textContent = ({ idle: 'Connect to browse storage.', loading: 'Loading known buckets…', empty: 'No bucket names configured. Enter an exact bucket name.', ready: `${s.buckets.items.length} known bucket(s) · ${s.buckets.source}`, error: s.buckets.error })[s.buckets.status];
    $('bucket-state').setAttribute('role', s.buckets.status === 'error' ? 'alert' : 'status');
    $('bucket-limit').hidden = s.buckets.complete;
    const discovery = $('bucket-limit').closest('.discovery-note'); if (discovery) discovery.hidden = s.buckets.complete;
    $('bucket-list').replaceChildren();
    for (const item of s.buckets.items) {
      const li = el('li'), action = button(item.name, () => controller.openBucket(item.name), blocked);
      action.className = 'collection-link'; action.setAttribute('aria-current', item.name === s.bucket ? 'page' : 'false'); li.append(action); $('bucket-list').append(li);
    }
    $('reload-buckets').disabled = !s.connected || blocked || s.buckets.status === 'loading';
    $('open-bucket').disabled = !s.connected || blocked;
    $('files-title').textContent = s.bucket ?? 'Choose a bucket';
    $('files-location').textContent = s.bucket ? `${s.bucket} / ${s.prefix || '(root)'}` : 'No bucket selected';
    $('folder-mode').checked = s.delimiter === '/'; $('files-page-size').value = String(s.objects.limit);
    $('prefix-controls').disabled = !s.bucket || blocked || s.objects.status === 'loading';
    $('files-refresh').disabled = !s.bucket || blocked || s.objects.status === 'loading';
    $('files-root').disabled = !s.bucket || !s.prefix || blocked;
    $('files-up').disabled = !s.prefix || blocked;
    $('objects-state').textContent = ({ idle: 'Open a bucket to browse objects.', loading: 'Loading objects…', empty: 'No objects or prefixes match this page.', ready: `${s.objects.items.length} objects and ${s.objects.commonPrefixes.length} prefixes on this page`, error: s.objects.error })[s.objects.status];
    $('objects-state').setAttribute('role', s.objects.status === 'error' ? 'alert' : 'status');
    $('objects-table').setAttribute('aria-busy', String(s.objects.status === 'loading'));
    $('objects-table').replaceChildren();
    const head = el('thead'), hr = el('tr');
    for (const name of ['Object key / prefix', 'Size', 'Content type', 'ETag', 'Version', 'Action']) hr.append(el('th', name));
    head.append(hr); $('objects-table').append(head);
    const body = el('tbody');
    for (const prefix of s.objects.commonPrefixes) {
      const tr = el('tr'), cell = el('td'); cell.colSpan = 6;
      cell.append(button(`Prefix: ${prefix}`, () => controller.navigate({ prefix }), blocked)); tr.append(cell); body.append(tr);
    }
    for (const object of s.objects.items) {
      const tr = el('tr');
      for (const value of [object.key, formatBytes(object.size), object.contentType ?? 'Not provided', object.etag ?? 'Not provided', object.version ?? 'Not provided']) tr.append(el('td', String(value)));
      const actions = el('td'); actions.append(button('Details', () => controller.openObject(object.key), blocked)); tr.append(actions); body.append(tr);
    }
    $('objects-table').append(body);
    $('files-previous').disabled = blocked || !loaded || s.objects.page === 0;
    $('files-next').disabled = blocked || !loaded || !s.objects.hasMore || !s.objects.nextCursor;
    $('files-page').textContent = `Page ${s.objects.page + 1}`;
    $('upload-controls').disabled = !s.connected || blocked;
    $('files-notice').textContent = s.notice;
    $('files-operation').textContent = busy ? `${s.operation.kind} in progress…` : '';
    $('files-error').textContent = s.operation.error ?? '';
    $('transfer-result').textContent = s.transfer ? JSON.stringify(s.transfer, null, 2) : '';
    const selected = s.details.status === 'ready';
    const identity = `${s.epoch}:${s.bucket}:${s.details.key}:${s.details.status}`;
    if (identity !== lastDetails) { $('object-url').value = ''; $('copy-result').textContent = ''; $('download-range').value = ''; lastDetails = identity; }
    $('object-details-title').textContent = s.details.key ?? 'Object details';
    $('object-state').textContent = ({ idle: 'Select an object to read its metadata.', loading: 'Loading object metadata…', error: s.details.error,
      ready: 'Metadata read with HEAD. Missing headers may not be exposed by backend CORS.' })[s.details.status];
    $('object-state').setAttribute('role', s.details.status === 'error' ? 'alert' : 'status');
    $('object-metadata').replaceChildren();
    if (selected) {
      const meta = s.details.metadata;
      for (const [label, value] of Object.entries({ Bucket: s.bucket, Key: s.details.key, Size: formatBytes(meta.size), 'Content type': meta.contentType,
        ETag: meta.etag, 'Object version': meta.version, 'Last modified': meta.lastModified, 'Accept ranges': meta.acceptRanges, 'Custom metadata': JSON.stringify(meta.custom) })) {
        $('object-metadata').append(el('dt', label), el('dd', value == null ? 'Not exposed' : String(value)));
      }
    }
    $('etag-note').textContent = selected && s.details.metadata.etag ? 'Downloads use this exact ETag as If-Match; a changed object produces 412 rather than silently downloading another version.' : 'No ETag is exposed. A download will read the current object without a version condition.';
    $('object-refresh').disabled = !s.details.key || blocked || s.details.status === 'loading';
    $('download-controls').disabled = !selected || blocked;
    $('copy-object-url').disabled = !selected || blocked;
    $('delete-object').disabled = !selected || blocked;
    const dialog = $('object-delete-dialog');
    if (s.pendingDelete) {
      if (!dialog.open) { if (!focusBeforeDelete?.isConnected) focusBeforeDelete = document.activeElement; $('delete-object-ack').checked = false; if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
      $('object-delete-target').textContent = `${s.pendingDelete.bucket} / ${s.pendingDelete.key}`;
      $('object-delete-version').textContent = `Observed version: ${s.pendingDelete.metadata.version ?? 'not exposed'}; ETag: ${s.pendingDelete.metadata.etag ?? 'not exposed'}.`;
      $('object-delete-error').textContent = s.operation.error ?? '';
    } else if (dialog.open) { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); (focusBeforeDelete?.isConnected && !focusBeforeDelete.disabled ? focusBeforeDelete : $('files-title')).focus(); focusBeforeDelete = null; }
    $('confirm-object-delete').disabled = busy; $('cancel-object-delete').disabled = busy;
  });
  return { clearTransfers: () => downloads.clear(), destroy() { unsubscribe(); downloads.clear(); } };
}
