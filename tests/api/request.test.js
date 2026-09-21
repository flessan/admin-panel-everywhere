import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../../dashboard-ui/app/api-tools/request.js';
import { parseOpenApi } from '../../dashboard-ui/app/connection/openapi-parser.js';
import { document, parameter } from './fixtures.js';
const operation = id => parseOpenApi(document).find(item => item.id === id);

test('path/query/header inputs, required values, numeric ranges and dynamic filters', () => {
  const op = operation('GET /api/db/{collection}');
  const result = buildRequest(op, { parameters: [parameter('collection', 'notes'), parameter('limit', '25', 'query')], extraQuery: '{"title":"hello"}' });
  assert.deepEqual(result.pathParameters, { collection: 'notes' }); assert.deepEqual(result.query, { limit: 25, title: 'hello' });
  assert.throws(() => buildRequest(op), /required parameter/);
  for (const value of ['0', '101', '1.2', 'NaN', '']) assert.throws(() => buildRequest(op, { parameters: [parameter('collection', 'notes'), parameter('limit', value, 'query')] }));
  assert.throws(() => buildRequest(op, { parameters: [parameter('collection', 'notes')], extraQuery: '{"api_key":"secret"}' }), /non-secret/);
  assert.throws(() => buildRequest(op, { parameters: [parameter('collection', 'notes')], extraHeaders: '{"Authorization":"Bearer unsafe"}' }), /connection-managed/);
});

test('JSON body is syntax checked, preserves arbitrary documents and renders no values from defaults', () => {
  const op = operation('POST /api/db/{collection}'); const parameters = [parameter('collection', 'notes'), parameter('Idempotency-Key', 'client-123', 'header')];
  const result = buildRequest(op, { parameters, contentType: 'application/json', bodyText: '{"title":"<img>","nested":[true,12,null]}', allowMutation: true });
  assert.deepEqual(result.json, { title: '<img>', nested: [true, 12, null] }); assert.equal(result.headers['idempotency-key'], 'client-123');
  assert.equal(result.allowMutation, true);
  for (const bodyText of ['', '{', '{"number":1e9999}']) assert.throws(() => buildRequest(op, { parameters, contentType: 'application/json', bodyText }));
  assert.throws(() => buildRequest(op, { parameters, contentType: 'text/html', bodyText: 'x' }), /declared/);
});

test('binary request bodies retain the file only in transient options; text and unsupported encodings are explicit', () => {
  const op = operation('PUT /api/storage/{bucket}/{key}');
  const file = new Blob(['hello']); const parameters = [parameter('bucket', 'media'), parameter('key', 'a/b.txt')];
  assert.equal(buildRequest(op, { parameters, contentType: 'application/octet-stream', file }).body, file);
  assert.throws(() => buildRequest(op, { parameters, contentType: 'application/octet-stream' }), /requires a request body/);
  const text = { ...op, requestBody: { content: { 'text/plain': {}, 'multipart/form-data': {} } } };
  assert.equal(buildRequest(text, { parameters, contentType: 'text/plain', bodyText: 'hi' }).body, 'hi');
  assert.throws(() => buildRequest(text, { parameters, contentType: 'multipart/form-data', bodyText: 'hi' }), /not supported/);
});

test('boolean/enums validate and array/cookie serializations are not silently guessed', () => {
  const op = { id: 'GET /test', parameters: [{ name: 'flag', in: 'query', schema: { type: 'boolean', enum: [true] } }] };
  assert.equal(buildRequest(op, { parameters: [parameter('flag', 'true', 'query')] }).query.flag, true);
  assert.throws(() => buildRequest(op, { parameters: [parameter('flag', 'false', 'query')] }), /choices/);
  op.parameters[0].schema = { type: 'array' };
  assert.throws(() => buildRequest(op, { parameters: [parameter('flag', 'a,b', 'query')] }), /serialization/);
  op.parameters[0].in = 'cookie';
  assert.throws(() => buildRequest(op, { parameters: [parameter('flag', 'yes', 'cookie')] }), /Cookie/);
});
