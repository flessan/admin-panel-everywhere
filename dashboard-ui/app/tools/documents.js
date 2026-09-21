import { parseDocument, editableData, normalizeSchema, validateWithSchema, changedFields, DataValidationError } from '../data/schema.js';
export const MAX_RECORDS = 100;
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const fail = message => { throw new DataValidationError(message); };
export function checkText(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_INPUT_BYTES) fail('Use a UTF-8 input of at most 5 MiB.');
}
export function validateDocument(value, schema) {
  const pending = [{ item: value, depth: 1 }]; let nodes = 0;
  while (pending.length) {
    const { item, depth } = pending.pop();
    if (++nodes > 10000 || depth > 32) fail('Document exceeds the supported 32-level / 10000-node JSON limit.');
    if (typeof item === 'number' && !Number.isFinite(item)) fail('JSON numbers must be finite.');
    if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push({ item: child, depth: depth + 1 });
  }
  const data = parseDocument(JSON.stringify(value)); validateWithSchema(schema, data); return data;
}
export function csvFields(schema) {
  const { fields, formAvailable } = normalizeSchema(schema);
  if (!formAvailable || !fields.length || fields.some(field => !['text', 'number', 'boolean', 'datetime', 'select'].includes(field.type))) fail('CSV requires a known scalar-only schema. Use JSON for unknown, nested or file fields.');
  return fields;
}
/** Strict RFC-4180-style parsing; preserve quoted commas, CRLF and newlines. */
export function parseCsv(text) {
  checkText(text); text = text.replace(/^\uFEFF/, '');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail('Unsupported CSV control characters. Use JSON instead.');
  const rows = []; let row = [], value = '', quoted = false, closed = false;
  const cell = () => { row.push(value); value = ''; closed = false; if (row.length > 100) fail('CSV supports at most 100 columns.'); };
  const end = () => { cell(); rows.push(row); row = []; if (rows.length > MAX_RECORDS + 1) fail('Import at most 100 records per batch.'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += c; }
    else if (c === ',') cell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; end(); }
    else if (c === '"' && !value && !closed) quoted = true;
    else { if (closed || c === '"') fail('Malformed CSV quoting.'); value += c; }
  }
  if (quoted) fail('Unclosed CSV quote.');
  if (value || closed || row.length || (!rows.length && text)) end();
  return rows;
}
export function importDocuments(text, format, schema) {
  checkText(text); let documents;
  if (format === 'json') {
    try { documents = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('Import must be valid JSON.'); }
    if (!Array.isArray(documents)) fail('JSON import requires an array of document objects, not record envelopes.');
  } else if (format === 'csv') {
    const fields = csvFields(schema), rows = parseCsv(text), names = rows.shift() ?? [];
    if (!names.length || names.some(name => !name) || new Set(names).size !== names.length) fail('CSV needs unique, nonempty column names.');
    if (names.some(name => !fields.some(field => field.name === name))) fail('CSV columns must match the supplied schema; managed and unknown fields are not imported.');
    documents = rows.map(row => {
      if (row.length !== names.length) fail('CSV rows must match the header column count.');
      return Object.fromEntries(names.flatMap((name, i) => {
        const field = fields.find(field => field.name === name); let value = row[i];
        if (value === '' && (['number', 'boolean', 'datetime'].includes(field.type) || (field.type === 'select' && !field.options.includes('')))) return [];
        if (field.type === 'number') {
          if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) fail('CSV numbers must use unambiguous JSON numeric notation.');
          value = Number(value);
          if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('CSV number is not safely representable.');
        } else if (field.type === 'boolean') {
          if (!['true', 'false'].includes(value)) fail('CSV booleans must be true or false.'); value = value === 'true';
        }
        return [[name, value]];
      }));
    });
  } else fail('Choose JSON or CSV.');
  if (!documents.length || documents.length > MAX_RECORDS) fail('Import between 1 and 100 records per batch.');
  return documents.map((data, index) => {
    try { return validateDocument(data, schema); } catch (error) { if (error instanceof DataValidationError) fail(`Row ${index + 1}: ${error.message}`); throw error; }
  });
}
export function exportDocuments(records, format, schema) {
  if (!records.length || records.length > MAX_RECORDS) fail('Choose between 1 and 100 loaded records.');
  const documents = records.map(record => validateDocument(editableData(record.data), null));
  if (format === 'json') return { text: JSON.stringify(documents, null, 2), type: 'application/json', extension: 'json' };
  if (format !== 'csv') fail('Choose JSON or CSV.');
  const fields = csvFields(schema), names = fields.filter(field => documents.some(data => Object.hasOwn(data, field.name))).map(field => field.name);
  if (names.length > 100) fail('CSV supports at most 100 columns. Use JSON instead.');
  if (!names.length || documents.some(data => Object.keys(data).some(key => !names.includes(key)) || names.some(name => !Object.hasOwn(data, name) || data[name] === null))) fail('CSV cannot preserve these unknown, null or unevenly present fields. Export JSON instead.');
  documents.forEach(data => {
    validateWithSchema(schema, data);
    if (Object.values(data).some(value => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))) fail('Use JSON for integers outside the safe CSV numeric range.');
  });
  let escaped = 0;
  const cell = value => {
    let text = String(value);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail('Unsupported CSV control characters. Use JSON instead.');
    if (typeof value === 'string' && (/^[\s\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(text) || /^[\t\r\n]/.test(text))) { text = `'${text}`; escaped++; }
    return `"${text.replace(/"/g, '""')}"`;
  };
  const text = [names.map(cell).join(','), ...documents.map(data => names.map(name => cell(data[name])).join(','))].join('\r\n') + '\r\n';
  return { text, type: 'text/csv;charset=utf-8', extension: 'csv', escaped };
}
/** Top-level replacement diff matches the documented PATCH shape, not JSON Patch. */
export function documentDiff(original, proposed) {
  const changes = changedFields(original, proposed), before = editableData(original);
  return Object.entries(changes).map(([field, after]) => ({ field, operation: Object.hasOwn(before, field) ? 'replace' : 'add',
    ...(Object.hasOwn(before, field) ? { before: before[field] } : {}), after }));
}
