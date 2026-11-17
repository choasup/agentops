const modelProviders = {
  deepseek: {name:'DeepSeek', icon:'providers/deepseek.svg', url:'https://api.deepseek.com/chat/completions', model:'deepseek-v4-flash'},
  bailian: {name:'Alibaba Cloud Bailian', icon:'providers/bailian.svg', url:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model:'qwen-plus'},
  custom: {name:'OpenAI-compatible', glyph:'terminal', url:'', model:''}
};
const modelFilters = {query:'', provider:''};

function providerMark(vendor) {
  const provider = modelProviders[vendor] ?? modelProviders.custom;
  const mark = element('span', undefined, 'provider-mark ' + vendor);
  mark.setAttribute('aria-hidden', 'true');
  if (provider.icon) {
    const image = element('img');
    image.src = provider.icon;
    image.alt = '';
    mark.append(image);
  } else {
    mark.append(icon(provider.glyph));
  }
  return mark;
}

function modelStatus(model) {
  const status = model.check?.status;
  if (status === 'ready') return element('span', 'Verified', 'pill success');
  if (status === 'failed') return element('span', 'Check failed', 'pill error');
  return element('span', 'Untested', 'pill');
}

function providerCards() {
  const grid = element('div', undefined, 'provider-grid');
  for (const [vendor, provider] of Object.entries(modelProviders)) {
    const card = element('button', undefined, 'provider-card');
    card.type = 'button';
    const identity = element('span', undefined, 'provider-identity');
    const text = element('span');
    text.append(element('strong', provider.name), element('small', provider.model || 'Your endpoint'));
    identity.append(providerMark(vendor), text);
    const action = element('span', 'Connect', 'provider-action');
    action.append(icon('arrow'));
    card.append(identity, action);
    card.addEventListener('click', () => showModelEditor(null, vendor));
    grid.append(card);
  }
  return grid;
}

function chooseModelProvider() {
  const grid = providerCards();
  grid.classList.add('provider-picker');
  openModal('Add a model', [grid]);
}

async function refreshModels() {
  const next = await platformRequest();
  if (activeModule !== 'models' || platformContent.hidden) return;
  records = next;
  renderModule('models');
}

function showModelEditor(existing, vendor) {
  const selection = existing?.vendor ?? vendor ?? 'custom';
  const preset = modelProviders[selection] ?? modelProviders.custom;
  const provider = field('vendor', 'Provider', Object.entries(modelProviders).map(([id, item]) => [id, item.name]));
  const select = provider.querySelector('select');
  select.value = selection;
  const name = field('name', 'Connection name', 'text', existing?.name ?? preset.name);
  const url = field('url', 'Chat Completions URL', 'url', existing?.url ?? preset.url);
  const model = field('model', 'Model ID', 'text', existing?.model ?? preset.model);
  const key = field('api_key', existing?.has_api_key ? 'New API key (optional)' : 'Provider API key', 'password');
  const keyInput = key.querySelector('input');
  const nameInput = name.querySelector('input');
  const urlInput = url.querySelector('input');
  const modelInput = model.querySelector('input');
  urlInput.placeholder = 'https://api.example.com/v1/chat/completions';
  keyInput.autocomplete = 'off';
  keyInput.required = !existing?.has_api_key && selection !== 'custom';
  if (existing?.has_api_key) keyInput.placeholder = 'Leave blank to keep the current key';

  let previous = preset;
  select.addEventListener('change', () => {
    const next = modelProviders[select.value] ?? modelProviders.custom;
    if (!nameInput.value || nameInput.value === previous.name) nameInput.value = next.name;
    urlInput.value = next.url;
    modelInput.value = next.model;
    keyInput.value = '';
    keyInput.required = !existing?.has_api_key && select.value !== 'custom';
    previous = next;
  });

  const form = formPanel(existing ? 'Connection settings' : preset.name,
    [provider, name, model, url, key], existing ? 'Save changes' : 'Add connection', async data => {
      const saved = await platformRequest(existing ? '/models-update' : '/models',
        existing ? {...data, provider:existing.id} : data);
      await refreshModels();
      if (byId('modal').open) showModelDetail(saved);
    });
  openModal(existing ? 'Edit connection' : 'Add connection', [form]);
}

