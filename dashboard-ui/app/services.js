// UI compatibility facade: no URLs, fetch calls, backend credentials or row indices.
import { getActiveConnection } from './connection/active.js';
import { unsupported } from './connection/errors.js';

export async function getListOfTables() {
  const result = await getActiveConnection().database.listCollections();
  return result.items.map(resource => ({ tableName: resource.name, entries: null }));
}

export async function getTableData(tableName) {
  const connection = getActiveConnection();
  const [page, descriptor] = await Promise.all([
    connection.database.listRecords(tableName), connection.database.getCollectionSchema(tableName),
  ]);
  const fields = Object.keys(descriptor.schema?.properties ?? {});
  return {
    tableData: page.items.map(record => record.data), records: page.items,
    tableSchema: fields.length ? fields : [...new Set(page.items.flatMap(record => Object.keys(record.data)))],
    hasMore: page.hasMore, nextCursor: page.nextCursor,
  };
}

export async function getTableSchema(tableName) {
  const descriptor = await getActiveConnection().database.getCollectionSchema(tableName);
  return Object.keys(descriptor.schema?.properties ?? {});
}

// The developer API has no collection-management endpoints.
export async function createNewTable() { return unsupported(); }
export async function deleteTable() { return unsupported(); }
export async function addRow({ tableName, values, ...options }) {
  return getActiveConnection().database.createRecord(tableName, values, options);
}
export async function editRow({ tableName, recordId, values, expectedVersion, signal }) {
  return getActiveConnection().database.updateRecord(tableName, recordId, values, { expectedVersion, signal });
}
export async function deleteRow({ tableName, recordId, expectedVersion, signal }) {
  return getActiveConnection().database.deleteRecord(tableName, recordId, { expectedVersion, signal });
}
