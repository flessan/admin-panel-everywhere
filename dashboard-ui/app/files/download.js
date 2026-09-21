/** Bytes are downloaded, never inserted into an iframe, image or HTML preview. */
export function createDownloadManager(document, { urls = globalThis.URL, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const pending = new Map();
  function clear() { for (const [url, timer] of pending) { cancel(timer); urls.revokeObjectURL(url); } pending.clear(); }
  return { clear, save({ data, key, partial = false }) {
    const url = urls.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    const filename = (key.split('/').filter(Boolean).at(-1) || 'object').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_');
    anchor.href = url; anchor.download = `${filename}${partial ? '.part' : ''}`; anchor.hidden = true;
    document.body.append(anchor);
    try { anchor.click(); }
    finally {
      anchor.remove();
      // Delay revocation so the browser can consume the download; also clear on disconnect/pagehide.
      pending.set(url, schedule(() => { urls.revokeObjectURL(url); pending.delete(url); }, 1000));
    }
  } };
}
