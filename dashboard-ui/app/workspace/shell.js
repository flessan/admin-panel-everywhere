/** Presentation only: navigation/preferences/shortcuts and projections of existing
 * controller state. No credential access, transport, storage or mutations. */
export const DESTINATIONS = Object.freeze([
  ['overview', 'Overview'], ['data/collections', 'Data · Collections'], ['data/records', 'Data · Records'], ['data/schema', 'Data · Schema'],
  ['files/objects', 'Files · Objects'], ['files/buckets', 'Files · Buckets'],
  ['api/explorer', 'API · Explorer'], ['api/openapi', 'API · OpenAPI'], ['api/history', 'API · Requests'], ['api/overview', 'API · Overview'],
  ['tools/import', 'Tools · Import'], ['tools/export', 'Tools · Export'], ['tools/bulk', 'Tools · Bulk Actions'], ['tools/json', 'Tools · JSON'],
  ['tools/duplicate', 'Tools · Duplicate'], ['tools/api', 'Tools · API builder'], ['tools/media', 'Tools · Media'], ['ai', 'Tools · AI assist'],
  ['connections/telegraph', 'Connections · Telegraph Cloud'], ['connections/other', 'Connections · Other Connections'], ['settings', 'Settings'],
]);
const DEFAULTS = { data: 'records', files: 'objects', api: 'explorer', tools: 'import', connections: 'telegraph' };
const PANELS = ['overview', 'data', 'files', 'api', 'tools', 'ai', 'connections', 'settings'];
const TAB_ROUTES = { 'records-tab': 'data/records', 'schema-tab': 'data/schema',
  ...Object.fromEntries(['overview', 'explorer', 'openapi', 'history'].map(name => [`api-${name}-tab`, `api/${name}`])),
  ...Object.fromEntries(['import', 'export', 'bulk', 'json', 'duplicate', 'api', 'media'].map(name => [`tools-${name}-tab`, `tools/${name}`])),
  'connections-telegraph-tab': 'connections/telegraph', 'connections-other-tab': 'connections/other',
};
const routeFor = input => { const route = Object.hasOwn(DEFAULTS, input) ? `${input}/${DEFAULTS[input]}` : input; return DESTINATIONS.some(([id]) => id === route) ? route : 'overview'; };

