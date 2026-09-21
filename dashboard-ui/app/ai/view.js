import { TASKS, AiInputError } from './tasks.js';
import { aiProviders } from './providers.js';

export function mountAiView(document, controller, { registry = aiProviders } = {}) {
  const $ = id => document.getElementById(id);
  let state, epoch = -1, packet = '', output = '', copyRevision = 0;
  for (const [id, task] of Object.entries(TASKS)) { const option = document.createElement('option'); option.value = id; option.textContent = task.title; $('ai-task').append(option); }
  const inclusionNames = ['records', 'files', 'schemas', 'operations', 'filters', 'errors'];
  function render(next) {
    state = next;
    if (state.epoch !== epoch) {
      epoch = state.epoch; $('ai-instructions').value = ''; $('ai-response').value = '';
      for (const name of inclusionNames) $(`ai-include-${name}`).checked = ['schemas', 'operations', 'filters'].includes(name);
    }
    const serialized = state.packet ? JSON.stringify(state.packet, null, 2) : '';
    if (serialized !== packet || state.status === 'idle') {
      packet = serialized; copyRevision++; $('ai-share-ack').checked = false; $('ai-stage-ack').checked = false;
      $('ai-response').value = ''; $('ai-packet').value = serialized;
    }
    if (output !== state.output) { output = state.output; $('ai-stage-ack').checked = false; if (output) $('ai-response').value = output; }
    $('ai-state').textContent = state.connected ? state.notice || state.status : 'Connect to a backend to prepare reviewed AI context.';
    $('ai-error').textContent = state.error ?? '';
    $('ai-proposal').textContent = state.review ? JSON.stringify(state.review, null, 2) : 'No validated proposal.';
    const generating = state.status === 'generating';
    $('ai-prepare').disabled = !state.connected;
    $('ai-copy').disabled = !packet || generating || !$('ai-share-ack').checked || state.staged;
    $('ai-generate').disabled = !packet || generating || !$('ai-share-ack').checked || $('ai-provider').value === 'manual' || state.staged;
    $('ai-cancel').disabled = !generating; $('ai-response').disabled = generating;
    $('ai-import-response').disabled = !packet || generating || state.staged;
    $('ai-stage').disabled = !state.actionable || state.staged || generating || !$('ai-stage-ack').checked;
  }
  async function act(action) {
    $('ai-error').textContent = '';
    try { await action(); } catch (error) {
      $('ai-error').textContent = error instanceof AiInputError ? error.message : 'Unable to prepare or stage this context. Review the selection and workspace state; nothing was executed.';
    }
  }
  function edited() { copyRevision++; controller.invalidate(); }
  for (const id of ['ai-task', 'ai-source', 'ai-provider', 'ai-operation-scope', ...inclusionNames.map(name => `ai-include-${name}`)]) $(id).onchange = edited;
  $('ai-instructions').oninput = edited;
  $('ai-response').oninput = () => { $('ai-stage-ack').checked = false; controller.clearProposal(); };
  for (const id of ['ai-share-ack', 'ai-stage-ack']) $(id).onchange = () => render(controller.snapshot());
  $('ai-prepare').onclick = () => act(() => controller.prepare({ task: $('ai-task').value, source: $('ai-source').value, instructions: $('ai-instructions').value, operationScope: $('ai-operation-scope').value,
    ...Object.fromEntries(inclusionNames.map(name => [`include${name[0].toUpperCase()}${name.slice(1)}`, $(`ai-include-${name}`).checked])) }));
  $('ai-copy').onclick = () => act(async () => {
    const text = controller.shareText($('ai-share-ack').checked), current = ++copyRevision;
    try { await document.defaultView.navigator.clipboard.writeText(text); if (current === copyRevision) $('ai-state').textContent = 'Copied the reviewed packet. Paste it into your chosen model, then paste its JSON response below.'; }
    catch { if (current === copyRevision) { $('ai-packet').focus(); $('ai-packet').select(); $('ai-state').textContent = 'Clipboard unavailable. Select and copy the reviewed packet manually.'; } }
  });
  $('ai-generate').onclick = () => act(() => controller.generate($('ai-provider').value, $('ai-share-ack').checked));
  $('ai-cancel').onclick = () => controller.cancel();
  $('ai-import-response').onclick = () => act(() => controller.importResponse($('ai-response').value));
  $('ai-stage').onclick = () => act(() => controller.stage($('ai-stage-ack').checked));
  $('ai-clear').onclick = () => { $('ai-instructions').value = ''; $('ai-response').value = ''; controller.invalidate('AI session cleared. Previously shared data cannot be recalled from a provider or clipboard.'); };
  const unsubscribe = controller.subscribe(render);
  const unsubscribeProviders = registry.subscribe(providers => {
    const selected = $('ai-provider').value;
    $('ai-provider').replaceChildren();
    for (const provider of [{ id: 'manual', label: 'Manual copy / paste — no provider request' }, ...providers]) {
      const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.label; $('ai-provider').append(option);
    }
    if (providers.some(provider => provider.id === selected)) $('ai-provider').value = selected;
    if (selected !== $('ai-provider').value) edited(); else render(controller.snapshot());
  });
  return { dispose() { unsubscribe(); unsubscribeProviders(); controller.invalidate('AI view closed.'); } };
}
