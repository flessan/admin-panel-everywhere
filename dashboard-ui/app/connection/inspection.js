// Inspector responses are bounded and redacted at the credential-owning boundary.
export const PREVIEW_BYTES = 65536;
export async function inspectResponse(response, method, redact) {
  const headers = Object.fromEntries(response.headers);
  let body = null, bodyKind = 'empty', omitted = false;
  if (method !== 'HEAD' && ![204, 205, 304].includes(response.status)) {
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !/json|^text\/|xml|javascript|x-www-form-urlencoded/.test(type)) {
      bodyKind = 'binary'; body = { contentType: type, size: response.headers.get('content-length'), note: 'Binary bytes omitted. Use Files for downloads.' };
      await response.body?.cancel();
    } else {
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > PREVIEW_BYTES) { omitted = true; await reader.cancel(); break; }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      if (omitted) { bodyKind = 'omitted'; body = 'Response exceeds the 64 KiB inspector limit; body omitted (not partially redacted).'; }
      else {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try {
          body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body)) throw new Error('Binary or unsupported encoding');
          bodyKind = 'text';
          try { body = JSON.parse(body); bodyKind = 'json'; } catch { /* Display non-JSON safely as text. */ }
        } catch { bodyKind = 'binary'; body = { note: 'Non-UTF-8 or binary bytes omitted.' }; }
      }
    }
  }
  // Payload secrets can equal ordinary words such as 'status'. Keep protocol
  // metadata separate so redaction cannot rename the inspector's fixed fields.
  const [safeHeaders, safeBody] = redact([headers, body]);
  return { status: response.status, ok: response.ok, headers: safeHeaders, data: safeBody, bodyKind, omitted };
}
