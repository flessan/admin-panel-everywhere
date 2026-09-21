import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { normalizeSchema, parseDocument, editableData, changedFields, canUseForm, initialDocument, readForm, validateWithSchema } from '../../dashboard-ui/app/data/schema.js';
import { createSchemaForm } from '../../dashboard-ui/app/data/forms.js';

const schema = { fields: [
  { name: 'Title with spaces', type: 'text', required: true },
  { name: 'count', type: 'number' },
  { name: 'active', type: 'boolean', default: false },
  { name: 'when', type: 'datetime' },
  { name: 'details', type: 'json' },
  { name: 'attachment', type: 'file' },
  { name: 'status', type: 'select', options: ['draft', 'ready'] },
] };
const values = { 'Title with spaces': 'Example', count: 0, active: false, when: '2026-09-21T08:03:10+08:00',
  details: { nested: [0, false, null] }, attachment: { bucket: 'media', key: 'some/key' }, status: 'draft', extra: { unchanged: true } };

test('schema form round-trips all seven supported types, exact names and unmodeled fields', () => {
  const { window } = new JSDOM();
  const form = createSchemaForm(window.document, schema, values);
  assert.deepEqual(form.read(), values);
  assert.equal(form.element.querySelector('[data-field=count]').type, 'number');
  assert.equal(form.element.querySelector('[data-field=active]').type, 'checkbox');
  assert.equal(form.element.querySelector('[data-field=attachment]').tagName, 'TEXTAREA');
  assert.equal(form.element.querySelector('[data-field=status]').tagName, 'SELECT');
  assert.equal(form.element.querySelector('[data-field=when]').value, values.when);
});

test('defaults are create-only and false/zero never turn into missing data', () => {
  const descriptor = [{ name: 'active', type: 'boolean', default: false }, { name: 'count', type: 'number', default: 0 }];
  assert.deepEqual(initialDocument(descriptor, {}, true), { active: false, count: 0 });
  assert.deepEqual(initialDocument(descriptor, {}, false), {});
  assert.deepEqual(initialDocument(descriptor, { active: true }, true), { active: true, count: 0 });
});

test('schema-less JSON preserves null, nested values, arbitrary property names and arrays', () => {
  const data = parseDocument('{"A B":0,"false":false,"nothing":null,"nested":[{"list":[1,2]}]}');
  assert.equal(data['A B'], 0);
  assert.deepEqual(data.nested, [{ list: [1, 2] }]);
  assert.equal(normalizeSchema(null).formAvailable, false);
  assert.throws(() => parseDocument('[]'), /JSON object/);
  assert.throws(() => parseDocument('{"n":1e999}'), /finite/);
  assert.throws(() => parseDocument('oops'), /valid JSON/);
});

test('unsupported types fall back to JSON; no invented type conversion', () => {
  assert.equal(normalizeSchema([{ name: 'value', type: 'relation' }]).formAvailable, false);
  assert.equal(canUseForm([{ name: 'amount', type: 'number' }], { amount: null }), false);
  assert.throws(() => normalizeSchema([{ name: 'a', type: 'text' }, { name: 'a', type: 'number' }]), /unique/);
});

test('required fields, finite numbers, valid datetimes, JSON and select options are checked', () => {
  for (const [field, value] of [
    [{ name: 'x', type: 'text', required: true }, ''],
    [{ name: 'x', type: 'number' }, 'not a number'],
    [{ name: 'x', type: 'datetime' }, '2026-09-21'],
    [{ name: 'x', type: 'json' }, '{invalid}'],
    [{ name: 'x', type: 'select', options: ['a'] }, 'b'],
  ]) assert.throws(() => readForm([field], new Map([['x', { included: true, value }]])));
  assert.throws(() => validateWithSchema([{ name: 'x', type: 'number', required: true }], {}), /Required/);
});

test('optional presence differs from false and empty string', () => {
  const fields = [{ name: 'value', type: 'boolean' }, { name: 'text', type: 'text' }];
  assert.deepEqual(readForm(fields, new Map([['value', { included: true, value: false }], ['text', { included: true, value: '' }]])), { value: false, text: '' });
  assert.deepEqual(readForm(fields, new Map()), {});
});

test('patch generation excludes managed fields, keeps unrelated data and forbids undocumented deletion', () => {
  assert.deepEqual(editableData({ id: 'rec_1', version: 4, _expected_version: 1, created_at: '', title: 'yes' }), { title: 'yes' });
  assert.deepEqual(changedFields({ id: 'rec_1', count: 0, details: { a: 1, b: 2 } }, { count: 0, details: { b: 2, a: 1 } }), {});
  assert.deepEqual(changedFields({ count: 0, title: 'a' }, { count: 0, title: 'b' }), { title: 'b' });
  assert.throws(() => changedFields({ title: 'a' }, {}), /removal/);
  assert.throws(() => parseDocument('{"id":"mine"}'), /server-managed/);
});

test('JSON Schema compatibility maps only supported field types and escapes malicious labels', () => {
  const name = '<img src=x onerror=alert(1)>';
  const legacy = { properties: { [name]: { type: 'string' }, amount: { type: 'number' }, state: { enum: ['draft'] } } };
  assert.deepEqual(normalizeSchema(legacy).fields.map(field => field.type), ['text', 'number', 'select']);
  const dom = new JSDOM();
  const form = createSchemaForm(dom.window.document, legacy, { [name]: '<script>alert(1)</script>' });
  assert.equal(form.element.querySelectorAll('img,script').length, 0);
});

test('JSON and file form values cannot silently turn nonfinite numbers into null', () => {
  for (const type of ['json', 'file']) {
    assert.throws(() => readForm([{ name: 'value', type }], new Map([['value', { included: true, value: '{"number":1e999}' }]])), /finite/);
  }
});

test('prototype-like field names are preserved safely and cannot invent form types', () => {
  const parsed = parseDocument('{"__proto__":{"safe":true},"constructor":0}');
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parsed.__proto__.safe, true);
  assert.equal(normalizeSchema({ properties: { value: { type: 'constructor' } } }).formAvailable, false);
});
