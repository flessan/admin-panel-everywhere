import { editableData, normalizeSchema, parseDocument, validateWithSchema, DataValidationError } from './schema.js';

const managed = new Set(['id', 'version', 'created_at', 'updated_at', '_expected_version']);

function clone(value) {
  return structuredClone(value);
}

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a);
  const right = Object.keys(b);
  return left.length === right.length && left.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function rowSignature(recordPage) {
  return recordPage.items.map((record) => `${record.id}:${record.version}`).join('|');
}

function fieldType(schema, name, value) {
  const field = schema.fields.find((entry) => entry.name === name);
  if (field) return field;
  if (typeof value === 'number') return { name, type: 'number' };
  if (typeof value === 'boolean') return { name, type: 'boolean' };
  if (value && typeof value === 'object') return { name, type: 'json' };
  return { name, type: 'text' };
}

function formatValue(field, value) {
  if (value === undefined || value === null) return '';
  if (field.type === 'boolean') return Boolean(value);
  if (field.type === 'json' || field.type === 'file') return typeof value === 'string' ? value : JSON.stringify(value);
  return String(value);
}

function parseValue(field, raw) {
  if (field.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === '') return undefined;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new DataValidationError(`Enter true or false for ${field.name}.`);
  }
  if (field.type === 'number') {
    if (raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new DataValidationError(`Enter a number for ${field.name}.`);
    return value;
  }
  if (field.type === 'datetime') {
    if (raw === '') return '';
    return raw;
  }
  if (field.type === 'json') {
    if (raw === '') return undefined;
    try { return JSON.parse(raw); } catch { throw new DataValidationError(`Enter valid JSON for ${field.name}.`); }
  }
  return raw;
}

