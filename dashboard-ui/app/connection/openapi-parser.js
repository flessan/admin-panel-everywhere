import { requireValue } from './errors.js';
const methods = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Resolve local JSON pointers only; retain cycles/external refs instead of fetching them. */
export function resolveLocalRefs(value, document, seen = new Set(), depth = 0, budget = { remaining: 10000 }) {
  if (depth > 24 || --budget.remaining < 0) return { $ref: '[resolution depth limit]' };
  if (Array.isArray(value)) return value.map(item => resolveLocalRefs(item, document, seen, depth + 1, budget));
  if (!object(value)) return value;
  if (typeof value.$ref === 'string') {
    const ref = value.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return structuredClone(value);
    let target = document;
    try {
      for (const token of ref.slice(2).split('/')) {
        const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return structuredClone(value);
        target = target[key];
      }
    } catch { return structuredClone(value); }
    if (!object(target)) return structuredClone(value);
    const next = new Set(seen); next.add(ref);
    return resolveLocalRefs({ ...target, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) }, document, next, depth + 1, budget);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveLocalRefs(child, document, seen, depth + 1, budget)]));
}

export function parseOpenApi(document, { supports = () => false } = {}) {
  requireValue(object(document) && typeof document.openapi === 'string' && /^3\.[01]\./.test(document.openapi) && object(document.paths), 'invalid_openapi');
  const operations = [];
  const schemes = resolveLocalRefs(document.components?.securitySchemes ?? {}, document);
  for (const [path, rawItem] of Object.entries(document.paths)) {
    // OpenAPI Paths keys must be origin-relative; servers are documentation, not authority.
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\\\s]/.test(path) || !object(rawItem)) continue;
    const item = resolveLocalRefs(rawItem, document);
    if (item.$ref) continue;
    for (const [method, rawOperation] of Object.entries(item)) {
      if (!methods.has(method) || !object(rawOperation)) continue;
      const operation = resolveLocalRefs(rawOperation, document);
      const parameters = new Map(), warnings = [];
      for (const parameter of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
        if (!object(parameter)) continue;
        parameters.set(`${parameter.in}:${parameter.name ?? parameter.$ref}`, parameter);
        if (!parameter.name || parameter.$ref) warnings.push('An unnamed or unresolved parameter cannot have an automatic input. Use the documented extra-query contract where applicable.');
      }
      const security = operation.security ?? document.security ?? [];
      const id = `${method.toUpperCase()} ${path}`;
      operations.push({ id, method: method.toUpperCase(), path, operationId: operation.operationId ?? null,
        tags: Array.isArray(operation.tags) && operation.tags.length ? operation.tags.filter(tag => typeof tag === 'string') : ['Untagged'],
        summary: operation.summary ?? '', description: operation.description ?? '', deprecated: operation.deprecated === true,
        parameters: [...parameters.values()], requestBody: operation.requestBody ?? null, responses: operation.responses ?? {},
        security: Array.isArray(security) ? security : [], securitySchemes: schemes, executable: supports(id), warnings });
    }
  }
  return operations;
}