export function mountWorkspace(document, { data, files, api, enterApi = () => {} } = {}) {
  const $ = id => document.getElementById(id), window = document.defaultView;
  let route = 'overview', connection = null, drawerOpen = false, returnFocus = null, toastTimer, copyRevision = 0, navigating = false;
  const cached = {}, cleanups = [], lastRoutes = new Map();
  const media = window.matchMedia?.('(max-width: 960px)');
  const mobile = () => media ? media.matches : window.innerWidth <= 960;
  const listen = (node, event, action) => { node.addEventListener(event, action); cleanups.push(() => node.removeEventListener(event, action)); };
  const text = (id, value) => { $(id).textContent = value; };
  function writeHash(next, replace = false) {
    const hash = `#/${next}`;
    if (window.location.hash === hash) return;
    try { window.history[replace ? 'replaceState' : 'pushState'](null, '', hash); } catch { /* Embedded previews may restrict history. Navigation still works. */ }
  }
  function setDrawer(open, restore = false) {
    drawerOpen = open && mobile();
    $('app-sidebar').classList.toggle('is-open', drawerOpen);
    $('app-sidebar').inert = mobile() && !drawerOpen;
    $('main-content').inert = drawerOpen; $('workspace-header').inert = drawerOpen;
    document.querySelector('.skip-link').inert = drawerOpen; document.body.classList.toggle('navigation-open', drawerOpen);
    $('navigation-scrim').hidden = !drawerOpen;
    $('open-navigation').setAttribute('aria-expanded', String(drawerOpen));
    if (drawerOpen) $('close-navigation').focus({ preventScroll: true });
    else if (restore) $('open-navigation').focus();
  }
  function syncNavigation() {
    const [workspace] = route.split('/'), group = workspace === 'ai' ? 'tools' : workspace;
    lastRoutes.set(workspace, route);
    for (const name of PANELS) {
      $(`${name}-workspace`).hidden = name !== workspace;
      const button = $(`${name}-workspace-tab`);
      button.classList.toggle('is-active', name === group);
      button.removeAttribute('aria-current');
      if (name === workspace && !route.includes('/')) button.setAttribute('aria-current', 'page');
      if (button.hasAttribute('aria-expanded')) button.setAttribute('aria-expanded', String(name === group));
    }
    for (const children of document.querySelectorAll('[data-nav-group]')) children.hidden = children.dataset.navGroup !== group;
    for (const item of document.querySelectorAll('.nav-sub')) {
      if (item.dataset.route === route) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    }
    text('workspace-breadcrumb', DESTINATIONS.find(([id]) => id === route)[1].replace(' · ', ' / '));
    document.title = `${DESTINATIONS.find(([id]) => id === route)[1]} · Admin Panel Everywhere`;
  }
  function navigate(input, { focus = false, history = true, activate = true } = {}) {
    if (document.querySelector('dialog[open]')) return false;
    let requested = Object.hasOwn(DEFAULTS, input) ? lastRoutes.get(input) ?? input : input;
    if (!activate && Object.hasOwn(DEFAULTS, input)) {
      const active = $(`${input}-workspace`).querySelector('[role=tab][aria-selected=true]');
      requested = TAB_ROUTES[active?.id] ?? input;
    }
    const next = routeFor(requested), [workspace, section] = next.split('/');
    route = next; navigating = true;
    syncNavigation();
    if (workspace === 'api') enterApi();
    if (activate) {
      const tabId = Object.entries(TAB_ROUTES).find(([, target]) => target === route)?.[0];
      if (tabId) $(tabId).click();
      if (route === 'data/collections') $('records-tab').click();
    }
    navigating = false;
    if (history) writeHash(route);
    setDrawer(false);
    if (focus) {
      const target = section === 'collections' ? $('collection-input') : section === 'buckets' ? $('bucket-input') : $(`${workspace}-workspace`).querySelector('h1');
      target?.focus();
    }
    return true;
  }
  for (const name of ['telegraph', 'other']) listen($(`connections-${name}-tab`), 'click', () => {
    for (const value of ['telegraph', 'other']) {
      $(`connections-${value}-panel`).hidden = value !== name;
      $(`connections-${value}-tab`).setAttribute('aria-selected', String(value === name));
    }
  });
  listen(document, 'click', event => {
    const link = event.target.closest('[data-route],.brand');
    if (link) { event.preventDefault(); navigate(link.dataset.route ?? 'overview', { focus: true }); }
    const tab = event.target.closest('[role=tab]');
    if (tab && TAB_ROUTES[tab.id] && !navigating) {
      const next = TAB_ROUTES[tab.id];
      // A hidden/programmatically clicked tab must not unexpectedly navigate away
      // from the visible workspace (e.g. a controller resetting on disconnect).
      if (next.split('/')[0] === route.split('/')[0]) { route = next; syncNavigation(); writeHash(route); }
    }
  });
  listen(window, 'hashchange', () => {
    if (!navigate(window.location.hash.replace(/^#\/?/, ''), { history: false, focus: true })) writeHash(route, true);
  });
  listen($('open-navigation'), 'click', () => setDrawer(true));
  listen($('close-navigation'), 'click', () => setDrawer(false, true));
  listen($('navigation-scrim'), 'click', () => setDrawer(false, true));
  if (media?.addEventListener) listen(media, 'change', () => setDrawer(false));
  else listen(window, 'resize', () => setDrawer(false));

  function notify(message) {
    clearTimeout(toastTimer); text('workspace-feedback', message); $('workspace-feedback').hidden = false;
    toastTimer = setTimeout(() => { $('workspace-feedback').hidden = true; }, 5000);
  }
  async function copy(value, element) {
    const revision = copyRevision;
    try { await window.navigator.clipboard.writeText(value); if (revision === copyRevision) notify('Copied to clipboard.'); }
    catch {
      if (revision !== copyRevision) return;
      if (element) {
        const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
        element.parentElement?.closest('details')?.setAttribute('open', '');
      }
      notify('Clipboard unavailable. The text is selected; copy it with Ctrl/⌘ C.');
    }
  }
  listen(document, 'click', event => {
    const button = event.target.closest('[data-copy-target],[data-copy-text]'); if (!button) return;
    const target = button.dataset.copyTarget ? $(button.dataset.copyTarget) : button.parentElement.firstChild;
    if (target) void copy(button.dataset.copyText ?? target.textContent, target);
  });

  function openDialog(id) {
    if (document.querySelector('dialog[open]')) return;
    returnFocus = document.activeElement; setDrawer(false);
    const dialog = $(id); if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    if (id === 'command-dialog') { $('command-search').value = ''; renderCommands(); $('command-search').focus(); }
    else $('shortcuts-close').focus();
  }
  function closeDialog(id) {
    const dialog = $(id); if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
    const target = returnFocus;
    if (target && !target.closest('[hidden]') && !(mobile() && target.closest('#app-sidebar'))) target.focus();
    else $('command-open').focus();
  }
  function renderCommands() {
    const query = $('command-search').value.toLowerCase().trim(), list = $('command-results'); list.replaceChildren();
    for (const [id, label] of DESTINATIONS.filter(([, label]) => label.toLowerCase().includes(query))) {
      const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = () => { closeDialog('command-dialog'); navigate(id, { focus: true }); }; li.append(button); list.append(li);
    }
    $('command-empty').hidden = list.children.length > 0;
  }
  listen($('command-open'), 'click', () => openDialog('command-dialog'));
  listen($('shortcuts-open'), 'click', () => openDialog('shortcuts-dialog'));
  for (const name of ['command', 'shortcuts']) {
    listen($(`${name}-close`), 'click', () => closeDialog(`${name}-dialog`));
    listen($(`${name}-dialog`), 'cancel', event => { event.preventDefault(); closeDialog(`${name}-dialog`); });
  }
  listen($('command-search'), 'input', renderCommands);
  listen($('command-dialog'), 'keydown', event => {
    const buttons = [...$('command-results').querySelectorAll('button')];
    if (event.key === 'Enter' && event.target === $('command-search')) { event.preventDefault(); buttons[0]?.click(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(document.activeElement);
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
  if (/Mac|iPhone|iPad/.test(window.navigator.platform)) $('command-open').querySelector('kbd').textContent = '⌘ K';

  function syncTabs(group) {
    const tabs = [...group.querySelectorAll('[role=tab]')];
    for (const tab of tabs) tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
  }
  for (const group of document.querySelectorAll('[role=tablist]')) syncTabs(group);
  const observer = new window.MutationObserver(mutations => {
    for (const mutation of mutations) {
      const tab = mutation.target, group = tab.closest('[role=tablist]'); if (group) syncTabs(group);
      if (tab.getAttribute('aria-selected') === 'true' && TAB_ROUTES[tab.id]?.split('/')[0] === route.split('/')[0]) {
        const next = TAB_ROUTES[tab.id];
        if (route === 'data/collections' && next === 'data/records') continue;
        if (next !== route) { route = next; syncNavigation(); writeHash(route, true); }
      }
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
  listen(document, 'keydown', event => {
    if (event.defaultPrevented || event.isComposing) return;
    if (drawerOpen) {
      if (event.key === 'Escape') { event.preventDefault(); setDrawer(false, true); return; }
      if (event.key === 'Tab') {
        const items = [...$('app-sidebar').querySelectorAll('a[href],button:not(:disabled)')].filter(item => !item.closest('[hidden]'));
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    const editing = event.target.closest('input,textarea,select,[contenteditable=true]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openDialog('command-dialog'); return; }
    if (!editing && !event.ctrlKey && !event.metaKey && event.key === '?') { event.preventDefault(); openDialog('shortcuts-dialog'); return; }
    const tab = event.target.closest('[role=tab]'), group = tab?.closest('[role=tablist]');
    if (!group || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...group.querySelectorAll('[role=tab]')].filter(item => !item.disabled);
    const index = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].focus(); tabs[next].click();
  });
  for (const [id, key] of [['setting-theme', 'theme'], ['setting-density', 'density'], ['setting-wrap', 'wrap']]) {
    listen($(id), 'change', () => {
      document.documentElement.dataset[key] = key === 'wrap' ? String($(id).checked) : $(id).value;
      text('settings-feedback', 'Display preference applied to this tab. Nothing is saved to browser storage.');
    });
  }
  function renderEmpty(name, state) {
    if (!state) return;
    const value = name === 'data' ? state.records : state.objects, selected = name === 'data' ? state.collection : state.bucket;
    const localSheetRows = name === 'data' ? document.querySelectorAll('#record-table tbody tr:not(.sheet-empty)').length : 0;
    const empty = $(`${name}-empty-state`); empty.hidden = Boolean(value.items?.length || localSheetRows || (name === 'files' && value.commonPrefixes?.length));
    const loading = value.status === 'loading', failed = value.status === 'error';
    text(`${name}-empty-title`, !state.connected ? 'No active connection' : loading ? `Loading ${name === 'data' ? 'records' : 'objects'}…` : failed ? 'This view could not be loaded' : !selected ? `Choose a ${name === 'data' ? 'collection' : 'bucket'}` : 'Nothing in this view yet');
    text(`${name}-empty-description`, !state.connected ? 'Configure a backend to start working. Your credentials stay in this tab.' : loading ? 'Waiting for the connected backend.' : failed ? 'Review the error above, then retry when you are ready.' : !selected ? `Open an exact ${name === 'data' ? 'collection' : 'bucket'} name in the browser panel.` : name === 'data' ? 'Try different filters, or create a record with the normal validation flow.' : 'Try another prefix, or upload an object to this bucket.');
    $(`${name}-loading-progress`).hidden = !loading;
    const button = $(`${name}-empty-action`); button.hidden = loading;
    button.textContent = !state.connected ? 'Configure connection' : failed ? 'Retry loading' : !selected ? `Choose ${name === 'data' ? 'collection' : 'bucket'}` : name === 'data' ? 'Create record' : 'Upload object';
    button.onclick = () => {
      if (!state.connected) navigate('connections', { focus: true });
      else if (failed) $(name === 'data' ? 'refresh-records' : 'files-refresh').click();
      else if (!selected) $(name === 'data' ? 'collection-input' : 'bucket-input').focus();
      else if (name === 'data') $('create-record').click();
      else { $('upload-panel').open = true; $('upload-file').focus(); }
    };
  }
  function renderOverview() {
    const connected = Boolean(connection), sanitize = value => connection?.api?.sanitize ? connection.api.sanitize(value) : 'Not exposed';
    const metadata = connected ? sanitize({ connector: connection.metadata.connector, baseUrl: connection.metadata.baseUrl, project: connection.metadata.project }) : {};
    text('sidebar-connection', connected ? 'Session configured' : 'Not connected'); $('sidebar-dot').classList.toggle('configured', connected);
    text('overview-status', connected ? 'Configured' : 'Not configured'); $('overview-status').classList.toggle('configured', connected);
    text('overview-connection-title', connected ? 'Your connection is configured' : 'Connect your workspace');
    text('overview-connection-description', connected ? 'Your key stays in memory. Each request is authenticated and validated by your backend.' : 'Bring your data, files, and API into one place. Start with a Telegraph Cloud connection.');
    text('overview-connect', connected ? 'Connection settings →' : 'Connect backend →');
    text('overview-connector', metadata.connector === 'telegraph' ? 'Telegraph Cloud' : metadata.connector ?? 'None selected');
    text('overview-origin', metadata.baseUrl ?? 'Not configured'); text('overview-project', metadata.project ?? 'Not configured');
    text('overview-collections', connected ? cached.data?.collections.items.length ?? 0 : '—');
    text('overview-collections-note', connected ? 'Known names, not a complete catalog' : 'Connect to discover known names');
    text('overview-buckets', connected ? cached.files?.buckets.items.length ?? 0 : '—');
    text('overview-operations', cached.api?.status === 'ready' ? cached.api.operations.length : '—');
    text('overview-operations-note', cached.api?.status === 'ready' ? 'Documented by the loaded OpenAPI' : 'Load an OpenAPI document');
    const history = cached.api?.history ?? []; text('overview-requests', history.length);
    $('overview-request-empty').hidden = history.length > 0; $('overview-request-list').hidden = !history.length;
    $('overview-request-list').replaceChildren();
    for (const entry of history.slice(0, 4)) {
      const row = document.createElement('li'), operation = document.createElement('code'), status = document.createElement('span'), time = document.createElement('time');
      operation.textContent = entry.operation; status.className = 'pill'; status.textContent = entry.response.status ? `HTTP ${entry.response.status}` : 'No response';
      time.textContent = entry.timestamp; row.append(operation, status, time); $('overview-request-list').append(row);
    }
  }
  for (const [name, source] of Object.entries({ data, files, api })) if (source) cleanups.push(source.subscribe(state => {
    cached[name] = state; if (['data', 'files'].includes(name)) renderEmpty(name, state); renderOverview();
  }));
  setDrawer(false);
  navigate(window.location.hash.replace(/^#\/?/, '') || 'overview', { history: false }); writeHash(route, true);
  return { navigate, snapshot: () => ({ route, drawerOpen }),
    setConnection(next) { connection = next; copyRevision++; clearTimeout(toastTimer); $('workspace-feedback').hidden = true; renderOverview(); if (route.startsWith('api/')) enterApi(); },
    dispose() { observer.disconnect(); clearTimeout(toastTimer); for (const cleanup of cleanups) cleanup(); },
  };
}