function showModelDetail(model, test = false) {
  const vendor = model.vendor ?? 'custom';
  const provider = modelProviders[vendor] ?? modelProviders.custom;
  const connections = ofKind('agent').filter(agent => agent.provider === model.id);
  const identity = element('div', undefined, 'model-detail-head');
  identity.append(providerMark(vendor), element('strong', provider.name), modelStatus(model));

  const facts = element('dl', undefined, 'model-facts');
  for (const [label, value] of [
    ['Model ID', model.model], ['Endpoint', model.url],
    ['Credential', model.has_api_key ? 'API key saved' : 'No API key'],
    ['Last checked', model.check ? timeLabel(model.check.at) : '—'],
    ['Used by', connections.map(agent => agent.name).join(', ') || 'No agents']
  ]) {
    facts.append(element('dt', label), element('dd', value));
  }

  const body = element('div', undefined, 'model-detail');
  const mode = element('div', undefined, 'trace-tabs model-tabs');
  const overview = element('button', 'Overview', 'trace-tab');
  const check = element('button', 'Test connection', 'trace-tab');
  mode.append(overview, check);
  const overviewPanel = element('div');
  const controls = element('div', undefined, 'model-actions');
  if (location.protocol === 'https:') {
    const edit = iconButton('edit', 'Edit connection');
    edit.addEventListener('click', () => showModelEditor(model));
    controls.append(edit);
    const removal = element('details', undefined, 'model-removal');
    removal.append(element('summary', 'Remove connection'));
    const status = element('p');
    status.setAttribute('role', 'status');
    if (connections.length) {
      removal.append(element('p', 'Reassign the connected agents before removing this model.'));
    } else {
      const remove = element('button', 'Confirm removal', 'button danger');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await platformRequest('/models-delete', {provider:model.id});
          byId('modal').close();
          await refreshModels();
        } catch (error) {
          status.textContent = error.message;
          remove.disabled = false;
        }
      });
      removal.append(remove);
    }
    removal.append(status);
    overviewPanel.append(facts, controls, removal);
  } else {
    overviewPanel.append(facts);
  }

  const result = element('div', undefined, 'model-check-result');
  result.setAttribute('aria-live', 'polite');
  const message = field('message', 'Test message', 'textarea', 'Reply with OK.');
  const testPanel = formPanel('Send a test request', [message], 'Run test', async data => {
    result.replaceChildren(element('p', 'Waiting for the provider…'));
    try {
      const reply = await platformRequest('/model-test', {provider:model.id, message:data.message});
      const metrics = element('div', undefined, 'trace-meta');
      metrics.append(modelStatus({check:{status:'ready'}}),
        element('span', number.format(reply.tokens ?? 0) + ' tokens', 'pill'));
      if (typeof reply.duration === 'number') metrics.append(element('span', latency(reply.duration), 'pill'));
      result.replaceChildren(metrics, element('pre', reply.output));
    } catch (error) {
      result.replaceChildren(modelStatus({check:{status:'failed'}}), element('p', error.message));
    }
    try {
      await refreshModels();
      const refreshed = ofKind('model').find(candidate => candidate.id === model.id);
      if (refreshed) {
        identity.lastElementChild.replaceWith(modelStatus(refreshed));
        facts.querySelectorAll('dd')[3].textContent = refreshed.check ? timeLabel(refreshed.check.at) : '—';
      }
    } catch {
      // The result remains available even if the connection list cannot be refreshed.
    }
  });
  function selectTab(isTest) {
    overview.setAttribute('aria-pressed', String(!isTest));
    check.setAttribute('aria-pressed', String(isTest));
    overviewPanel.hidden = isTest;
    testPanel.hidden = !isTest;
    result.hidden = !isTest;
  }
  overview.addEventListener('click', () => selectTab(false));
  check.addEventListener('click', () => selectTab(true));
  selectTab(test);
  body.append(identity, mode, overviewPanel, testPanel, result);
  openModal(model.name, [body]);
}

