import test from 'node:test';
import assert from 'node:assert/strict';
import { importDocuments, exportDocuments, parseCsv, documentDiff, MAX_INPUT_BYTES } from '../../dashboard-ui/app/tools/documents.js';
const schema = [{ name: 'title', type: 'text', required: true }, { name: 'count', type: 'number' }, { name: 'active', type: 'boolean' }];

test('JSON import preserves nested values and rejects envelopes, invalid documents, non-finite numbers and oversized batches', () => {
  assert.deepEqual(importDocuments('[{"nested":[null,false,4],"title":"x"}]', 'json', null), [{ nested: [null, false, 4], title: 'x' }]);
  for (const input of ['{}', '[]', '[null]', '[1]', '[{"id":"managed"}]', '[{"version":2}]', '[{"n":1e999}]', '[']) assert.throws(() => importDocuments(input, 'json', null));
  assert.throws(() => importDocuments(JSON.stringify(Array.from({ length: 101 }, () => ({}))), 'json', null), /100/);
  assert.throws(() => importDocuments(' '.repeat(MAX_INPUT_BYTES + 1), 'json', null), /5 MiB/);
  assert.throws(() => importDocuments('[{"title":5}]', 'json', schema), /Row 1/);
});

test('CSV parser handles BOM, CRLF, quoted commas, quotes and embedded lines; rejects malformed structure', () => {
  assert.deepEqual(parseCsv('\uFEFFtitle,count\r\n"a,\r\n""quoted""",12\r\n'), [['title', 'count'], ['a,\r\n"quoted"', '12']]);
  for (const input of ['a\n"unclosed', 'a\n"x"bad', 'a\na"b']) assert.throws(() => parseCsv(input));
  for (const input of ['title,title\nx,y', 'title,count\nx', ',count\nx,1', 'unknown\nx']) assert.throws(() => importDocuments(input, 'csv', schema));
});

test('CSV schema-guided conversion does not guess booleans, empty numeric values or ambiguous numbers', () => {
  assert.deepEqual(importDocuments('title,count,active\n001,12,false\nempty,,true', 'csv', schema), [{ title: '001', count: 12, active: false }, { title: 'empty', active: true }]);
  for (const count of ['0x10', ' 1 ', 'Infinity', '01', '9007199254740993']) assert.throws(() => importDocuments(`title,count\nx,${count}`, 'csv', schema));
  assert.throws(() => importDocuments('title,active\nx,1', 'csv', schema));
  for (const descriptor of [null, [{ name: 'nested', type: 'json' }], [{ name: 'file', type: 'file' }]]) assert.throws(() => importDocuments('title\nx', 'csv', descriptor), /scalar/);
  assert.throws(() => importDocuments('count\n1', 'csv', schema), /Required/);
});

test('JSON export excludes only managed metadata; CSV is explicit about unsafe/lossy representations and spreadsheet formulas', () => {
  const records = [{ id: 'r1', version: 2, data: { id: 'r1', title: '=SUM(1,2)', count: 3, active: false } }];
  const json = exportDocuments(records, 'json', schema); assert.deepEqual(JSON.parse(json.text), [{ title: '=SUM(1,2)', count: 3, active: false }]);
  const csv = exportDocuments(records, 'csv', schema); assert.equal(csv.escaped, 1); assert.match(csv.text, /'=SUM/); assert.doesNotMatch(csv.text, /r1/);
  for (const data of [{ title: null }, { title: 'a', nested: {} }, { title: 'a', count: null }]) assert.throws(() => exportDocuments([{ data }], 'csv', schema));
  assert.throws(() => exportDocuments([{ data: { title: 'a' } }, { data: { title: 'b', count: 2 } }], 'csv', schema), /unevenly/);
  assert.throws(() => exportDocuments([{ data: { n: Infinity } }], 'json', null), /finite/);
  assert.throws(() => exportDocuments([{ data: { title: '\0=unsafe' } }], 'csv', schema), /control/);
  assert.throws(() => importDocuments('title\nx\0y', 'csv', schema), /control/);
  assert.equal(exportDocuments([{ data: { title: '＝formula-like' } }], 'csv', schema).escaped, 1);
});

test('diff uses explicit top-level replacement semantics and rejects field removal; special keys remain data', () => {
  assert.deepEqual(documentDiff({ title: 'old', nested: { a: 1 } }, { title: 'new', nested: { b: 2 } }), [
    { field: 'title', operation: 'replace', before: 'old', after: 'new' }, { field: 'nested', operation: 'replace', before: { a: 1 }, after: { b: 2 } },
  ]);
  assert.throws(() => documentDiff({ a: 1 }, {}), /removal/);
  const [data] = importDocuments('[{"__proto__":{"polluted":true}}]', 'json', null);
  assert.ok(Object.hasOwn(data, '__proto__')); assert.equal({}.polluted, undefined);
});

test('CSV validates dates and select choices while preserving an explicitly permitted empty select value', () => {
  const schema = [{ name: 'date', type: 'datetime', required: true }, { name: 'choice', type: 'select', required: true, options: ['', 'yes'] }];
  const result = importDocuments('date,choice\n2026-09-21T08:30:00Z,""', 'csv', schema);
  assert.deepEqual(result, [{ date: '2026-09-21T08:30:00Z', choice: '' }]);
  const csv = exportDocuments(result.map(data => ({ data })), 'csv', schema);
  assert.deepEqual(importDocuments(csv.text, 'csv', schema), result);
  assert.throws(() => importDocuments('date,choice\nbad,yes', 'csv', schema), /datetime/);
  assert.throws(() => importDocuments('date,choice\n2026-09-21T08:30:00Z,no', 'csv', schema), /select/);
});

test('deep/large JSON trees are rejected before requests rather than overflowing diff or formatter recursion', () => {
  let document = { leaf: true }; for (let i = 0; i < 33; i++) document = { child: document };
  assert.throws(() => importDocuments(JSON.stringify([document]), 'json', null), /32-level/);
  assert.throws(() => importDocuments(JSON.stringify([{ values: Array(10000).fill(0) }]), 'json', null), /10000-node/);
});
