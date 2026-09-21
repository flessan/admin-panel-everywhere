import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as services from '../../dashboard-ui/app/services.js';
import { setActiveConnection, getActiveConnection } from '../../dashboard-ui/app/connection/active.js';
import { defineConnection } from '../../dashboard-ui/app/connection/contract.js';

// A non-Telegraph connector proves the UI facade depends only on the contract.
function fakeConnection() {
  const calls = [];
  const fn = name => async (...args) => { calls.push({ name, args }); return { ok: true }; };
  const connection = defineConnection({
    metadata: { connector: 'fake' }, authentication: { clear() {} },
    discovery: { discoverOpenApi: fn('discover'), listEndpoints: fn('endpoints') },
    database: {
      listCollections: async () => ({ items: [{ name: 'anything' }] }),
      getCollection: fn('collection'),
      getCollectionSchema: async () => ({ schema: null, source: 'unavailable' }),
      listRecords: async () => ({ items: [{ id: 'durable-id', data: { enabled: false }, version: 5 }], hasMore: false, nextCursor: null }),
      getRecord: fn('get'), createRecord: fn('create'), updateRecord: fn('update'), deleteRecord: fn('delete'),
    },
    storage: Object.fromEntries(['listObjects', 'getObjectMetadata', 'downloadObject', 'uploadObject', 'deleteObject'].map(name => [name, fn(name)])),
    api: { discoverOpenApi: fn('discover'), listEndpoints: fn('endpoints'), execute: fn('execute') },
    disconnect() { calls.push({ name: 'disconnect' }); },
  });
  return { connection, calls };
}

test('UI facade uses only the connector contract and forwards stable IDs and versions', async () => {
  const { connection, calls } = fakeConnection();
  setActiveConnection(connection);
  assert.deepEqual(await services.getListOfTables(), [{ tableName: 'anything', entries: null }]);
  const table = await services.getTableData('anything');
  assert.deepEqual(table.tableData, [{ enabled: false }]);
  assert.equal(table.records[0].id, 'durable-id');
  await services.editRow({ tableName: 'anything', recordId: 'durable-id', values: { enabled: true }, expectedVersion: 5 });
  assert.deepEqual(calls[0], { name: 'update', args: ['anything', 'durable-id', { enabled: true }, { expectedVersion: 5, signal: undefined }] });
  await assert.rejects(services.createNewTable('not-real'), { code: 'unsupported_operation' });
  await assert.rejects(services.deleteTable('not-real'), { code: 'unsupported_operation' });
  setActiveConnection(null);
  assert.equal(calls.at(-1).name, 'disconnect');
  assert.throws(getActiveConnection, { code: 'not_connected' });
  await assert.rejects(services.getListOfTables(), { code: 'not_connected' });
});

test('replacing a connection disconnects the previous one', () => {
  const previous = fakeConnection();
  const next = fakeConnection();
  setActiveConnection(previous.connection);
  setActiveConnection(next.connection);
  assert.equal(previous.calls[0].name, 'disconnect');
  assert.equal(getActiveConnection(), next.connection);
  setActiveConnection(null);
});

test('frontend service boundary has no network URL construction or raw fetch dependency', async () => {
  const source = await readFile(new URL('../../dashboard-ui/app/services.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|\/api\//);
});