function modelsWorkspace() {
  const workspace = element('div', undefined, 'models-workspace wide');
  const connections = ofKind('model');
  const catalogue = element('section', undefined, 'model-catalogue');
  catalogue.append(element('h2', 'Use your own provider key'), providerCards());
  if (!connections.length) {
    workspace.append(catalogue);
    return workspace;
  }

  const panel = element('section', undefined, 'panel model-library');
  const head = element('header', undefined, 'model-library-header');
  const title = element('div');
  const count = element('p');
  title.append(element('h2', 'Connections'), count);
  const filters = element('div', undefined, 'filters');
  const search = element('input');
  search.type = 'search';
  search.placeholder = 'Search models…';
  search.value = modelFilters.query;
  search.setAttribute('aria-label', 'Search models');
  const providerFilter = element('select');
  providerFilter.setAttribute('aria-label', 'Filter by provider');
  providerFilter.append(new Option('All providers', ''), ...Object.entries(modelProviders).map(([id, provider]) => new Option(provider.name, id)));
  providerFilter.value = modelFilters.provider;
  filters.append(search, providerFilter);
  head.append(title, filters);

  const tableWrap = element('div', undefined, 'table-wrap');
  const table = element('table');
  table.setAttribute('aria-label', 'Model connections');
  const thead = element('thead');
  const header = element('tr');
  for (const title of ['Connection', 'Status', 'Used by', 'Last checked', 'Actions']) {
    const cell = element('th', title);
    cell.scope = 'col';
    header.append(cell);
  }
  thead.append(header);
  const rows = element('tbody');
  table.append(thead, rows);
  tableWrap.append(table);
  panel.append(head, tableWrap);

  const usage = new Map();
  for (const agent of ofKind('agent')) {
    if (agent.provider) usage.set(agent.provider, (usage.get(agent.provider) ?? 0) + 1);
  }

  function renderConnections() {
    const query = search.value.trim().toLowerCase();
    const filtered = connections.filter(model => {
      const vendor = model.vendor ?? 'custom';
      return (!providerFilter.value || vendor === providerFilter.value) &&
        [model.name, model.model, modelProviders[vendor]?.name, model.url]
          .some(value => value?.toLowerCase().includes(query));
    });
    count.textContent = number.format(filtered.length) + (filtered.length === 1 ? ' model' : ' models');
    rows.replaceChildren(...filtered.map(model => {
      const vendor = model.vendor ?? 'custom';
      const identity = element('div', undefined, 'model-row-identity');
      const text = element('div');
      const link = element('button', model.name, 'agent-name');
      link.addEventListener('click', () => showModelDetail(model));
      text.append(link, element('p', model.model));
      identity.append(providerMark(vendor), text);
      const row = element('tr');
      const agentCount = usage.get(model.id) ?? 0;
      const test = iconButton('play', 'Test');
      test.setAttribute('aria-label', 'Test ' + model.name);
      test.addEventListener('click', () => showModelDetail(model, true));
      for (const value of [
        identity, modelStatus(model), number.format(agentCount) + (agentCount === 1 ? ' agent' : ' agents'),
        model.check ? timeLabel(model.check.at) : '—', test
      ]) {
        const cell = element('td');
        cell.append(value);
        row.append(cell);
      }
      return row;
    }));
    if (!filtered.length) {
      const row = element('tr');
      const empty = element('td', 'No matching models.', 'empty');
      empty.colSpan = 5;
      row.append(empty);
      rows.append(row);
    }
  }
  search.addEventListener('input', () => {modelFilters.query = search.value; renderConnections();});
  providerFilter.addEventListener('change', () => {modelFilters.provider = providerFilter.value; renderConnections();});
  renderConnections();
  workspace.append(panel, catalogue);
  return workspace;
}
