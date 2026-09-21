import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestClient } from '../../dashboard-ui/app/connection/request-client.js';
import { config, json, mockFetch } from './fixtures.js';

function setup(respond, options = {}) {
  const mock = mockFetch(respond ?? (() => json({ ok: true })));
  return { ...mock, client: createRequestClient({ baseUrl: config.TELEGRAPH_URL, getCredential: () => config.TELEGRAPH_API_KEY, ...mock, ...options }) };
}

test('request client refuses external URLs, traversal, auth headers and URL credentials', async () => {
  const { client, calls } = setup();
  for (const path of ['https://evil.example', '//evil.example', '/a/../b', '/a/%2e%2e/b', '/a/%2f/b', '/a\\b', '/a?token=x']) {
    await assert.rejects(client.request({ path }), { code: 'invalid_request' });
  }
  await assert.rejects(client.request({ path: '/api/health', headers: { Authorization: 'wrong' }, authenticated: false }), { code: 'invalid_request' });
  await assert.rejects(client.request({ path: '/api/health', query: { api_key: 'wrong' } }), { code: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('204/HEAD never attempt JSON decoding; a non-JSON successful response fails safely', async () => {
  const { client } = setup(() => new Response(null, { status: 204 }));
  assert.equal((await client.request({ path: '/empty' })).data, null);
  const head = setup(() => new Response(null));
  assert.equal((await head.client.request({ path: '/empty', method: 'HEAD' })).data, null);
  const invalid = setup(() => new Response('not json'));
  await assert.rejects(invalid.client.request({ path: '/json' }), { code: 'invalid_response' });
});

function abortableFetch(url, { signal }) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(config.TELEGRAPH_API_KEY));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('timeout produces a safe error and no retry', async () => {
  const { client } = setup(undefined, { fetchImpl: abortableFetch, timeoutMs: 5 });
  await assert.rejects(client.request({ path: '/api/health' }), { code: 'request_timeout' });
});

test('caller cancellation and closing the client abort outstanding requests', async () => {
  const { client } = setup(undefined, { fetchImpl: abortableFetch });
  const controller = new AbortController();
  const request = client.request({ path: '/api/health', signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { code: 'request_aborted' });
  const next = client.request({ path: '/api/health' });
  client.close();
  await assert.rejects(next, { code: 'request_aborted' });
  await assert.rejects(client.request({ path: '/api/health' }), { code: 'connection_closed' });
});

test('throwing diagnostic hook cannot break requests', async () => {
  const { client } = setup(undefined, { logger() { throw new Error('diagnostic sink failure'); } });
  assert.equal((await client.request({ path: '/api/health' })).status, 200);
});
