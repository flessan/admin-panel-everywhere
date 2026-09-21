// Form descriptors are client hints only. Telegraph remains the validation engine.
export const FIELD_TYPES = Object.freeze(['text', 'number', 'boolean', 'datetime', 'json', 'file', 'select']);
const aliases = { string: 'text', object: 'json', array: 'json' };
const managed = new Set(['id', 'version', 'created_at', 'updated_at', '_expected_version']);
export class DataValidationError extends Error {
  constructor(message) { super(message); this.name = 'DataValidationError'; }
}
const fail = message => { throw new DataValidationError(message); };
export function editableData(data) {
  return Object.fromEntries(Object.entries(structuredClone(data)).filter(([key]) => !managed.has(key)));
}

export function normalizeSchema(schema) {
  if (schema == null) return { fields: [], formAvailable: false, reason: 'Schema metadata is unavailable. Use the JSON editor; the server still validates writes.' };
  let fields;
  if (Array.isArray(schema)) fields = schema;
  else if (Array.isArray(schema.fields)) fields = schema.fields;
  else if (schema.properties && typeof schema.properties === 'object') {
    // Compatibility with explicitly configured JSON Schema descriptors from phase 2.
    fields = Object.entries(schema.properties).map(([name, field]) => ({ ...field, name,
      type: field.enum ? 'select' : field.format === 'date-time' ? 'datetime' :
        (Object.hasOwn(aliases, field.type) ? aliases[field.type] : field.type),
      options: field.enum ?? field.options, required: schema.required?.includes(name) ?? false }));
  } else fail('Expected a field list, an object with fields, or a JSON Schema properties object.');
  const names = new Set();
  const normalized = fields.filter(field => !managed.has(field?.name)).map(field => {
    if (!field || typeof field.type !== 'string' || typeof field.name !== 'string' || !field.name.length || names.has(field.name)) fail('Schema fields must have unique, nonempty names.');
    names.add(field.name);
    if (field.type === 'select' && (!Array.isArray(field.options) || !field.options.every(value => typeof value === 'string'))) fail('Select fields need a list of string options.');
    return { name: field.name, type: field.type, required: field.required === true, indexed: field.indexed === true,
      options: field.options ?? [], ...(Object.hasOwn(field, 'default') ? { default: structuredClone(field.default) } : {}) };
  });
  const supported = normalized.every(field => FIELD_TYPES.includes(field.type));
  return { fields: normalized, formAvailable: supported,
    reason: supported ? '' : 'This schema contains an unsupported type. Use JSON without converting existing values.' };
}

function checkNumbers(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'number' && !Number.isFinite(item)) fail('JSON numbers must be finite.');
    if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push(child);
  }
}

export function parseDocument(text) {
  let value;
  try { value = JSON.parse(text); } catch { fail('Enter valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('A record must be a JSON object. Nested arrays and values are supported.');
  if (Object.keys(value).some(key => managed.has(key))) fail('ID, version, timestamps and _expected_version are server-managed; remove them from the document body.');
  checkNumbers(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 98304) fail('Document exceeds the documented 96 KiB limit.');
  return value;
}

export function initialDocument(schema, data = {}, useDefaults = false) {
  const result = editableData(data);
  if (useDefaults) for (const field of normalizeSchema(schema).fields) {
    if (!Object.hasOwn(result, field.name) && Object.hasOwn(field, 'default')) {
      Object.defineProperty(result, field.name, { value: structuredClone(field.default), enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

function validValue(field, value) {
  switch (field.type) {
    case 'text': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'datetime': return typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
    case 'select': return field.options.includes(value);
    case 'json': case 'file': return value !== undefined;
    default: return false;
  }
}
export function canUseForm(schema, data) {
  const normalized = normalizeSchema(schema);
  return normalized.formAvailable && normalized.fields.every(field => !Object.hasOwn(data, field.name) || validValue(field, data[field.name]));
}

/** entries is a Map of field names → {included, value}; unmodeled fields survive. */
export function readForm(schema, entries, base = {}) {
  const { fields } = normalizeSchema(schema);
  const result = new Map(Object.entries(editableData(base)));
  for (const field of fields) {
    const entry = entries.get(field.name);
    if (!entry?.included) {
      if (field.required) fail(`Required field: ${field.name}`);
      result.delete(field.name);
      continue;
    }
    let value = entry.value;
    if (field.type === 'number') {
      if (typeof value !== 'string' || !value.trim()) fail(`Enter a number for ${field.name}.`);
      value = Number(value);
    } else if (field.type === 'json' || field.type === 'file') {
      try { value = JSON.parse(value); } catch { fail(`Enter valid JSON for ${field.name}.`); }
    }
    if (!validValue(field, value)) fail(`Invalid ${field.type} value for ${field.name}.`);
    if (field.required && typeof value === 'string' && !value.length) fail(`Required field: ${field.name}`);
    result.set(field.name, value);
  }
  const data = Object.fromEntries(result);
  checkNumbers(data);
  return parseDocument(JSON.stringify(data));
}

export function validateWithSchema(schema, data) {
  const { fields } = normalizeSchema(schema);
  for (const field of fields) {
    if (!Object.hasOwn(data, field.name)) {
      if (field.required && !Object.hasOwn(field, 'default')) fail(`Required field: ${field.name}`);
    } else if (FIELD_TYPES.includes(field.type) && !validValue(field, data[field.name])) fail(`Invalid ${field.type} value for ${field.name}.`);
  }
}

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export function changedFields(original, proposed) {
  const before = editableData(original);
  if (Object.keys(before).some(key => !Object.hasOwn(proposed, key))) fail('Field removal is not documented for PATCH. Keep existing fields; no deletion syntax will be invented.');
  return Object.fromEntries(Object.entries(proposed).filter(([key, value]) => !Object.hasOwn(before, key) || !equal(before[key], value)));
}
