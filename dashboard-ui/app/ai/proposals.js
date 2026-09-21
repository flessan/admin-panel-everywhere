import { sensitiveName } from '../connection/redaction.js';
import { editableData, parseDocument, normalizeSchema } from '../data/schema.js';
import { validateDocument, documentDiff } from '../tools/documents.js';
import { buildRequest } from '../api-tools/request.js';
import { TASKS, AiInputError, MAX_AI_BYTES } from './tasks.js';
import { bytes, scrubPacket } from './context.js';
const fail = message => { throw new AiInputError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('AI response has unsupported fields. Commands, URLs, permissions and tool calls are not accepted.'); }
function safeData(value) {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++count > 10000 || depth > 32) fail('AI proposal is too deeply nested or complex.');
    if (typeof value === 'number' && !Number.isFinite(value)) fail('AI JSON numbers must be finite.');
    if (typeof value === 'string' && /\[REDACTED\]|\[.*(?:omitted|excluded|depth limit).*\]/i.test(value)) fail('Do not stage redaction or omission placeholders as data.');
    if (object(value) || Array.isArray(value)) for (const [key, child] of Object.entries(value)) {
      if (sensitiveName(key)) fail('Credential-like fields are not accepted in AI action drafts. Use the manual tools for intentional credential operations.');
      pending.push({ value: child, depth: depth + 1 });
    }
  }
}

/** Untrusted model output is data, never a script, tool call, target or version authority. */
export function validateProposal(text, taskId, scope, connection) {
  if (typeof text !== 'string' || bytes(text) > MAX_AI_BYTES) fail('Provide a model response of at most 64 KiB.');
  let raw; try { raw = JSON.parse(text); } catch { fail('Expected one JSON object without markdown fences or executable code.'); }
  const proposal = scrubPacket(connection, scope, connection.api.sanitize(raw));
  if (!object(proposal) || typeof proposal.kind !== 'string') fail('The AI response must declare a supported kind.');
  // Explanations are a safe fallback for insufficient context, for every task.
  if (proposal.kind === 'explanation') {
    exact(proposal, ['kind', 'text']);
    if (typeof proposal.text !== 'string' || !proposal.text.trim() || proposal.text.length > 12000) fail('Provide a nonempty explanation of at most 12000 characters.');
    return { proposal, review: { kind: 'explanation', text: proposal.text }, actionable: false };
  }
  if (!TASKS[taskId] || TASKS[taskId].kind !== proposal.kind) fail('Proposal kind does not match the reviewed task.');
  safeData(proposal);
  if (['create-records', 'transform-json', 'bulk-edit', 'filters'].includes(proposal.kind) && (!scope.ready || !scope.collection)) fail('Load the working collection before preparing an AI action.');
  if (proposal.kind === 'create-records') {
    exact(proposal, ['kind', 'documents']);
    if (!Array.isArray(proposal.documents) || !proposal.documents.length || proposal.documents.length > 20) fail('Generate between 1 and 20 records.');
    if (taskId === 'suggest-data' && !scope.schema) fail('Schema-compatible suggestions require supplied schema metadata.');
    const documents = proposal.documents.map(data => validateDocument(data, scope.schema));
    return { proposal: { kind: proposal.kind, documents }, review: { creates: documents.length, collection: scope.collection, documents }, actionable: true };
  }
  if (['transform-json', 'bulk-edit'].includes(proposal.kind)) {
    exact(proposal, ['kind', 'changes']);
    if (!scope.records.length || (proposal.kind === 'transform-json' && scope.records.length !== 1)) fail('Select one record for a transform, or 1–20 records for bulk edits, in Tools.');
    const changes = parseDocument(JSON.stringify(proposal.changes));
    if (!Object.keys(changes).length) fail('Provide explicit changed fields, not an empty patch.');
    const diffs = scope.records.map((record, index) => {
      const before = editableData(record.data), after = validateDocument({ ...before, ...changes }, scope.schema);
      // Display only fields the model proposes changing; never leak unchanged secrets.
      return { ref: `record-${index + 1}`, id: record.id, expectedVersion: record.version, changes: connection.api.sanitize(documentDiff(before, after)) };
    });
    return { proposal: { kind: proposal.kind, changes }, review: { collection: scope.collection, diffs }, actionable: true };
  }
  if (proposal.kind === 'filters') {
    exact(proposal, ['kind', 'filters', 'limit']);
    if (!object(proposal.filters) || Object.keys(proposal.filters).length > 4 || !Number.isInteger(proposal.limit) || proposal.limit < 1 || proposal.limit > 100) fail('Use at most four indexed equality filters and a page size of 1–100.');
    const fields = normalizeSchema(scope.schema).fields;
    for (const [name, value] of Object.entries(proposal.filters)) {
      const field = fields.find(field => field.name === name && field.indexed && ['text', 'select'].includes(field.type));
      if (!field || typeof value !== 'string' || (field.type === 'select' && !field.options.includes(value))) fail('AI filters must target known indexed text/select fields with valid string values.');
    }
    return { proposal, review: { collection: scope.collection, filters: proposal.filters, limit: proposal.limit }, actionable: true };
  }
  if (proposal.kind === 'api-request') {
    exact(proposal, ['kind', 'endpointId', 'parameters']);
    const operation = scope.operations.find(item => item.id === proposal.endpointId);
    if (scope.catalogStatus !== 'ready' || !operation?.executable || !['GET', 'HEAD'].includes(operation.method)) fail('AI API drafts require a loaded, connector-approved GET/HEAD operation. Use typed record drafts for mutations.');
    if (!Array.isArray(proposal.parameters) || proposal.parameters.length > 30) fail('Supply a bounded array of named parameters.');
    const seen = new Set();
    const parameters = proposal.parameters.map(parameter => {
      exact(parameter, ['in', 'name', 'value']);
      const key = `${parameter.in}:${parameter.name}`;
      if (seen.has(key) || sensitiveName(parameter.name) || !['string', 'number', 'boolean'].includes(typeof parameter.value) || !operation.parameters.some(item => item.in === parameter.in && item.name === parameter.name && item.name)) fail('Only unique, documented, non-credential primitive parameters are allowed.');
      seen.add(key); return { ...parameter, included: true };
    });
    buildRequest(operation, { parameters });
    return { proposal, review: { method: operation.method, path: operation.path, parameters, note: 'Draft only; the API workstation rechecks connector policy before execution.' }, actionable: true };
  }
  fail('Unsupported AI proposal.');
}
