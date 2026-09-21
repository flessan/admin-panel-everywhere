export const record = (id = 'rec_one', version = 1, values = {}) => ({ id, version, data: { id, title: 'Hello', active: false, count: 0, ...values } });
export const pageOf = (items = [record()], extra = {}) => ({ items, hasMore: false, nextCursor: null, ...extra });
export function fakeConnection(overrides = {}) {
  const calls = [];
  const handlers = {
    listCollections: async () => ({ items: [], source: 'configured', complete: false }),
    getCollectionSchema: async () => ({ schema: null, source: 'unavailable' }),
    listRecords: async () => pageOf(),
    getRecord: async (name, id) => record(id),
    createRecord: async (name, data) => record('rec_new', 1, data),
    updateRecord: async (name, id, data, options) => record(id, options.expectedVersion + 1, data),
    deleteRecord: async () => ({ deleted: true }),
    ...overrides,
  };
  const database = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, async (...args) => {
    calls.push({ method, args }); return handler(...args);
  }]));
  return { connection: { database }, calls };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
