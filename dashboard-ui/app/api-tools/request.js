import { sensitiveName } from '../connection/redaction.js';
export class ApiInputError extends Error {}
const fail = message => { throw new ApiInputError(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function jsonObject(text, label) {
  let result; try { result = JSON.parse(text || '{}'); } catch { fail(`${label} must be valid JSON.`); }
  if (!plain(result)) fail(`${label} must be a JSON object.`);
  return result;
}
function scalar(parameter, value) {
  const style = { path: 'simple', query: 'form', header: 'simple' }[parameter.in];
  if (parameter.content || (parameter.style && parameter.style !== style) || parameter.allowReserved) fail('This parameter serialization is not supported. Its schema is shown for reference.');
  const schema = parameter.schema ?? {};
  const type = Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type;
  if (schema.$ref || (type && !['string', 'number', 'integer', 'boolean'].includes(type))) fail('This parameter serialization is not supported. Its schema is shown for reference.');
  if (type === 'integer' || type === 'number') {
    if (!String(value).trim() || !Number.isFinite(Number(value)) || (type === 'integer' && !Number.isInteger(Number(value)))) fail('A numeric parameter is invalid.');
    value = Number(value);
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) fail('A parameter is outside its documented range.');
  } else if (type === 'boolean') {
    if (![true, false, 'true', 'false'].includes(value)) fail('Use true or false for boolean parameters.');
    value = value === true || value === 'true';
  } else value = String(value);
  if (schema.enum && !schema.enum.includes(value)) fail('A parameter is not one of the documented choices.');
  return value;
}

/** Raw input exists only for this request. It is not the history/export model. */
export function buildRequest(operation, { parameters = [], extraQuery = '{}', extraHeaders = '{}', contentType = '', bodyText = '', file, allowMutation = false } = {}) {
  const pathParameters = new Map(), query = new Map(), headers = new Map();
  for (const parameter of operation.parameters) {
    if (!parameter.name || parameter.$ref) continue;
    // Authentication comes from the connection, never from form fields or URL auth.
    if (sensitiveName(parameter.name)) {
      if (parameter.in === 'query' || parameter.in === 'path' || parameter.in === 'cookie') fail('Credential parameters cannot be supplied in URLs or cookies. This auth scheme needs a supported connector.');
      continue;
    }
    const entry = parameters.find(entry => entry.name === parameter.name && entry.in === parameter.in);
    if (!entry?.included) { if (parameter.required || parameter.in === 'path') fail('Supply every required parameter.'); continue; }
    if (!['path', 'query', 'header'].includes(parameter.in)) fail('Cookie parameters are not supported by the controlled client.');
    const value = scalar(parameter, entry.value);
    if (parameter.in === 'path' && !String(value).length) fail('Path parameters cannot be empty.');
    (parameter.in === 'path' ? pathParameters : parameter.in === 'query' ? query : headers).set(parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name, value);
  }
  for (const [key, value] of Object.entries(jsonObject(extraQuery, 'Extra query'))) {
    if (sensitiveName(key) || !['string', 'number', 'boolean'].includes(typeof value)) fail('Query parameters must be non-secret scalar values.');
    if (query.has(key)) fail('A query parameter was supplied twice.');
    query.set(key, value);
  }
  for (const [key, value] of Object.entries(jsonObject(extraHeaders, 'Extra headers'))) {
    if (sensitiveName(key) || typeof value !== 'string') fail('Credential headers are connection-managed, not editable request inputs.');
    if (headers.has(key.toLowerCase())) fail('A header was supplied twice.');
    headers.set(key.toLowerCase(), value);
  }
  const request = { endpointId: operation.id, pathParameters: Object.fromEntries(pathParameters), query: Object.fromEntries(query), headers: Object.fromEntries(headers), allowMutation };
  if (parameters.some(entry => entry.included && !operation.parameters.some(parameter => parameter.name === entry.name && parameter.in === entry.in))) fail('The input does not match a documented parameter.');
  const contents = operation.requestBody?.content ?? {};
  if (contentType && !Object.hasOwn(contents, contentType)) fail('Select a request content type declared by the operation.');
  if (operation.requestBody?.$ref) fail('The request body reference is unresolved.');
  if (contentType && (bodyText !== '' || file)) {
    request.headers['content-type'] = contentType;
    if (/json$|\+json$/.test(contentType)) {
      try { request.json = JSON.parse(bodyText); } catch { fail('Request body must be valid JSON.'); }
      const check = value => {
        if (typeof value === 'number' && !Number.isFinite(value)) fail('JSON numbers must be finite.');
        if (value && typeof value === 'object') Object.values(value).forEach(check);
      }; check(request.json);
    } else if (contentType === 'application/octet-stream') {
      if (!file) fail('Choose a binary file.'); request.body = file;
    } else if (/^text\/|xml$/.test(contentType)) request.body = bodyText;
    else fail('This request-body encoding is not supported; the schema remains available for inspection.');
  } else if (operation.requestBody?.required) fail('This operation requires a request body.');
  return request;
}
