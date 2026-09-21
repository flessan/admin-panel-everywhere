import { AiInputError } from './tasks.js';

/** Synchronous draft-only bridge. No execute/run/fetch methods belong here. */
export function createAiHandoff({ getConnection, data, dataView, toolsView, apiView, navigate }) {
  return ({ proposal, scope, connection }) => {
    if (getConnection() !== connection) throw new AiInputError('Connection changed. Recapture the AI context.');
    if (['create-records', 'transform-json', 'bulk-edit'].includes(proposal.kind)) {
      const dataPage = scope.source === 'data' ? data.snapshot() : null;
      if (dataPage && (dataPage.collection !== scope.collection || dataPage.editor)) throw new AiInputError('Open the intended Data collection and close its editor first.');
      toolsView.stageAi(proposal, dataPage); navigate('tools');
    } else if (proposal.kind === 'filters') {
      if (data.snapshot().collection !== scope.collection) throw new AiInputError('Open this collection in Data and recapture before staging filters.');
      dataView.stageFilters(proposal); navigate('data');
    } else if (proposal.kind === 'api-request') {
      apiView.stageRequest(proposal); navigate('api');
    } else throw new AiInputError('This proposal has no supported handoff.');
  };
}