export function createSpreadsheet(document, controller) {
  let state = null;
  let initialized = false;
  let collection = null;
  let sourceSignature = '';
  let rows = [];
  let columns = [];
  let saving = false;
  let lastError = '';
  let focusRequest = null;

  const $ = id => document.getElementById(id);
  const table = $('record-table');

  function schemaFor(s) {
    try { return normalizeSchema(s.schema.schema).fields; } catch { return []; }
  }

  function seed(s) {
    const fields = schemaFor(s).map((field) => ({ ...field }));
    const names = new Set(fields.map((field) => field.name));
    for (const record of s.records.items) {
      for (const [name, value] of Object.entries(editableData(record.data))) {
        if (!managed.has(name) && !names.has(name)) {
          fields.push(fieldType({ fields }, name, value));
          names.add(name);
        }
      }
    }
    columns = fields;
    rows = s.records.items.map((record) => ({
      key: `record:${record.id}`,
      id: record.id,
      version: record.version,
      original: editableData(record.data),
      data: editableData(record.data),
      isNew: false,
      deleted: false,
      status: 'clean',
      error: '',
    }));
    collection = s.collection;
    sourceSignature = rowSignature(s.records);
    initialized = true;
    lastError = '';
  }

  function ensureSeed(s) {
    if (!initialized || collection !== s.collection || (!hasDirty() && sourceSignature !== rowSignature(s.records))) {
      seed(s);
    }
    state = s;
  }

  function hasDirty() {
    return rows.some((row) => row.status === 'dirty' || row.status === 'saving' || row.deleted
      || row.isNew && Object.keys(row.data).length > 0);
  }

  function rowIsDirty(row) {
    return row.deleted || row.status === 'dirty' || row.isNew && !equal(row.data, {});
  }

  function updateToolbar() {
    const dirty = hasDirty();
    const save = $('sheet-save');
    const add = $('sheet-add-row');
    const column = $('sheet-add-column');
    const refresh = $('refresh-records');
    if (save) {
      save.disabled = saving || !dirty;
      save.textContent = saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved';
    }
    if (add) add.disabled = saving || !state?.collection;
    if (column) column.disabled = saving || !state?.collection || schemaFor(state).length > 0;
    if (refresh) refresh.disabled = saving || dirty || !state?.collection || state.records.status === 'loading';
    $('sheet-state').textContent = lastError || (saving ? 'Saving changes…' : dirty ? 'Unsaved changes' : 'All changes saved');
    $('sheet-state').className = lastError ? 'sheet-state is-error' : dirty ? 'sheet-state is-dirty' : 'sheet-state';
  }

  function pasteMatrix(rowIndex, columnIndex, text) {
    const matrix = text.split(/\\r?\\n/).map((line) => line.split('\\t'));
    if (matrix.length === 1 && matrix[0].length === 1) return false;
    while (rows.length < rowIndex + matrix.length) {
      const blank = {};
      for (const field of schemaFor(state)) if (Object.hasOwn(field, 'default')) blank[field.name] = clone(field.default);
      rows.push({
        key: `new:${crypto.randomUUID()}`,
        id: null,
        version: null,
        original: {},
        data: blank,
        isNew: true,
        deleted: false,
        status: 'dirty',
        error: '',
      });
    }
    for (let r = 0; r < matrix.length; r += 1) {
      for (let cIndex = 0; cIndex < matrix[r].length; cIndex += 1) {
        const column = columns[columnIndex + cIndex];
        const row = rows[rowIndex + r];
        if (!column || !row) continue;
        const field = fieldType({ fields: columns }, column.name, row.data[column.name]);
        try {
          setCell(row.key, column.name, parseValue(field, matrix[r][cIndex]));
        } catch (error) {
          row.error = error.message;
          lastError = error.message;
        }
      }
    }
    render();
    focusRequest = { row: Math.min(rows.length - 1, rowIndex + matrix.length - 1), column: Math.min(columns.length - 1, columnIndex + matrix[0].length - 1) };
    return true;
  }

  function makeCell(row, column, rowIndex) {
    const td = document.createElement('td');
    td.dataset.sheetRow = row.key;
    td.dataset.sheetField = column.name;
    td.dataset.sheetCol = String(columns.indexOf(column));

    const field = fieldType({ fields: columns }, column.name, row.data[column.name]);
    if (field.type === 'boolean') {
      const wrapper = document.createElement('label');
      wrapper.className = 'sheet-check-cell';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(row.data[column.name]);
      input.ariaLabel = `${column.name}, row ${rowIndex + 1}`;
      input.addEventListener('change', () => setCell(row.key, column.name, input.checked));
      wrapper.append(input);
      td.append(wrapper);
      return td;
    }

    if (field.type === 'select' && Array.isArray(field.options)) {
      const select = document.createElement('select');
      select.className = 'sheet-cell-input';
      select.dataset.sheetInput = 'true';
      select.setAttribute('aria-label', `${column.name}, row ${rowIndex + 1}`);
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '';
      select.append(empty);
      for (const option of field.options) {
        const node = document.createElement('option');
        node.value = option;
        node.textContent = option;
        select.append(node);
      }
      select.value = formatValue(field, row.data[column.name]);
      select.addEventListener('change', () => setCell(row.key, column.name, select.value));
      td.append(select);
      return td;
    }

    const input = document.createElement('input');
    input.className = 'sheet-cell-input';
    input.dataset.sheetInput = 'true';
    input.type = field.type === 'number' ? 'number' : 'text';
    input.step = field.type === 'number' ? 'any' : undefined;
    input.value = formatValue(field, row.data[column.name]);
    input.placeholder = row.isNew ? '' : ' ';
    input.setAttribute('aria-label', `${column.name}, row ${rowIndex + 1}`);
    input.title = input.value;
    input.addEventListener('input', () => {
      try { setCell(row.key, column.name, parseValue(field, input.value)); }
      catch (error) {
        row.error = error.message;
        lastError = error.message;
        updateToolbar();
      }
    });
    input.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!text.includes('\\t') && !text.includes('\\n')) return;
      const handled = pasteMatrix(rowIndex, columns.indexOf(column), text);
      if (handled) event.preventDefault();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        focusCell(rowIndex + 1, columns.indexOf(column));
      }
    });
    td.append(input);
    return td;
  }

  function render() {
    if (!state || !table) return;
    ensureSeed(state);
    table.replaceChildren();

    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const rowHeader = document.createElement('th');
    rowHeader.className = 'sheet-row-number';
    rowHeader.textContent = '#';
    headerRow.append(rowHeader);
    for (const column of columns) {
      const th = document.createElement('th');
      th.className = 'sheet-field-header';
      th.scope = 'col';
      th.textContent = column.name;
      if (column.required) th.dataset.required = 'true';
      headerRow.append(th);
    }
    const actionHead = document.createElement('th');
    actionHead.className = 'sheet-actions-header';
    actionHead.textContent = '';
    headerRow.append(actionHead);
    head.append(headerRow);
    table.append(head);

    const body = document.createElement('tbody');
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      tr.dataset.sheetRow = row.key;
      if (row.deleted) tr.classList.add('is-deleted');
      if (row.status === 'saving') tr.classList.add('is-saving');
      if (row.error) tr.classList.add('has-error');

      const indexCell = document.createElement('th');
      indexCell.className = 'sheet-row-number';
      indexCell.scope = 'row';
      indexCell.textContent = String(rowIndex + 1);
      tr.append(indexCell);

      for (const column of columns) tr.append(makeCell(row, column, rowIndex));

      const actionCell = document.createElement('td');
      actionCell.className = 'sheet-actions-cell';
      const json = document.createElement('button');
      json.type = 'button';
      json.className = 'sheet-row-action';
      json.textContent = '{}';
      json.title = 'Open JSON editor';
      json.disabled = saving;
      json.addEventListener('click', () => row.id && controller.openEditor('raw', row.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sheet-row-action danger-outline';
      remove.textContent = row.deleted ? 'Undo' : 'Delete';
      remove.disabled = saving;
      remove.addEventListener('click', () => {
        if (row.isNew && !row.id) rows = rows.filter((item) => item.key !== row.key);
        else {
          row.deleted = !row.deleted;
          row.status = row.deleted ? 'dirty' : equal(row.data, row.original) ? 'clean' : 'dirty';
        }
        lastError = '';
        render();
      });
      actionCell.append(json, remove);
      tr.append(actionCell);
      body.append(tr);
    });

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = Math.max(2, columns.length + 2);
      td.className = 'sheet-empty';
      td.textContent = 'No rows yet. Add a row to start building this collection.';
      tr.append(td);
      body.append(tr);
    }

    table.append(body);
    updateToolbar();

    if (focusRequest) {
      const request = focusRequest;
      focusRequest = null;
      queueMicrotask(() => focusCell(request.row, request.column));
    }
  }

  function setCell(rowKey, name, value) {
    const row = rows.find((item) => item.key === rowKey);
    if (!row) return;
    row.data[name] = value;
    row.error = '';
    row.status = equal(row.data, row.original) && !row.deleted ? 'clean' : 'dirty';
    lastError = '';
    updateToolbar();
  }

  function addRow() {
    if (!state?.collection || saving) return;
    const data = {};
    for (const field of schemaFor(state)) {
      if (Object.hasOwn(field, 'default')) data[field.name] = clone(field.default);
    }
    const row = {
      key: `new:${crypto.randomUUID()}`,
      id: null,
      version: null,
      original: {},
      data,
      isNew: true,
      deleted: false,
      status: 'dirty',
      error: '',
    };
    rows.push(row);
    render();
    focusRequest = { row: rows.length - 1, column: 0 };
    queueMicrotask(() => focusCell(rows.length - 1, 0));
  }

  function addColumn() {
    if (!state?.collection || saving) return;
    if (schemaFor(state).length > 0) {
      lastError = 'This collection has an authoritative schema. Add fields from the Schema view before using them here.';
      updateToolbar();
      return;
    }
    const input = $('sheet-column-input');
    const name = input?.value.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(name || '')) {
      lastError = 'Column names use lowercase letters, numbers, and underscores, and must start with a letter.';
      updateToolbar();
      input?.focus();
      return;
    }
    if (managed.has(name) || columns.some((column) => column.name === name)) {
      lastError = `Column "${name}" already exists or is reserved.`;
      updateToolbar();
      input?.focus();
      return;
    }
    columns.push({ name, type: 'text', required: false, indexed: false, options: [] });
    for (const row of rows) row.data[name] = '';
    if (input) input.value = '';
    lastError = '';
    render();
    focusRequest = { row: Math.max(0, rows.length - 1), column: columns.length - 1 };
    queueMicrotask(() => focusCell(Math.max(0, rows.length - 1), columns.length - 1));
  }

  function focusCell(rowIndex, columnIndex) {
    const selector = `tbody tr:not(.sheet-empty) .sheet-cell-input`;
    const inputs = [...table.querySelectorAll(selector)];
    if (!inputs.length) return;
    const row = table.querySelectorAll('tbody tr:not(.sheet-empty)')[rowIndex];
    const cell = row?.querySelectorAll('.sheet-cell-input')[columnIndex];
    cell?.focus();
    cell?.select?.();
  }

  async function save() {
    if (saving || !state?.collection) return;
    lastError = '';
    const changes = { updates: [], creates: [], deletes: [] };

    for (const row of rows) {
      if (!rowIsDirty(row)) continue;
      try {
        const payload = parseDocument(JSON.stringify(row.data));
        validateWithSchema(state.schema.schema, payload);
        if (row.deleted && !row.isNew) {
          changes.deletes.push({ localKey: row.key, id: row.id, version: row.version });
        } else if (row.isNew) {
          if (Object.keys(payload).length === 0) throw new DataValidationError('Enter at least one value before saving a new row.');
          changes.creates.push({ localKey: row.key, data: payload, idempotencyKey: `sheet-${row.key.slice(4)}` });
        } else {
          const before = editableData(row.original);
          const update = Object.fromEntries(Object.entries(payload).filter(([key, value]) => !equal(before[key], value)));
          if (!Object.keys(update).length) {
            row.status = 'clean';
            continue;
          }
          changes.updates.push({ localKey: row.key, id: row.id, version: row.version, data: update });
        }
      } catch (error) {
        row.error = error.message;
        lastError = error.message;
      }
    }

    if (!changes.updates.length && !changes.creates.length && !changes.deletes.length) {
      render();
      return;
    }

    saving = true;
    for (const row of rows) if (rowIsDirty(row)) row.status = 'saving';
    render();

    try {
      const result = await controller.saveSheet(changes);
      const saved = new Map(result.saved.map((entry) => [entry.localKey, entry]));
      for (const row of rows) {
        const entry = saved.get(row.key);
        if (!entry) continue;
        if (entry.kind === 'delete') {
          row.deleted = true;
          row.status = 'clean';
        } else if (entry.kind === 'create') {
          row.id = entry.record.id;
          row.version = entry.record.version;
          row.original = editableData(entry.record.data);
          row.data = editableData(entry.record.data);
          row.isNew = false;
          row.status = 'clean';
          row.error = '';
        } else {
          row.version = entry.record.version;
          row.original = editableData(entry.record.data);
          row.data = editableData(entry.record.data);
          row.status = 'clean';
          row.error = '';
        }
      }
      rows = rows.filter((row) => !(row.deleted && row.status === 'clean' && result.saved.some((entry) => entry.localKey === row.key && entry.kind === 'delete')));
      const failed = result.failed?.length || 0;
      if (failed) lastError = `${failed} change(s) need attention. `;
      else lastError = '';
    } catch (error) {
      lastError = error.message || 'The sheet could not be saved.';
      for (const row of rows) if (row.status === 'saving') row.status = 'dirty';
    } finally {
      saving = false;
      render();
    }
  }

  function renderExternal(s) {
    state = s;
    ensureSeed(s);
    render();
  }

  return {
    render: renderExternal,
    addRow,
    addColumn,
    save,
    isDirty: () => hasDirty(),
  };
}
