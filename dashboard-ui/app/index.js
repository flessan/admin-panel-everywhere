import { mountWorkspace } from './workspace/shell.js';
import { createAiController } from './ai/controller.js';
import { mountAiView } from './ai/view.js';
import { createAiHandoff } from './ai/handoff.js';
import { createToolsController } from './tools/controller.js';
import { mountToolsView } from './tools/view.js';
import { publicConfig } from './public-config.js';
import { getActiveConnection, onConnectionChange, setActiveConnection } from './connection/index.js';
import { createTelegraphConnection } from './connectors/telegraph/index.js';
import { createDataController } from './data/controller.js';
import { mountDataView } from './data/view.js';
import { createFilesController } from './files/controller.js';
import { createApiController } from './api-tools/controller.js';
import { mountApiView } from './api-tools/view.js';
import { mountFilesView } from './files/view.js';

const controller = createDataController();
const dataView = mountDataView(document, controller);
const files = createFilesController();
const filesView = mountFilesView(document, files);
const api = createApiController();
const apiView = mountApiView(document, api);
const tools = createToolsController();
const toolsView = mountToolsView(document, tools, { navigate: name => {
  selectWorkspace(name);
  if (name === 'api') document.getElementById('api-explorer-tab').click();
}, dataContext: () => controller.snapshot() });
const ai = createAiController({
  getSources: () => ({ data: controller.snapshot(), tools: tools.snapshot(), files: files.snapshot(), api: api.snapshot() }),
  handoff: createAiHandoff({ getConnection: getActiveConnection, data: controller, dataView, toolsView, apiView, navigate: selectWorkspace }),
});
mountAiView(document, ai);
for (const source of [controller, tools, files, api]) source.subscribe(() => ai.sourcesChanged());
const shell = mountWorkspace(document, { data: controller, files, api, enterApi: () => apiView.enter() });
const $ = id => document.getElementById(id);
// Build defaults are public metadata only; no automatic login or config fetch.
$('connection-url').value = publicConfig.TELEGRAPH_URL;
$('connection-project').value = publicConfig.TELEGRAPH_PROJECT;
function selectConnection(connection) {
  ai.connect(connection);
  $('connection-state').textContent = connection ? `Configured · ${connection.api?.sanitize ? connection.api.sanitize(connection.metadata.project) : 'Session'}` : 'Not connected';
  $('disconnect').disabled = !connection;
  for (const id of ['console-link', 'files-console-link']) {
    if (connection?.metadata.managementUrl) $(id).href = connection.metadata.managementUrl;
    else $(id).removeAttribute('href');
  }
  tools.connect(connection);
  api.connect(connection);
  filesView.clearTransfers();
  files.connect(connection);
  controller.connect(connection);
  shell.setConnection(connection);
}
onConnectionChange(selectConnection);
try { selectConnection(getActiveConnection()); } catch { selectConnection(null); }
$('connection-form').addEventListener('submit', event => {
  event.preventDefault(); $('connection-error').textContent = '';
  try {
    const connection = createTelegraphConnection({
      TELEGRAPH_URL: $('connection-url').value.trim(),
      TELEGRAPH_PROJECT: $('connection-project').value.trim(),
      TELEGRAPH_API_KEY: $('connection-key').value,
    });
    setActiveConnection(connection);
    $('connection-settings').open = false;
  } catch { $('connection-error').textContent = 'Invalid runtime configuration. Use an HTTPS origin, project context and API key.'; }
  finally { $('connection-key').value = ''; }
});
$('disconnect').onclick = () => { setActiveConnection(null); $('connection-key').value = ''; $('connection-settings').open = true; };
window.addEventListener('pagehide', () => setActiveConnection(null));

function selectWorkspace(name) { shell.navigate(name, { activate: false }); }

$('data-tools').onclick = () => { selectWorkspace('tools'); $('tools-use-data').click(); };
