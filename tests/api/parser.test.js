import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi, resolveLocalRefs } from '../../dashboard-ui/app/connection/openapi-parser.js';
import { document } from './fixtures.js';

test('OpenAPI catalog includes only declared operations with tags, security, refs and independent policy', () => {
  const catalog = parseOpenApi(document, { supports: id => id === 'GET /api/health' });
  assert.equal(catalog.length, 10);
  assert.deepEqual(catalog.find(item => item.path === '/api/health').security, []);
  const op = catalog.find(item => item.id === 'POST /api/db/{collection}');
  assert.deepEqual(op.tags, ['Database']); assert.deepEqual(op.security, [{ bearerApi: [] }]);
  assert.equal(op.securitySchemes.bearerApi.scheme, 'bearer');
  assert.equal(op.parameters[0].name, 'collection');
  assert.equal(op.requestBody.content['application/json'].schema.properties.title.type, 'string');
  assert.equal(op.executable, false); assert.equal(catalog.filter(item => item.executable).length, 1);
  assert.ok(!catalog.some(item => item.path.includes('untrusted')));
  assert.equal(document.paths['/api/db/{collection}'].parameters[0].$ref, '#/components/parameters/Collection');
});

test('operation parameter overrides are keyed by location and name; dynamic names are warnings', () => {
  const op = parseOpenApi(document).find(item => item.id === 'GET /api/db/{collection}');
  assert.equal(op.parameters.filter(item => item.name === 'limit').length, 1);
  assert.equal(op.parameters.find(item => item.name === 'limit').schema.maximum, 100);
  assert.equal(op.parameters.find(item => item.name === '').description, 'Dynamic exact-match filter');
  assert.equal(op.warnings.length, 1);
});

test('local pointers support escaped keys and cycles; external refs are not fetched', () => {
  const doc = { components: { schemas: { 'a/b~c': { type: 'string' }, Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } } } };
  assert.equal(resolveLocalRefs({ $ref: '#/components/schemas/a~1b~0c' }, doc).type, 'string');
  assert.equal(resolveLocalRefs({ $ref: '#/components/schemas/Node' }, doc).properties.child.$ref, '#/components/schemas/Node');
  for (const ref of ['https://elsewhere.example/spec.json', '#/missing', '#/%bad']) assert.deepEqual(resolveLocalRefs({ $ref: ref }, doc), { $ref: ref });
});

test('invalid specs and path URLs cannot inject new routes', () => {
  for (const spec of [null, {}, { openapi: '2.0', paths: {} }, { openapi: '3.9.0', paths: {} }]) assert.throws(() => parseOpenApi(spec), { code: 'invalid_openapi' });
  const result = parseOpenApi({ openapi: '3.0.3', paths: { 'https://evil.example': { get: {} }, '//evil.example': { get: {} }, '/ok': { summary: 'not a verb', get: {} } } });
  assert.deepEqual(result.map(item => item.id), ['GET /ok']); assert.deepEqual(result[0].tags, ['Untagged']);
});
