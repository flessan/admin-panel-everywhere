export const REDACTED = '[REDACTED]';
export function sensitiveName(name) {
  const key = String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return /authorization|cookie|password|secret|credential|private.?key|api.?key|access.?token|refresh.?token|id.?token/.test(key) || key === 'token';
}

/** A closure supplies the active credential; it is never exposed to the UI. */
export function createRedactor(getCredential = () => null) {
  function redact(value, { document = false, additionalSecrets = [], stripExamples = document } = {}) {
    const secrets = new Set();
    const add = value => { if (typeof value === 'string' && value.length >= 4) { secrets.add(value); secrets.add(encodeURIComponent(value)); } };
    for (const secret of additionalSecrets) if (typeof secret === 'string' && secret) { secrets.add(secret); secrets.add(encodeURIComponent(secret)); secrets.add(JSON.stringify(secret).slice(1, -1)); }
    const credential = getCredential();
    if (typeof credential === 'string' && credential) { secrets.add(credential); secrets.add(encodeURIComponent(credential)); secrets.add(JSON.stringify(credential).slice(1, -1)); }
    const collect = (item, depth = 0) => {
      if (!item || typeof item !== 'object' || depth > 40) return;
      for (const [key, child] of Object.entries(item)) {
        if (!document && sensitiveName(key)) {
          const gather = (value, level = 0) => { if (level > 40) return; if (typeof value === 'string') add(value); else if (value && typeof value === 'object') Object.values(value).forEach(child => gather(child, level + 1)); };
          gather(child);
        } else collect(child, depth + 1);
      }
    };
    collect(value);
    const strings = [...secrets].sort((a, b) => b.length - a.length);
    const text = input => {
      let result = input;
      for (const secret of strings) result = result.split(secret).join(REDACTED);
      return result
        .replace(/(https?:\/\/)[^/\s?#]+@/gi, '$1[REDACTED]@')
        .replace(/([?&](?:x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature)|signature|sig|auth|awsaccesskeyid|key-pair-id)=)[^&#\s"']+/gi, '$1[REDACTED]')
        .replace(/\b(?:tg_live_|tgsk_live_)[A-Za-z0-9_-]+/g, REDACTED)
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
        .replace(/\b(Bearer|Basic)\s+(?!\[REDACTED\])[^\s"'<>;,]+/gi, '$1 [REDACTED]')
        .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret(?:[_-]?(?:access[_-]?)?key)?|api[_-]?key|authorization|credential)(?:["']?)\s*(?:[:=]\s*|>\s*))(?:"[^"]*"|'[^']*'|[^\s<>&;,}]+)/gi, '$1[REDACTED]')
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, REDACTED);
    };
    const visit = (item, depth = 0, nameMap = false) => {
      if (depth > 40) return '[Depth limit]';
      if (typeof item === 'string') return text(item);
      if (typeof item === 'number' && secrets.has(String(item))) return REDACTED;
      if (!item || typeof item !== 'object') return item;
      if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [text(key),
        (!document && sensitiveName(key)) || (stripExamples && !nameMap && ['example', 'examples', 'default'].includes(key)) ? REDACTED : visit(child, depth + 1, !nameMap && ['properties', '$defs', 'schemas'].includes(key))]));
    };
    return visit(value);
  }
  return redact;
}
