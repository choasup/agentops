const platformContent = byId('platform-content');
const modules = {
  billing: ['Billing', 'Manage your balance, review usage, and access API keys.'],
  skills: ['Skills', 'Save reusable instructions that Agents can apply.'],
  connections: ['Connections', 'Connect tools that your Agents can use.'],
  models: ['Models', 'Manage the model connections your agents run on.'],
  datasets: ['Datasets', 'Curate examples and reference outputs for evaluation.'],
  experiments: ['Experiments', 'Evaluate prompt versions against a dataset and compare scores.'],
  feedback: ['Review Queue', 'Score ingested traces and record reviewer feedback.'],
  prompts: ['Prompts', 'Save and reuse prompt template versions.'],
  playground: ['Playground', 'Test prompt versions with your inputs.'],
  deployments: ['Deployments', 'Inspect the active versions in each environment.'],
  agent: ['Agent', ''],
  'console-agents': ['Agents', 'Evaluate and monitor your Agents.'],
  agents: ['All agents', 'Find your agents, check recent activity, and manage integrations.'],
  studio: ['Studio', 'Try a test message with a Studio agent or deployment.']
};
let activeModule;
let moduleRequest = 0;
let records = [];
let apiKeys = [];
let billing;
let workspaceCatalog;
let hostedModelAvailable = false;
const billingMoney = nanos => new Intl.NumberFormat('en-US', {
  style:'currency', currency:'USD', maximumFractionDigits:9
}).format(nanos / 1e9);
const registryFilters = {query:'', source:'', activity:'', sort:'recent'};
let lastStudioTarget;
let refreshWorkspaceView;
document.addEventListener('tracesupdated', () => refreshWorkspaceView?.());

function timeLabel(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
}

async function keyRequest(path = '', data) {
  const response = await fetch('/api/keys' + path, data === undefined ? {cache:'no-store'} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'API key request failed');
  return result;
}

async function billingRequest(path = '', data) {
  const response = await fetch('/api/billing' + path, data === undefined ? {cache:'no-store'} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
  });
  if (!path && (response.status === 404 || response.status === 401)) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Billing request failed');
  return result;
}

function traceLink(id) {
  const link = element('a', 'View trace');
  const url = new URL('/', location.origin);
  url.searchParams.set('trace', id);
  link.href = url.href;
  return link;
}

function billingPanels() {
  const amount = element('strong', undefined, 'balance-amount');
  amount.append(icon('wallet'), element('span', billingMoney(billing.balance_nanos)));
  const balance = listPanel('Account balance', [amount]);
  if (billing.reserved_nanos) balance.append(element('p', billingMoney(billing.reserved_nanos) + ' reserved for active requests'));
  const returned = new URL(location.href).searchParams.get('checkout');
  if (returned === 'complete') balance.append(element('p', 'Balance updates when payment is confirmed. Refresh to check the ledger.'));
  if (!billing.payments_available) balance.append(element('p', 'Top-ups are currently unavailable.'));
  else {
    const amounts = billing.topups.map(cents => [String(cents), billingMoney(cents * 1e7)]);
    const topup = formPanel('Top up', [field('cents', 'Amount', amounts)], 'Continue to Stripe', async data => {
      const result = await billingRequest('/checkout', {cents:Number(data.cents)});
      location.assign(result.url);
    });
    balance.append(topup.querySelector('form'));
  }
  if (!billing.entries.length) return [balance, listPanel('Recent billing activity', [])];
  const entries = element('div', undefined, 'billing-entries');
  entries.append(...billing.entries.map(entry => {
    const item = element('div', undefined, 'billing-entry');
    const key = apiKeys.find(key => key.id === entry.key_id);
    const usage = Boolean(entry.model);
    const label = usage ? (key?.name ?? (entry.key_id ? 'API key' : 'Workspace run')) + ' · ' + entry.model :
      entry.reference.startsWith('test-credit:') ? 'Test credit' : 'Top-up';
    item.append(
      element('strong', label),
      element('span', (usage ? '−' : '+') + billingMoney(Math.abs(entry.nanos))),
      element('small', timeLabel(entry.at))
    );
    if (usage) item.append(element('small',
      number.format(entry.input_tokens) + ' input (' + number.format(entry.cached_tokens) +
      ' cached) · ' + number.format(entry.output_tokens) + ' output'), traceLink(entry.reference));
    return item;
  }));
  return [balance, listPanel('Recent billing activity', [entries])];
}

function hostedModelPanel() {
  const identity = element('div', undefined, 'provider-identity');
  const enabled = billing.model_available;
  identity.append(providerMark('deepseek'), element('strong', billing.model),
    element('span', enabled ? 'Enabled' : 'Platform setup required', enabled ? 'pill success' : 'pill'));
  const panel = listPanel('Hosted models', [identity]);
  panel.classList.add('wide', 'hosted-model-panel');
  if (!enabled) {
    panel.append(element('p', 'Agent Deck hasn’t configured its DeepSeek API key yet. To use your own DeepSeek key, add a connection below.'));
    return panel;
  }
  const price = element('p', billingMoney(billing.prices.cached * 1e6) + ' cached input · ' +
    billingMoney(billing.prices.input * 1e6) + ' input · ' + billingMoney(billing.prices.output * 1e6) + ' output per 1M tokens');
  const keys = iconButton('wallet', 'Open billing', 'button');
  keys.addEventListener('click', () => loadModule('billing'));
  panel.append(price, keys);
  return panel;
}

const ofKind = kind => records.filter(record => record.kind === kind);
const hostedProvider = 'hosted:deepseek';
const recordName = id => id === hostedProvider ? 'DeepSeek Flash · Hosted' : records.find(record => record.id === id)?.name ?? id;
const studioModels = () => [
  ...(hostedModelAvailable ? [[hostedProvider, recordName(hostedProvider)]] : []),
  ...ofKind('model').map(model => [model.id, model.name])
];
const promptOptions = () => ofKind('prompt').map(record => {
  const history = ofKind('prompt').filter(item => item.name === record.name);
  return [record.id, record.name + ' · v' + (history.length - history.indexOf(record))];
});

function platformRequest(path = '', data) {
  if (path || data !== undefined) {
    return requestPlatform(path, data).then(({value}) => {
      if (data !== undefined && path !== '/runs') workspaceCatalog = undefined;
      return value;
    });
  }
  if (workspaceCatalog && Date.now() < workspaceCatalog.expires) return workspaceCatalog.promise;
  const entry = {expires:Infinity};
  workspaceCatalog = entry;
  entry.promise = requestPlatform('').then(({value, response}) => {
    entry.expires = Date.now() + 15_000;
    if (workspaceCatalog === entry) hostedModelAvailable =
      response.headers.get('X-Agent-Deck-Hosted-Model') === 'available';
    return value;
  }).catch(error => {
    if (workspaceCatalog === entry) workspaceCatalog = undefined;
    throw error;
  });
  return entry.promise;
}

async function requestPlatform(path, data) {
  const response = await fetch('/api/platform' + path, data === undefined ? {cache:'no-store'} : {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? 'Request failed'), {status:response.status});
  return {value, response};
}

function field(name, label, type = 'text', value = '') {
  const wrapper = element('label', label);
  let input;
  if (Array.isArray(type)) {
    input = element('select');
    input.append(new Option(type.length ? 'Select…' : 'No available options', ''));
    for (const [id, text] of type) input.append(new Option(text, id));
  } else {
    input = element(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.value = value;
  }
  input.name = name;
  input.required = true;
  wrapper.append(input);
  return wrapper;
}

function formPanel(title, fields, label, action) {
  const section = element('section', undefined, 'panel module-panel');
  const form = element('form', undefined, 'module-form');
  const submit = element('button', label, 'button primary');
  submit.type = 'submit';
  const message = element('p');
  message.setAttribute('role', 'status');
  form.append(...fields, submit, message);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    message.textContent = '';
    try {
      await action(Object.fromEntries(new FormData(form)), section);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  section.append(element('h2', title), form);
  return section;
}

function listPanel(title, entries) {
  const section = element('section', undefined, 'panel module-panel');
  section.append(element('h2', title), ...(entries.length ? entries : [element('p', 'No records yet.')]));
  return section;
}

function expandable(label, data) {
  const item = element('details');
  item.append(element('summary', label), element('pre', JSON.stringify(data, null, 2)));
  return item;
}

function jsonInput(value) {
  try { return JSON.parse(value); }
  catch { throw new Error('Enter valid JSON. Use double quotes for a string.'); }
}

async function create(module, data) {
  await platformRequest('/' + module, data);
  await loadModule(module === 'examples' ? 'datasets' : module);
}

function traceLink(id, label) {
  const link = element('a', label);
  link.href = '/?trace=' + encodeURIComponent(id);
  return link;
}

async function addTraceExample(trace) {
  const message = element('p', 'Loading datasets…');
  openModal('Add to dataset', [message]);
  try {
    const catalog = await platformRequest();
    if (!message.isConnected || !byId('modal').open) return;
    const datasets = catalog.filter(item => item.kind === 'dataset');
    const dataset = field('dataset', 'Dataset', datasets.map(item => [item.id, item.name]));
    if (datasets.length === 1) dataset.querySelector('select').value = datasets[0].id;
    const input = field('input', 'Input', 'textarea', trace.input);
    const expected = field('expected', 'Reference answer or required text', 'textarea');
    const match = field('match', 'Pass when the reply', [
      ['exact', 'Matches exactly'], ['contains', 'Contains the required text']
    ]);
    match.querySelector('select').value = 'exact';
    let createdDataset;
    const form = formPanel('', [datasets.length ? dataset : field('name', 'New dataset name'),
      input, expected, match], 'Save example', async data => {
      const destination = data.dataset ?? (createdDataset ??= (await platformRequest('/datasets', {name:data.name})).id);
      await platformRequest('/examples', {dataset:destination, input:data.input, expected:data.expected,
        match:data.match, source_trace:trace.id});
      const open = element('button', 'Open Datasets', 'button primary');
      open.addEventListener('click', () => {
        byId('modal').close();
        byId('trace-inspector').close();
        loadModule('datasets');
      });
      openModal('Example saved', [open]);
      open.focus();
    });
    form.firstElementChild.remove();
    const recorded = trace.error ?? trace.output;
    const observed = element('details', undefined, 'trace-sample-output');
    observed.append(element('summary', trace.error ? 'Inspect recorded error' : 'Inspect recorded reply'),
      element('pre', typeof recorded === 'string' ? recorded : JSON.stringify(recorded ?? null, null, 2)));
    openModal('Add to dataset', [observed, form]);
    input.querySelector('textarea').focus();
  } catch (error) {
    message.textContent = error.message;
  }
}

const connectionCatalogue = [
  {id:'cloudflare-docs', brand:'Cloudflare', logo:'cloudflare.png', name:'Cloudflare Documentation',
    access:'Read-only MCP', description:'Search public Cloudflare developer documentation.',
    source:'https://docs.mcp.cloudflare.com/mcp'},
  {id:'github-agentops', brand:'GitHub', logo:'github.svg', name:'GitHub · agentops',
    access:'Read-only connector', description:'Read the public README in choasup/agentops on main.',
    source:'https://github.com/choasup/agentops'}
];

function activeConnection(provider) {
  return ofKind('mcp_connection').find(item => !item.revoked &&
    (item.provider ?? 'cloudflare-docs') === provider.id);
}

function connectionIdentity(provider) {
  const identity = element('div', undefined, 'connection-identity');
  const logo = element('img');
  logo.src = 'connectors/' + provider.logo;
  logo.alt = '';
  identity.append(logo, element('span', provider.brand));
  return identity;
}

function openConnectionReview(provider, disconnect = false) {
  const connection = activeConnection(provider);
  const connected = Boolean(connection);
  const name = disconnect ? 'Disconnect ' : connected ? '' : 'Connect ';
  const details = [connectionIdentity(provider), element('p', provider.description),
    element('code', provider.source), element('p', provider.access)];
  if (connected && !disconnect) {
    openModal(provider.name, [...details, element('p', 'Already connected to this workspace.')]);
    return;
  }
  if (disconnect) details.push(element('p', 'Agents using this connection will need a different tool or a new connection.'));
  const form = formPanel(disconnect ? 'Review disconnection' : 'Review access', details,
    disconnect ? 'Disconnect' : 'Verify and connect', async () => {
      if (disconnect) await platformRequest('/mcp-disconnect', {connection:connection.id});
      else await platformRequest('/mcp-connect', {provider:provider.id});
      byId('modal').close();
      await loadModule('connections');
    });
  openModal(name + provider.name, [form]);
}

function connectionCard(provider) {
  const connection = activeConnection(provider);
  const card = element('section', undefined, 'panel module-panel connection-card');
  const state = element('span', connection ? 'Connected' : 'Available', connection ? 'pill success' : 'pill');
  const head = element('div', undefined, 'connection-card-head');
  head.append(connectionIdentity(provider), state);
  const action = iconButton(connection ? 'settings' : 'plus', connection ? 'Manage' : 'Connect', 'button');
  action.setAttribute('aria-label', (connection ? 'Manage ' : 'Connect ') + provider.name);
  action.addEventListener('click', () => {
    if (!connection) return openConnectionReview(provider);
    const disconnect = iconButton('close', 'Disconnect', 'button');
    disconnect.addEventListener('click', () => openConnectionReview(provider, true));
    openModal(provider.name, [connectionIdentity(provider), element('p', provider.description),
      element('p', provider.access), disconnect]);
  });
  const footer = element('div', undefined, 'connection-card-head');
  footer.append(element('span', provider.access, 'pill'), action);
  card.append(head, element('h2', provider.name), element('p', provider.description), footer);
  return card;
}

function openConnectionImport() {
  const fieldLabel = field('command', 'Connector link or MCP command', 'textarea');
  const input = fieldLabel.querySelector('textarea');
  input.rows = 2;
  input.placeholder = 'Paste a link or an MCP add command';
  const hint = element('p', 'Paste a link or a command you already have. Agent Deck uses it to find a supported connector and show its permissions.');
  hint.id = 'connection-import-hint';
  input.setAttribute('aria-describedby', hint.id);
  const form = formPanel('Find a connector', [fieldLabel, hint], 'Review access', data => {
    const entered = data.command.trim();
    const provider = connectionCatalogue.find(item => [item.source, item.id].includes(entered)) ??
      (/^(?:claude mcp add --transport http|codex mcp add) [\w-]+ (?:--url )?https:\/\/docs\.mcp\.cloudflare\.com\/mcp$/.test(entered)
        ? connectionCatalogue[0] : undefined);
    if (!provider) throw new Error('This connector is unavailable. Choose one of the connectors below.');
    openConnectionReview(provider);
  });
  form.firstElementChild.remove();
  form.classList.add('connection-install');
  const shortcuts = element('div', undefined, 'connection-shortcuts');
  shortcuts.append(element('h3', 'Choose a supported connector'));
  const actions = element('div', undefined, 'section-actions');
  for (const provider of connectionCatalogue) {
    const button = element('button', undefined, 'button');
    button.type = 'button';
    button.setAttribute('aria-label', provider.name);
    button.append(connectionIdentity(provider), element('span',
      provider.id === 'cloudflare-docs' ? 'Docs MCP' : 'agentops README'));
    button.addEventListener('click', () => openConnectionReview(provider));
    actions.append(button);
  }
  shortcuts.append(actions);
  openModal('Add by link or command', [form, shortcuts]);
}

function openSkillImport() {
  const picker = field('archive', 'Skill ZIP', 'file');
  const input = picker.querySelector('input');
  input.accept = '.zip,application/zip';
  const form = formPanel('Select a package', [picker,
    element('p', 'Choose a ZIP containing one SKILL.md. Agent Deck imports the instructions from that file.')],
  'Preview Skill', async () => {
    const {importSkillZip} = await import('./skill-zip.mjs');
    const skill = await importSkillZip(input.files[0]);
    const preview = formPanel(skill.name, [
      element('p', 'Attach this Skill in Studio → Configure when using Hosted DeepSeek. Bundled scripts and supporting files are skipped.'),
      element('pre', skill.instructions, 'skill-preview')
    ], 'Import Skill', async () => {
      await platformRequest('/skills', skill);
      byId('modal').close();
      await loadModule('skills');
    });
    const back = iconButton('arrow', 'Choose another ZIP', 'button quiet');
    back.addEventListener('click', openSkillImport);
    openModal('Review Skill', [preview, back]);
  });
  openModal('Import Skill', [form]);
}

function skillLibraryEntry(skill) {
  const detail = element('details', undefined, 'skill-library-item');
  const summary = element('summary');
  summary.append(element('strong', skill.name));
  if (skill.source) summary.append(element('span', skill.source, 'pill'));
  if (skill.description) summary.append(element('small', skill.description));
  detail.append(summary);
  if (skill.requires) {
    detail.append(element('p', 'Required connection: ' + (connectionCatalogue.find(item => item.id === skill.requires)?.name ?? skill.requires)));
  }
  if (skill.source_url) {
    const link = element('a', 'View original on GitHub');
    link.href = skill.source_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    detail.append(link);
  }
  detail.append(element('pre', skill.instructions, 'skill-preview'));
  return detail;
}

function renderModule(module, selectedTarget) {
  refreshWorkspaceView = undefined;
  const [title, description] = modules[module];
  const heading = element('div', undefined, 'module-heading');
  const headingText = element('div');
  headingText.append(element('h1', title), element('p', description));
  heading.append(headingText);
  const panels = [];
  const nameField = () => field('name', 'Name');
  const options = kind => ofKind(kind).map(item => [item.id, item.name]);
  const promptField = () => field('prompt', 'Prompt version', promptOptions());
  const inputField = () => field('input', 'Input JSON', 'textarea');

  if (module === 'skills') {
    const upload = iconButton('plus', 'Import ZIP', 'button primary');
    upload.addEventListener('click', openSkillImport);
    heading.append(upload);
    const skills = ofKind('skill');
    const workspaceSkills = skills.filter(skill => !skill.builtin);
    const features = skills.filter(skill => skill.builtin);
    if (features.length) {
      const builtin = listPanel('Built-in Skills', [element('p', 'Ready to add in Studio → Configure. Adapted for text-based runs.'),
        ...features.map(skillLibraryEntry)]);
      builtin.classList.add('wide');
      panels.push(builtin);
    }
    const library = listPanel('Workspace Skills', workspaceSkills.length ? workspaceSkills.map(skillLibraryEntry) :
      [element('p', 'Import a ZIP containing SKILL.md to add a workspace Skill.')]);
    library.classList.add('wide');
    panels.push(library);
  }

  if (module === 'connections') {
    const install = iconButton('terminal', 'Add by link or command', 'button');
    install.addEventListener('click', openConnectionImport);
    heading.append(install);
    panels.push(...connectionCatalogue.map(connectionCard));
  }

  if (module === 'models') {
    const connect = iconButton('plus', 'Add connection', 'button primary');
    connect.addEventListener('click', chooseModelProvider);
    heading.append(connect);
    if (billing) panels.push(hostedModelPanel());
    panels.push(modelsWorkspace());
  }

  if (module === 'billing') {
    const integration = selectedTarget?.source === 'external' ? selectedTarget : undefined;
    function backToIntegration() {
      const back = iconButton('arrow', 'Back to integration', 'button quiet setup-back');
      back.addEventListener('click', async () => {
        if (byId('modal').open) byId('modal').close();
        await openAgentDetail(integration.id, 'integration');
      });
      return back;
    }
    if (integration) heading.append(backToIntegration());
    if (billing) panels.push(...billingPanels());
    const keySection = element('section', undefined, 'billing-keys wide');
    keySection.id = 'billing-api-keys';
    keySection.append(element('h2', 'API Keys'));
    const keyPanels = element('div', undefined, 'module-grid');
    keySection.append(keyPanels);
    panels.push(keySection);
    const scopes = element('fieldset', undefined, 'key-scopes');
    scopes.append(element('legend', 'Permissions'));
    for (const [value, label] of [
      ['traces:read','Read traces'], ['traces:write','Send traces'], ['agents:run','List and run agents'], ['agents:create','Create agents and list models'],
      ...(billing ? [['models:invoke','Call hosted models']] : [])
    ]) {
      const option = element('input');
      option.type = 'checkbox';
      option.value = value;
      option.checked = Boolean(integration && value === 'traces:write');
      const wrapper = element('label');
      wrapper.append(option, document.createTextNode(label));
      scopes.append(wrapper);
    }
    const keyName = integration ? field('name', 'Name', 'text', 'Trace · ' + integration.name.slice(0, 72)) : nameField();
    keyPanels.append(formPanel('Create API key', [keyName, scopes], 'Generate key', async data => {
      const requested = Array.from(scopes.querySelectorAll('input:checked'), input => input.value);
      const key = await keyRequest('', {name:data.name, scopes:requested});
      if (activeModule !== 'billing' || platformContent.hidden) return;
      await loadModule('billing', integration);
      const value = element('pre', key.token);
      const copy = iconButton('copy', 'Copy API key', 'button primary');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(key.token); copy.querySelector('span').textContent = 'Copied'; }
        catch { copy.querySelector('span').textContent = 'Select and copy the key above'; }
      });
      openModal('API key created', [
        element('p', 'Copy this key now. It is displayed once.'), value, copy,
        ...(integration ? [backToIntegration()] : [])
      ]);
    }));
    keyPanels.append(listPanel('Workspace keys', apiKeys.map(key => {
      const item = expandable(key.name + ' · ' + key.prefix + '… · ' + (key.revoked ? 'Revoked' : 'Active'), {
        permissions:key.scopes, created:key.created, last_used:key.last_used, revoked:key.revoked
      });
      if (billing) item.querySelector('summary').after(element('p',
        number.format(key.requests) + ' calls · ' + number.format(key.tokens) + ' tokens · ' + billingMoney(key.spend_nanos)));
      if (key.revoked) return item;
      const revoke = element('button', 'Revoke key', 'button');
      const result = element('p');
      result.setAttribute('role', 'status');
      revoke.addEventListener('click', async () => {
        if (!window.confirm('Revoke “' + key.name + '”? Applications using it will lose access.')) return;
        revoke.disabled = true;
        try {
          await keyRequest('/revoke', {id:key.id});
          await loadModule('billing', integration);
        } catch (error) {
          result.textContent = error.message;
          revoke.disabled = false;
        }
      });
      item.append(revoke, result);
      return item;
    })));
    const apiHelp = listPanel('Use the API', [
      element('p', 'Send an Authorization: Bearer header with your workspace API key.'),
      element('pre', (billing ? 'POST /v1/chat/completions\n' : '') +
        'GET /api/agents\nPOST /api/platform/runs\nGET /api/traces\nPOST /api/traces')
    ]);
    apiHelp.classList.add('wide');
    keyPanels.append(apiHelp);
  }

  if (module === 'datasets') {
    panels.push(formPanel('Create dataset', [nameField()], 'Create dataset', data => create(module, data)));
    if (ofKind('dataset').length) panels.push(formPanel('Add example', [
      field('dataset', 'Dataset', options('dataset')), inputField(),
      field('expected', 'Reference output JSON', 'textarea')
    ], 'Add example', data => create('examples', {...data, input:jsonInput(data.input), expected:jsonInput(data.expected)})));
    panels.push(listPanel('Datasets', ofKind('dataset').map(dataset => {
      const examples = ofKind('example').filter(item => item.dataset === dataset.id);
      const group = element('details');
      group.append(element('summary', dataset.name + ' · ' + examples.length + ' examples'));
      for (const example of examples) {
        const item = element('div', undefined, 'release-entry');
        item.append(payload('Input', example.input),
          payload(example.match === 'contains' ? 'Required text' : 'Reference answer', example.expected));
        if (example.source_trace) item.append(traceLink(example.source_trace, 'Source trace'));
        group.append(item);
      }
      return group;
    })));
  }

  if (module === 'prompts') {
    panels.push(formPanel('Save prompt version', [
      nameField(), field('template', 'Template', 'textarea', '{{input}}')
    ], 'Save version', data => create(module, data)));
    panels.push(listPanel('Saved versions', promptOptions().map(([id, label]) =>
      expandable(label, records.find(item => item.id === id).template))));
  }

  if (module === 'experiments') {
    if (accountStatus?.user) panels.push(...agentEvaluationPanels());
    panels.push(formPanel('Run exact-match evaluation', [
      nameField(), field('dataset', 'Dataset', options('dataset')), promptField()
    ], 'Run experiment', data => create(module, data)));
    panels.push(listPanel('Experiment results', ofKind('experiment').map(record => {
      const passed = record.results.filter(result => result.passed).length;
      return expandable(record.name + ' · ' + recordName(record.dataset) + ' · ' + passed + '/' + record.results.length,
        record.results);
    })));
  }

  if (module === 'feedback') {
      panels.push(formPanel('Record feedback', [
      field('trace', 'Trace', traces.map(trace => [trace.id, trace.name + ' · ' + trace.project + ' · ' + trace.id.slice(0, 8)])),
      field('score', 'Score', [['1', 'Pass'], ['0', 'Fail']]), field('comment', 'Comment', 'textarea')
    ], 'Save feedback', data => create(module, {...data, score:Number(data.score)})));
    panels.push(listPanel('Reviewed traces', ofKind('feedback').map(record =>
      expandable((record.score ? 'Pass' : 'Fail') + ' · ' + record.trace.slice(0, 8), record.comment))));
  }

  if (module === 'playground') {
    panels.push(formPanel('Run prompt', [promptField(), inputField()], 'Run', async (data, section) => {
      const result = await platformRequest('/playground', {...data, input:jsonInput(data.input)});
      section.querySelector('.module-result')?.remove();
      section.append(element('pre', result.output, 'module-result'));
    }));
  }

  if (module === 'deployments') {
    if (accountStatus?.user) panels.push(...agentReleasePanels());
    panels.push(formPanel('Register deployment', [nameField(), promptField()], 'Register',
      data => create(module, data)));
    panels.push(listPanel(title, ofKind('deployment').map(record =>
      expandable(record.name, {prompt: promptOptions().find(([id]) => id === record.prompt)?.[1], id:record.id}))));
  }

  if (module === 'agents') panels.push(agentRegistry());

  if (module === 'console-agents' && !selectedTarget) {
    const agents = ofKind('agent').filter(agent => agent.source !== 'external');
    const items = agents.map(agent => {
      const item = element('div', undefined, 'console-agent-row');
      const identity = element('div');
      identity.append(element('strong', agent.name));
      if (agent.description) identity.append(element('p', agent.description));
      const open = iconButton('arrow', 'Open', 'button');
      open.setAttribute('aria-label', 'Open ' + agent.name + ' in Console');
      open.addEventListener('click', () => openAgentDetail(agent.id, 'evaluations'));
      item.append(identity, open);
      return item;
    });
    const list = listPanel('Studio agents', items.length ? items : [element('p', 'Create an Agent in Home to evaluate it here.')]);
    list.classList.add('wide');
    panels.push(list);
  }

  if (module === 'agent' || (module === 'console-agents' && selectedTarget)) {
    const inConsole = module === 'console-agents';
    const agent = ofKind('agent').find(item => item.id === selectedTarget.id);
    if (!agent || (inConsole && (agent.source === 'external' || !accountStatus?.user))) {
      const back = iconButton('arrow', inConsole ? 'Console agents' : 'All agents', 'button quiet');
      back.addEventListener('click', () => loadModule(inConsole ? 'console-agents' : 'agents'));
      panels.push(listPanel('Agent unavailable', [back]));
    } else {
      const external = agent.source === 'external';
      const tabs = inConsole ? [] : external ? [['integration', 'Integration'], ['activity', 'Activity']] :
        accountStatus?.user ? [['studio', 'Studio'], ['publish', 'Publish']] : [];
      const section = inConsole ? 'evaluations' : tabs.some(([id]) => id === selectedTarget.section)
        ? selectedTarget.section : tabs[0]?.[0] ?? 'studio';
      const showIdentity = updated => {
        headingText.replaceChildren(element('h1', updated.name));
        byId('crumb').textContent = updated.name;
        if (updated.description) headingText.append(element('p', updated.description));
      };
      showIdentity(agent);
      const actions = element('div', undefined, 'section-actions');
      const back = iconButton('arrow', inConsole ? 'Console agents' : 'All agents', 'button quiet setup-back');
      back.addEventListener('click', () => loadModule(inConsole ? 'console-agents' : 'agents'));
      actions.append(back);
      if (!external && accountStatus?.user) {
        const jump = iconButton(inConsole ? 'studio' : 'external', inConsole ? 'Open Studio' : 'Evaluations', 'button');
        jump.addEventListener('click', () => openAgentDetail(agent.id, inConsole ? 'studio' : 'evaluations'));
        const use = iconButton('terminal', 'Use Agent', 'button');
        use.addEventListener('click', () => openAgentUsage(ofKind('agent').find(item => item.id === agent.id) ?? agent));
        actions.append(jump);
        if (inConsole) {
          const publish = iconButton('deploy', 'Open Publish', 'button');
          publish.addEventListener('click', () => openAgentDetail(agent.id, 'publish'));
          actions.append(publish);
        } else actions.append(use);
      }
      heading.append(actions);
      if (tabs.length) {
        const nav = element('nav', undefined, 'agent-detail-nav wide');
        nav.setAttribute('aria-label', 'Agent sections');
        for (const [id, label] of tabs) {
          const button = element('button', label, 'trace-tab');
          if (id === section) button.setAttribute('aria-current', 'page');
          else button.addEventListener('click', () => openAgentDetail(agent.id, id));
          nav.append(button);
        }
        panels.push(nav);
      }
      if (section === 'studio') panels.push(studioWorkspace([agent], agent.id, showIdentity));
      if (section === 'publish') panels.push(...agentReleasePanels(agent.id, selectedTarget.manageVersions));
      if (section === 'evaluations') panels.push(...agentEvaluationPanels(agent.id));
      if (section === 'integration') {
        const panel = listPanel('Connect your application', [externalIntegration(agent, true)]);
        panel.classList.add('wide');
        panels.push(panel);
      }
      if (section === 'activity') {
        const latest = externalTrace(agent);
        const view = iconButton('traces', 'View traces', 'button');
        view.addEventListener('click', () => openAgentTraces(agent));
        panels.push(listPanel('Latest activity', [element('p', latest ?
          timeLabel(latest.at) + ' · ' + latest.environment : tracesReady ? 'Awaiting first trace' : 'Trace history has not loaded.'), view]));
      }
    }
  }

  if (module === 'studio') {
    const targets = records.filter(record =>
      record.kind === 'deployment' || (record.kind === 'agent' && record.source !== 'external'));
    panels.push(studioWorkspace(targets, selectedTarget));
  }

  const grid = element('div', undefined, 'module-grid');
  grid.append(...panels);
  platformContent.replaceChildren(heading, grid);
}

function openAgentDetail(id, section) {
  const module = section === 'evaluations' ? 'console-agents' : 'agent';
  return loadModule(module, {id, section});
}

function agentEvaluationPanels(agentId) {
  const versions = ofKind('agent_version').filter(version => !agentId || version.agent === agentId);
  const comparisons = ofKind('agent_evaluation').filter(comparison => !agentId || comparison.agent === agentId);
  const datasets = ofKind('dataset');
  const availableKeys = apiKeys.filter(key => !key.revoked && key.scopes.includes('models:invoke'));
  const choices = versions.map(version => [version.id, recordName(version.agent) + ' · ' + version.label]);
  const report = listPanel('Agent evaluation results', comparisons.map(item => {
    const variants = item.variants.map(variant => {
      const version = versions.find(value => value.id === variant.version);
      const passed = variant.results.filter(result => result.passed).length;
      const report = expandable((version?.label ?? variant.version) + ' · ' + passed + '/' + variant.results.length,
        variant.results);
      for (const [index, result] of variant.results.entries()) {
        if (result.passed) continue;
        const links = element('div', undefined, 'trace-mode');
        if (result.source_trace) links.append(traceLink(result.source_trace, 'Example ' + (index + 1) + ' source trace'));
        if (result.trace) links.append(traceLink(result.trace, 'Example ' + (index + 1) + ' evaluation trace'));
        if (links.childElementCount) report.append(links);
      }
      return report;
    });
    const section = element('div', undefined, 'release-entry');
    section.append(element('strong', recordName(item.agent) + ' · ' + recordName(item.dataset)),
      element('small', timeLabel(item.at)), ...variants);
    return section;
  }));
  if (versions.length < 2 || !datasets.length) return [listPanel('Compare Agent versions', [
    element('p', agentId ? 'Save two versions in Home → Publish and add a dataset with expected text replies.' :
      'Save two versions of the same Agent and add a dataset with expected text replies.')
  ]), report];
  const baseline = field('baseline', 'Baseline version', choices);
  const candidate = field('candidate', 'Candidate version', choices);
  const billingKey = field('billing_key', 'API key for hosted calls', availableKeys.map(key => [key.id, key.name]));
  const select = billingKey.querySelector('select');
  const setup = formPanel('Compare Agent versions', [
    element('p', 'Run both versions against the same dataset of one to five text examples. Production requires a full pass. Hosted requests consume your balance.'),
    field('dataset', 'Dataset', datasets.map(dataset => [dataset.id, dataset.name])), baseline, candidate, billingKey
  ], 'Run comparison', async data => {
    await platformRequest('/agent-evaluations', data);
    if (agentId) await openAgentDetail(agentId, 'evaluations');
    else await loadModule('experiments');
  });
  const versionFields = [baseline, candidate].map(label => label.querySelector('select'));
  function updateBillingField() {
    const hosted = versionFields.some(input => versions.find(version => version.id === input.value)?.provider === hostedProvider);
    billingKey.hidden = !hosted;
    select.disabled = !hosted;
  }
  if (availableKeys.length === 1) select.value = availableKeys[0].id;
  for (const input of versionFields) input.addEventListener('change', updateBillingField);
  updateBillingField();
  if (!availableKeys.length) {
    const link = iconButton('wallet', 'Open Billing to create a key', 'button quiet');
    link.addEventListener('click', () => loadModule('billing'));
    setup.append(link);
  }
  return [setup, report];
}

function openAgentUsage(agent) {
  const options = [['draft', 'Draft · development']];
  const releases = new Map();
  for (const [id, label] of [['production', 'Production'], ['staging', 'Staging']]) {
    const release = ofKind('agent_release').find(item => item.agent === agent.id && item.environment === id);
    const version = release && ofKind('agent_version').find(item => item.id === release.version);
    if (version) {
      releases.set(id, version);
      options.unshift([id, label + ' · ' + version.label]);
    }
  }
  const target = field('api-target', 'Target', options);
  const select = target.querySelector('select');
  select.value = releases.has('production') ? 'production' : releases.has('staging') ? 'staging' : 'draft';
  const detail = element('p');
  const permission = element('p');
  const url = location.origin + '/api/platform/runs';
  const endpoint = element('div', undefined, 'agent-api-endpoint');
  endpoint.append(element('strong', 'POST ' + (location.protocol === 'https:' ? 'HTTPS' : 'HTTP'),
    'pill'), element('code', url));
  const code = element('pre', undefined, 'agent-api-command');
  const copy = iconButton('copy', 'Copy example', 'button');
  const examples = element('div', undefined, 'agent-api-example-controls');
  const formats = [['node', 'Node.js'], ['curl', 'cURL'], ['json', 'JSON body']];
  let format = 'node';
  const formatButtons = formats.map(([id, label]) => {
    const button = element('button', label, 'button quiet');
    button.type = 'button';
    button.addEventListener('click', () => {format = id; update();});
    return button;
  });
  const tabs = element('div', undefined, 'section-actions');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Request example');
  tabs.append(...formatButtons);
  examples.append(tabs, copy);
  const keys = iconButton('key', 'Manage API keys', 'button quiet');
  const release = iconButton('deploy', 'Manage releases', 'button quiet');
  const actions = element('div', undefined, 'section-actions');
  actions.append(keys, release);
  function update() {
    const environment = select.value;
    const version = releases.get(environment);
    detail.textContent = version ? 'Requests run the version currently published to this environment.' :
      'Draft calls use your latest Studio configuration. Publish a version for stable integrations.';
    permission.textContent = 'Use an Agent Deck API key with List and run agents' +
      ((version ?? agent).provider === hostedProvider ? ' and Call hosted models.' : '.');
    const request = {target_kind:version ? 'agent_release' : 'agent', target:agent.id,
      ...(version ? {environment} : {}), input:'Hello!'};
    const continuation = ' ' + String.fromCharCode(92);
    const curl = [
      'curl --fail-with-body -X POST ' + url + continuation,
      '  -H "Authorization: Bearer $AGENT_DECK_API_KEY"' + continuation,
      "  -H 'Content-Type: application/json'" + continuation,
      "  --data '" + JSON.stringify(request) + "'"
    ].join('\n');
    const node = [
      'const response = await fetch(' + JSON.stringify(url) + ', {',
      '  method: "POST",',
      '  headers: {',
      '    Authorization: "Bearer " + process.env.AGENT_DECK_API_KEY,',
      '    "Content-Type": "application/json",',
      '  },',
      '  body: JSON.stringify(' + JSON.stringify(request, null, 2).replaceAll('\n', '\n  ') + '),',
      '});',
      'const result = await response.json();',
      'if (!response.ok || result.status === "error") {',
      '  throw new Error(result.error ?? `Agent request failed: ${response.status}`);',
      '}',
      'console.log(result.output, result.id);'
    ].join('\n');
    code.textContent = format === 'node' ? node : format === 'curl' ? curl : JSON.stringify(request, null, 2);
    formatButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(formats[index][0] === format)));
    copy.querySelector('span').textContent = 'Copy example';
  }
  select.addEventListener('change', update);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      copy.querySelector('span').textContent = 'Copied';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
  keys.addEventListener('click', async () => {
    byId('modal').close();
    await loadModule('billing');
    byId('billing-api-keys')?.scrollIntoView();
  });
  release.addEventListener('click', () => {
    byId('modal').close();
    openAgentDetail(agent.id, 'publish');
  });
  const body = element('div', undefined, 'agent-api');
  body.append(element('p', agent.name), endpoint,
    element('p', 'Send a JSON request from your server. Each request returns one complete JSON response.'),
    target, detail, permission, examples, code,
    element('p', 'Set AGENT_DECK_API_KEY on your server. Read output for the reply and id for its Trace ID.'), actions);
  update();
  openModal('Use Agent', [body]);
}

function agentReleasePanels(agentId, manageVersions = false) {
  const versions = ofKind('agent_version').filter(version => !agentId || version.agent === agentId);
  const releases = ofKind('agent_release').filter(release => !agentId || release.agent === agentId);
  const byVersion = new Map(versions.map(version => [version.id, version]));
  const env = [['staging', 'Staging'], ['production', 'Production']];
  const reload = () => loadModule('agent', {id:agentId, section:'publish', manageVersions:true});
  function openAction(title, fields, label, action) {
    const form = formPanel(title, fields, label, async data => {
      await action(data);
      if (form.isConnected && byId('modal').open) {
        byId('modal').close();
        await reload();
      }
    });
    form.firstElementChild.remove();
    openModal(title, [form]);
  }
  const active = new Map();
  for (const release of releases) {
    const key = release.agent + ':' + release.environment;
    if (!active.has(key)) active.set(key, release);
  }
  if (!agentId) return [listPanel('Active Agent releases', Array.from(active.values(), release => {
    const version = byVersion.get(release.version);
    const item = element('section', undefined, 'release-entry');
    item.append(element('strong', recordName(release.agent) + ' · ' + release.environment),
      element('p', (version?.label ?? release.version) + ' · ' + timeLabel(release.at)));
    const request = {target_kind:'agent_release', target:release.agent, environment:release.environment, input:'Your message'};
    item.append(expandable('Run via API', {endpoint:'POST /api/platform/runs', required_scope:'agents:run',
      ...(version?.provider === hostedProvider ? {hosted_model_scope:'models:invoke'} : {}), body:request}));
    const open = iconButton('deploy', 'Open Publish', 'button quiet');
    open.addEventListener('click', () => openAgentDetail(release.agent, 'publish'));
    item.append(open);
    return item;
  }))];
  const environments = listPanel('Environments', env.map(([id, label]) => {
    const activeRelease = active.get(agentId + ':' + id);
    const row = element('div', undefined, 'console-agent-row');
    const identity = element('div');
    identity.append(element('strong', label));
    if (activeRelease) {
      const version = byVersion.get(activeRelease.version);
      identity.append(element('p', (version?.label ?? activeRelease.version) + ' · ' + timeLabel(activeRelease.at)));
    }
    const actions = element('div', undefined, 'section-actions');
    actions.append(element('span', activeRelease ? 'Published' : 'Not published',
      activeRelease ? 'pill success' : 'pill'));
    const previous = byVersion.get(activeRelease?.previous);
    if (previous) {
      const rollback = element('button', 'Roll back', 'button quiet');
      rollback.setAttribute('aria-label', 'Roll back ' + label);
      rollback.addEventListener('click', () => openAction('Roll back ' + label, [
        element('p', 'Restore ' + previous.label + ' to ' + label + '.')
      ], 'Confirm rollback', () => platformRequest('/agent-releases',
        {version:previous.id, environment:id, expected_release:activeRelease.id})));
      actions.append(rollback);
    }
    row.append(identity, actions);
    return row;
  }));
  environments.classList.add('wide');
  const management = element('details', undefined, 'panel module-panel wide publish-management');
  management.open = manageVersions;
  const summary = element('summary');
  summary.append(element('strong', 'Manage versions'),
    element('small', versions.length === 1 ? '1 saved version' : versions.length + ' saved versions'));
  const save = iconButton('plus', 'Save version', 'button');
  save.addEventListener('click', () => {
    const label = field('label', 'Version name');
    label.querySelector('input').maxLength = 80;
    openAction('Save version', [label], 'Save', data => platformRequest('/agent-versions', {agent:agentId, ...data}));
  });
  const actions = element('div', undefined, 'section-actions publish-version-actions');
  actions.append(save);
  const history = element('div');
  for (const version of versions) {
    const row = element('div', undefined, 'console-agent-row publish-version-row');
    const info = element('div');
    info.append(expandable(version.label, {id:version.id, model:version.model,
      max_tokens:version.max_tokens, instructions:version.instructions}));
    const deploy = element('button', 'Publish', 'button');
    deploy.setAttribute('aria-label', 'Publish ' + version.label);
    deploy.addEventListener('click', () => {
      const environment = field('environment', 'Environment', env);
      environment.querySelector('select').value = 'staging';
      openAction('Publish ' + version.label, [environment,
        element('small', 'Production requires a passing evaluation.')], 'Publish',
        data => platformRequest('/agent-releases', {version:version.id, ...data}));
    });
    row.append(info, deploy);
    history.append(row);
  }
  management.append(summary, actions, history);
  return [channelPublishingPanel(agentId, active), environments, management];
}

const wecomConnectionLabels = {
  connected:'已连接', disconnected:'未连接', connecting:'已保存，正在连接',
  reconnecting:'连接失败，正在重试', 'authentication failed':'企微鉴权失败'
};
const wecomDeliveryLabels = {
  received:'已收到消息，正在处理', replied:'企微已确认收到回复',
  agent_failed:'Agent 生成回复失败', reply_failed:'回复未获企微确认'
};

function renderWeComStatus(container, result, agentId) {
  const matches = result.agent === agentId;
  const label = result.agent && !matches ? '已配置给其他 Agent' : wecomConnectionLabels[result.status] ?? result.status;
  const state = element('span', label, result.status === 'connected' && matches ? 'pill success' : 'pill');
  container.replaceChildren(state);
  if (result.agent) container.append(element('span', matches ? result.environment : recordName(result.agent) + ' · ' + result.environment));
  if (result.detail && matches) container.append(element('small', result.detail));
  if (matches && result.delivery) {
    const delivery = result.delivery;
    container.append(element('small', (wecomDeliveryLabels[delivery.state] ?? delivery.state) +
      ' · ' + timeLabel(delivery.at) + (delivery.detail ? ' · ' + delivery.detail : '')));
  } else if (matches && result.status === 'connected') {
    container.append(element('small', '等待首条文本消息'));
  }
  if (matches && result.lastTrace) container.append(traceLink(result.lastTrace));
}

function openHostedWeCom(agentId, environments, onStatus) {
  const heading = element('div', undefined, 'wecom-setup');
  const status = element('div', '正在检查连接…', 'wecom-status');
  status.setAttribute('role', 'status');
  const current = element('div', undefined, 'section-actions');
  const refreshStatus = element('button', 'Refresh status', 'button quiet');
  const disconnect = element('button', 'Disconnect bot', 'button quiet');
  disconnect.hidden = true;
  current.append(refreshStatus, disconnect);
  heading.append(element('p', 'Cloudflare hosts this connection. Replies use the selected release and the workspace balance.'), status, current);
  async function update(data) {
    try {
      const result = data ?? await platformRequest('/wecom-status');
      renderWeComStatus(status, result, agentId);
      onStatus?.(result);
      disconnect.hidden = !result.agent;
    } catch (error) {status.textContent = error.message;}
  }
  refreshStatus.addEventListener('click', () => update());
  disconnect.addEventListener('click', async () => {
    disconnect.disabled = true;
    try {await update(await platformRequest('/wecom-disconnect', {}));}
    catch (error) {status.textContent = error.message;}
    finally {disconnect.disabled = false;}
  });
  const environment = field('environment', 'Environment', environments.map(env =>
    [env, env === 'production' ? 'Production' : 'Staging']));
  environment.querySelector('select').value = environments[0];
  const secret = field('secret', 'Bot Secret', 'password');
  const secretInput = secret.querySelector('input');
  secretInput.autocomplete = 'new-password';
  const form = formPanel('Connect a bot', [element('p', 'Use a bot created in API mode with a long connection. Saving replaces the workspace’s current bot.'),
    environment, field('bot_id', 'Bot ID'), secret], 'Save and connect', async data => {
    await update(await platformRequest('/wecom-connect', {...data, agent:agentId}));
    secretInput.value = '';
  });
  openModal('企业微信智能机器人', [heading, form]);
  async function poll() {
    if (!heading.isConnected || !byId('modal').open) return;
    await update();
    setTimeout(poll, 3000);
  }
  poll();
}

function channelPublishingPanel(agentId, releases) {
  const channels = [
    {name:'企业微信智能机器人', mode:'wecom', description:'Agent Deck 托管 · 填写 Bot ID 和 Secret 即可连接'},
    {name:'微信客服', mode:'wechat-kf', description:'自托管网关 · 需要 HTTPS 回调'}
  ];
  const panel = listPanel('Connect a channel', []);
  panel.querySelector('p')?.remove();
  panel.classList.add('wide');
  for (const channel of channels) {
    const row = element('div', undefined, 'console-agent-row');
    const info = element('div');
    info.append(element('strong', channel.name), element('p', channel.description));
    const setup = iconButton('external', 'Set up', channel.mode === 'wecom' ? 'button primary' : 'button');
    const connection = element('div', undefined, 'wecom-status');
    const onStatus = channel.mode === 'wecom' ? result => {
      renderWeComStatus(connection, result, agentId);
      setup.querySelector('span').textContent = result.agent === agentId ? 'Manage' : 'Set up';
    } : undefined;
    if (onStatus) {
      connection.textContent = '正在检查连接…';
      info.append(connection);
      const poll = async () => {
        if (!row.isConnected) return;
        try {onStatus(await platformRequest('/wecom-status'));}
        catch {connection.textContent = '暂时无法读取连接状态';}
        setTimeout(poll, 5000);
      };
      setTimeout(poll, 0);
    }
    const environments = ['production', 'staging'].filter(env => releases.has(agentId + ':' + env));
    setup.setAttribute('aria-label', 'Set up ' + channel.name);
    function continueSetup(environments) {
      if (channel.mode === 'wecom') return openHostedWeCom(agentId, environments, onStatus);
      const choice = field('environment', 'Environment', environments.map(env =>
        [env, env === 'production' ? 'Production' : 'Staging']));
      const select = choice.querySelector('select');
      select.value = environments[0];
      const command = element('pre');
      const draw = () => {command.textContent = [
        'export AGENT_DECK_AGENT_ID=' + agentId,
        'export AGENT_DECK_ENVIRONMENT=' + select.value,
        'node gateway.mjs ' + channel.mode
      ].join('\n');};
      select.addEventListener('change', draw);
      draw();
      const guide = element('a', 'Open gateway setup guide', 'button');
      guide.href = 'https://github.com/choasup/agentops/tree/main/channels';
      guide.target = '_blank';
      guide.rel = 'noopener noreferrer';
      openModal(channel.name, [element('p', channel.description), choice,
        element('p', 'Set the channel credentials and Agent Deck API key on your server, then start the gateway.'),
        command, guide]);
    }
    setup.addEventListener('click', () => {
      if (environments.length) return continueSetup(environments);
      const agent = ofKind('agent').find(item => item.id === agentId);
      let savedVersion;
      const form = formPanel('Publish to Staging', [
        element('p', agent.name + ' has no published environment. Save its current Studio configuration as a version and publish it to Staging to continue.')
      ], 'Publish to Staging and continue', async () => {
        savedVersion ??= await platformRequest('/agent-versions', {agent:agentId, label:'Channel setup · ' + new Date().toISOString().slice(0,16).replace('T', ' ') + ' UTC'});
        await platformRequest('/agent-releases', {version:savedVersion.id, environment:'staging', only_if_unpublished:true});
        if (!form.isConnected || !byId('modal').open) return;
        await openAgentDetail(agentId, 'publish');
        if (form.isConnected && byId('modal').open) continueSetup(['staging']);
      });
      openModal(channel.name, [form]);
    });
    row.append(info, setup);
    panel.append(row);
  }
  return panel;
}

function brandMark() {
  const mark = element('img', undefined, 'mark');
  mark.src = 'mark.png';
  mark.alt = '';
  return mark;
}

function agentFields(data, models) {
  const root = element('div', undefined, 'agent-form-fields');
  const identity = element('div', undefined, 'studio-config-group');
  const name = field('name', 'Agent name', 'text', data.name ?? '');
  const description = field('description', 'Description', 'text', data.description ?? '');
  const descriptionInput = description.querySelector('input');
  descriptionInput.required = false;
  descriptionInput.maxLength = 240;
  descriptionInput.placeholder = 'What is this agent for?';
  identity.append(name, description);
  const instructions = field('instructions', 'Agent instructions', 'textarea', data.instructions ?? '');
  instructions.querySelector('textarea').placeholder = 'Describe what the agent should do and how it should respond.';
  const model = field('provider', 'Model', models, data.provider ?? '');
  const modelInput = model.querySelector('select');
  if (models.length) modelInput.value = data.provider ?? models[0][0];
  else modelInput.disabled = true;
  model.hidden = !models.length;
  const starter = field('starter', 'Starter message', 'text', data.starter ?? '');
  starter.querySelector('input').required = false;
  starter.querySelector('input').maxLength = 1000;
  starter.querySelector('input').placeholder = 'An optional first message to try in Studio';
  const advanced = element('details', undefined, 'studio-config-section');
  const limit = field('max_tokens', 'Maximum output tokens', 'number', data.max_tokens ?? '');
  const limitInput = limit.querySelector('input');
  limitInput.required = false;
  limitInput.min = 1;
  limitInput.max = 4096;
  limitInput.placeholder = 'Model default';
  advanced.append(element('summary', 'Run settings'), limit);
  const profile = element('details', undefined, 'studio-config-section');
  identity.append(starter);
  profile.append(element('summary', 'Agent details'), identity);
  root.append(model, instructions, studioAttachments(data, modelInput), profile, advanced);
  return root;
}

function studioAttachments(data, modelInput) {
  const connections = ofKind('mcp_connection');
  const skills = ofKind('skill');
  const root = element('div', undefined, 'studio-attachments');
  const notice = element('p');
  notice.setAttribute('role', 'status');
  const compatibility = element('p');
  let connectionId = data.mcp_connection ?? '';
  let skillId = data.skill ?? '';
  let picker;
  const hosted = () => modelInput.value === hostedProvider;
  const compatible = skill => !skill.requires || connections.some(connection =>
    connection.id === connectionId && !connection.revoked &&
    (connection.provider ?? 'cloudflare-docs') === skill.requires);

  const makeSection = (title, name, items, getId, choose, emptyText) => {
    const section = element('section', undefined, 'studio-attachment-section');
    const heading = element('div', undefined, 'studio-attachment-heading');
    const input = element('input');
    input.type = 'hidden';
    input.name = name;
    const tool = name === 'mcp_connection';
    const add = iconButton('plus', 'Add ' + (tool ? 'tool' : 'Skill'), 'button');
    add.type = 'button';
    const list = element('div', undefined, 'studio-attachment-picker');
    list.id = 'studio-picker-' + name;
    add.setAttribute('aria-controls', list.id);
    const current = element('div');
    heading.append(element('h3', title), add);
    section.append(heading, current, list, input);
    add.addEventListener('click', () => {
      picker = picker === name ? undefined : name;
      render();
    });
    const select = (id, remove = false) => {
      picker = undefined;
      notice.textContent = '';
      choose(id);
      render();
      (remove ? add : current.querySelector('button') ?? add).focus();
    };
    const detail = item => {
      if (tool) return item.revoked ? 'Disconnected' : item.scope ?? 'Read-only';
      if (item.builtin) return item.source + ' · Built-in';
      if (!item.requires) return '';
      const provider = connectionCatalogue.find(entry => entry.id === item.requires);
      return 'Requires ' + (provider?.name ?? item.requires);
    };
    return {section, update() {
      const id = getId();
      input.value = hosted() ? id : '';
      add.disabled = !hosted();
      add.setAttribute('aria-expanded', String(picker === name));
      list.hidden = picker !== name;
      current.replaceChildren();
      const installed = items.find(item => item.id === id);
      if (installed) {
        const row = element('div', undefined, 'studio-attachment-row');
        const identity = element('div');
        identity.append(element('strong', installed.name));
        if (detail(installed)) identity.append(element('small', detail(installed)));
        const remove = iconButton('close', 'Remove', 'button quiet');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove ' + installed.name);
        remove.addEventListener('click', () => select('', true));
        row.append(identity, remove);
        current.append(row);
      } else current.append(element('p', tool ? 'No tool attached' : 'No Skill installed'));
      list.replaceChildren();
      if (list.hidden) return;
      const choices = items.filter(item => item.id !== id && !item.revoked);
      if (!choices.length) list.append(element('p', emptyText));
      for (const item of choices) {
        const row = element('button', undefined, 'studio-attachment-choice');
        row.type = 'button';
        row.disabled = !tool && !compatible(item);
        row.append(element('strong', item.name));
        if (detail(item)) row.append(element('small', detail(item)));
        if (item.description) row.append(element('small', item.description));
        row.addEventListener('click', () => select(item.id));
        list.append(row);
      }
    }};
  };
  const tools = makeSection('Tools', 'mcp_connection', connections, () => connectionId, id => {
    connectionId = id;
    const skill = skills.find(item => item.id === skillId);
    if (skill && !compatible(skill)) {
      skillId = '';
      notice.textContent = skill.name + ' was removed because it requires the previous tool.';
    }
  }, 'No other connected tools. Add a connection from Home → Connections.');
  const installedSkills = makeSection('Skills', 'skill', skills, () => skillId, id => {
    skillId = id;
  }, 'No other Skills available. Import a ZIP from Home → Skills.');
  function render() {
    compatibility.hidden = hosted();
    compatibility.textContent = connectionId || skillId
      ? 'Saving with this model will remove attached tools and Skills. They require Hosted DeepSeek.'
      : 'Tools and Skills require Hosted DeepSeek.';
    tools.update();
    installedSkills.update();
  }
  modelInput.addEventListener('change', () => {
    picker = undefined;
    render();
  });
  root.append(compatibility, tools.section, installedSkills.section, notice);
  render();
  return root;
}

function agentPayload(data) {
  return {...data, max_tokens:data.max_tokens ? Number(data.max_tokens) : null};
}

function openCreateAgent() {
  const models = studioModels();
  const body = element('div', undefined, 'agent-builder');
  const cli = element('a', 'Create with the CLI', 'button quiet');
  cli.href = 'https://github.com/choasup/agentops#agent-deck-cli';
  cli.target = '_blank';
  cli.rel = 'noopener noreferrer';
  const external = iconButton('external', 'Connect an external agent', 'button quiet');
  external.addEventListener('click', () => {
    const back = iconButton('arrow', 'Back', 'button quiet setup-back');
    back.addEventListener('click', openCreateAgent);
    openModal('Connect an external agent', [
      element('p', 'Register an Agent that already runs in your application to get an ID for sending traces.'),
      formPanel('External Agent', [field('name', 'Agent name')], 'Register and view setup', async data => {
        const agent = await platformRequest('/agents', {...data, source:'external'});
        if (byId('modal').open) byId('modal').close();
        await openAgentDetail(agent.id, 'integration');
      }), back
    ]);
  });
  if (models.length) {
    const model = field('provider', 'Model', models);
    model.querySelector('select').value = models[0][0];
    body.append(formPanel('Studio agent', [
      field('name', 'Agent name'), model, field('instructions', 'Instructions', 'textarea')
    ], 'Create and open Studio', async data => {
      const agent = await platformRequest('/agents', {...data, source:'studio'});
      if (byId('modal').open) byId('modal').close();
      await openAgentDetail(agent.id, 'studio');
    }));
  } else {
    const manage = iconButton('models', 'Open Models', 'button');
    manage.addEventListener('click', () => {
      byId('modal').close();
      loadModule('models');
    });
    body.append(element('p', 'Connect a model to create a Studio agent.'), manage);
  }
  const actions = element('div', undefined, 'agent-builder-actions');
  actions.append(cli, external);
  body.append(actions);
  openModal('New agent', [body]);
}

function externalTrace(agent) {
  return traces.find(trace => trace.agent_id === agent.identifier);
}

function externalIntegration(agent, inline = false) {
  const requiresKey = Boolean(accountStatus?.user);
  const panel = element('div', undefined, 'external-integration');
  const status = element('div', undefined, 'integration-status');
  status.setAttribute('aria-live', 'polite');
  const check = iconButton('traces', 'Check for a trace', 'button');
  const keys = iconButton('key', 'Open Billing → API Keys', 'button');
  keys.addEventListener('click', async () => {
    if (byId('modal').open) byId('modal').close();
    await loadModule('billing', agent);
    byId('billing-api-keys')?.scrollIntoView();
  });
  const identity = element('div', undefined, 'integration-identity');
  identity.append(element('span', 'Agent ID'), element('code', agent.identifier));
  const environment = field('environment', 'Environment', [
    ['development', 'Development'], ['staging', 'Staging'], ['production', 'Production'], ['local', 'Local']
  ]);
  const environmentInput = environment.querySelector('select');
  environmentInput.value = 'development';
  const code = element('pre', undefined, 'integration-command');
  function updateCommand() {
    const payload = JSON.stringify({agent_id:agent.identifier, environment:environmentInput.value,
      name:'connection_check', status:'success'});
    code.textContent = [
      'curl --fail-with-body -X POST ' + location.origin + '/api/traces',
      ...(requiresKey ? ['  -H "Authorization: Bearer $AGENT_DECK_API_KEY"'] : []),
      "  -H 'Content-Type: application/json'",
      "  --data '" + payload + "'"
    ].join(' ' + String.fromCharCode(92) + String.fromCharCode(10));
  }
  environmentInput.addEventListener('change', updateCommand);
  updateCommand();
  const copy = iconButton('copy', 'Copy command', 'button');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      copy.querySelector('span').textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });
  function updateStatus(checked = false) {
    const trace = externalTrace(agent);
    const text = trace ? 'Trace received' : tracesReady ? 'Waiting for first trace' : 'Trace status unavailable';
    status.replaceChildren(element('span', text, trace ? 'pill success' : 'pill'));
    if (trace) status.append(traceLink(trace.id));
    else if (checked) status.append(element('small', 'No trace was found for this Agent ID yet.'));
  }
  check.addEventListener('click', async () => {
    check.disabled = true;
    const loaded = await refresh();
    check.disabled = false;
    if (loaded) updateStatus(true);
    else status.replaceChildren(element('p', 'Could not load traces. Try again.'));
  });
  updateStatus();
  const steps = element('ol', undefined, 'integration-steps');
  const authorize = element('li');
  if (requiresKey) authorize.append(element('h3', 'Get a trace API key'),
    element('p', 'Use an Agent Deck API key with Send traces permission. Set it as AGENT_DECK_API_KEY in your environment.'), keys);
  const send = element('li');
  send.append(element('h3', 'Send a connection check'), environment, code, copy);
  const confirm = element('li');
  confirm.append(element('h3', 'Verify receipt'), status, check,
    element('p', 'Once verified, send the same fields from your application after each run, using the real run name and status.'));
  if (requiresKey) steps.append(authorize);
  steps.append(send, confirm);
  panel.append(identity, steps);
  if (inline) return panel;
  openModal('Connect ' + agent.name, [panel]);
}

function openAgentConfiguration(agent, afterSave) {
  const choices = studioModels();
  if (agent.provider && !choices.some(([id]) => id === agent.provider)) choices.unshift([agent.provider, recordName(agent.provider)]);
  if (!agent.provider && choices.length) choices.unshift(['', 'Workspace default']);
  const fields = agentFields({...agent, provider:agent.provider ?? ''}, choices);
  const providerInput = fields.querySelector('select');
  if (!agent.provider) {
    providerInput.required = false;
    if (choices.length) providerInput.remove(0);
  }
  const dialog = byId('studio-configuration');
  const close = dialog.querySelector('.modal-head button');
  const blockEscape = event => event.preventDefault();
  const panel = formPanel(agent.name, [fields], 'Save changes', async data => {
    close.disabled = cancel.disabled = true;
    dialog.addEventListener('cancel', blockEscape);
    try {
      const updated = await platformRequest('/agent-update', {...agentPayload(data), agent:agent.id});
      dialog.close();
      afterSave(updated);
    } finally {
      close.disabled = cancel.disabled = false;
      dialog.removeEventListener('cancel', blockEscape);
    }
  });
  const form = panel.querySelector('form');
  const cancel = element('button', 'Cancel', 'button');
  cancel.type = 'button';
  cancel.addEventListener('click', () => dialog.close());
  const footer = element('div', undefined, 'studio-config-footer');
  const actions = element('div', undefined, 'section-actions');
  actions.append(cancel, form.querySelector('[type=submit]'));
  footer.append(form.querySelector('[role=status]'), actions);
  form.append(footer);
  form.addEventListener('invalid', event => {
    const disclosure = event.target.closest('details');
    if (disclosure) disclosure.open = true;
  }, true);
  byId('studio-config-body').replaceChildren(panel);
  dialog.showModal();
}

function studioWorkspace(targets, selectedTarget, onAgentUpdate) {
  if (!targets.length) {
    const panel = element('section', undefined, 'panel agent-empty wide');
    const create = iconButton('plus', 'New agent', 'button primary');
    create.addEventListener('click', openCreateAgent);
    panel.append(brandMark(), element('h2', 'Create an agent to start a run'),
      element('p', 'Choose a model, give the agent instructions, and test it here.'), create);
    return panel;
  }
  const panel = element('section', undefined, 'panel studio-workspace wide');
  const toolbar = element('header', undefined, 'studio-toolbar');
  const selector = field('target', 'Agent or deployment', targets.map(target => [
    target.id, target.name + (target.kind === 'deployment' ? ' · Deployment' : '')
  ]));
  const targetInput = selector.querySelector('select');
  selector.hidden = Boolean(onAgentUpdate);
  targetInput.value = selectedTarget ?? lastStudioTarget ?? targets[0].id;
  if (!targetInput.value) targetInput.value = targets[0].id;
  const model = element('span', undefined, 'studio-model');
  const configure = iconButton('settings', 'Configure', 'button');
  configure.setAttribute('aria-haspopup', 'dialog');
  toolbar.append(selector, model, configure);
  const use = iconButton('terminal', 'Use Agent', 'button');
  if (!onAgentUpdate && accountStatus?.user) toolbar.append(use);
  use.addEventListener('click', () => openAgentUsage(current()));
  const newTest = iconButton('plus', 'New test', 'button quiet');
  newTest.hidden = true;

  const split = element('div', undefined, 'studio-split');
  const history = element('aside', undefined, 'studio-history');
  const historyHeading = element('div', undefined, 'studio-history-heading');
  historyHeading.append(element('h2', 'Run history'), newTest);
  history.append(historyHeading);
  const runList = element('div', undefined, 'studio-run-list');
  history.append(runList);
  const stage = element('div', undefined, 'studio-stage');
  const session = element('div', undefined, 'studio-stream');
  const form = element('form', undefined, 'studio-composer');
  const message = element('textarea');
  message.rows = 2;
  message.required = true;
  const messageLabel = element('label', 'Message', 'studio-input-label');
  message.id = 'studio-message';
  messageLabel.htmlFor = message.id;
  const send = iconButton('play', 'Run', 'button primary');
  const hint = element('p', undefined, 'studio-run-context');
  const notice = element('p', undefined, 'studio-run-notice');
  notice.setAttribute('role', 'status');
  const formFooter = element('div', undefined, 'composer-footer');
  const balanceHint = element('span', 'Uses workspace balance', 'studio-run-context');
  const openBilling = iconButton('wallet', 'Open Billing', 'button quiet');
  openBilling.type = 'button';
  openBilling.hidden = true;
  openBilling.addEventListener('click', () => loadModule('billing'));
  formFooter.append(balanceHint, openBilling, send);
  form.append(messageLabel, message, hint, formFooter, notice);
  stage.append(form, session);
  split.append(stage, history);
  panel.append(toolbar, split);

  let pending = false;
  let selectedRun;
  let showLatest = Boolean(onAgentUpdate);
  let requestTrace;
  const current = () => targets.find(target => target.id === targetInput.value);
  const setNotice = (text = '', error = false, showBilling = false) => {
    openBilling.hidden = !showBilling;
    notice.textContent = text;
    notice.classList.toggle('is-error', error);
  };
  const updateRunButton = () => {
    send.disabled = pending || !message.value.trim();
    configure.disabled = pending;
    newTest.disabled = pending;
    send.querySelector('span').textContent = pending ? 'Running…' : 'Run test';
  };
  const fillMessage = value => {
    message.value = value;
    if (!pending) setNotice();
    updateRunButton();
    message.focus();
  };
  const selectTarget = (reset = true) => {
    const target = current();
    lastStudioTarget = target.id;
    model.textContent = target.provider ? recordName(target.provider) : target.kind === 'deployment' ? 'Deployment' : 'Workspace default';
    balanceHint.hidden = target.provider !== hostedProvider;
    const connection = ofKind('mcp_connection').find(item => item.id === target.mcp_connection);
    const skill = ofKind('skill').find(item => item.id === target.skill);
    hint.textContent = connection?.revoked ? 'This Agent’s tool is disconnected. Change it in Configuration.' :
      connection?.scope ? (skill ? skill.name + ' · ' : '') + 'Reads ' + connection.scope + ' before answering.' :
      connection ? 'Your message is sent to Cloudflare Documentation for a read-only search.' :
      skill ? 'Uses ' + skill.name + ' for this test.' : '';
    configure.hidden = use.hidden = target.kind === 'deployment';
    if (reset) {
      selectedRun = undefined;
      showLatest = false;
      requestTrace = undefined;
      message.value = '';
    }
    messageLabel.textContent = target.instructions ? 'Test message' : 'Input JSON';
    message.placeholder = target.instructions ? 'Send a test message…' : 'Enter JSON input…';
    setNotice();
    updateRunButton();
    draw();
  };
  targetInput.addEventListener('change', () => selectTarget());
  configure.addEventListener('click', () => {
    openAgentConfiguration(current(), updated => {
      if (!panel.isConnected) return;
      targets[targets.findIndex(item => item.id === updated.id)] = updated;
      records = records.map(record => record.id === updated.id ? updated : record);
      Array.from(targetInput.options).find(option => option.value === updated.id).textContent = updated.name;
      if (current().id !== updated.id) return;
      onAgentUpdate?.(updated);
      selectTarget(false);
      setNotice('Configuration saved.');
    });
  });

  newTest.addEventListener('click', () => {
    showLatest = false;
    selectedRun = undefined;
    setNotice();
    draw();
    message.focus();
  });

  function recentRuns() {
    const target = current();
    const saved = traces.filter(trace => trace.target_id === target.id ||
      (!trace.target_id && target.identifier && trace.agent_id === target.identifier &&
        trace.environment === 'local' && ['llm', 'template'].includes(trace.type)));
    if (requestTrace && !saved.some(run => run.id === requestTrace.id)) saved.unshift(requestTrace);
    return saved.slice(0, 30);
  }

  function draw() {
    const runs = recentRuns();
    if (!selectedRun && showLatest) selectedRun = runs[0];
    newTest.hidden = !selectedRun;
    runList.replaceChildren(...runs.map(run => {
      const row = element('button', undefined, 'studio-run');
      if (selectedRun?.id === run.id) row.setAttribute('aria-current', 'true');
      const label = typeof run.input === 'string' && run.input.trim() ? run.input : 'JSON input';
      const main = element('span', label, 'studio-run-name');
      const meta = element('span', timeLabel(run.at), 'studio-run-time');
      row.append(main, meta, statusPill(runStatus(run)));
      row.addEventListener('click', () => {
        selectedRun = run;
        draw();
        runList.querySelector('[aria-current]')?.focus();
      });
      return row;
    }));
    if (!runs.length) runList.append(element('p', 'No runs yet.', 'history-empty'));

    if (!selectedRun) {
      session.replaceChildren(element('h2', 'Test results'),
        element('p', runs.length ? 'Run a new test or select a previous run from history.' :
          'The response and trace will appear here after your first test.'));
      if (current().starter) {
        const starter = iconButton('arrow', 'Use starter message', 'button');
        starter.type = 'button';
        starter.addEventListener('click', () => fillMessage(current().starter));
        session.append(starter);
      }
      return;
    }
    const run = selectedRun;
    const failed = runStatus(run) === 'error';
    const input = element('article', undefined, 'studio-message user-message');
    const inputHeader = element('header', undefined, 'studio-input-head');
    const reply = element('article', undefined, 'studio-message');
    const header = element('header', undefined, 'studio-response-head');
    header.append(element('h3', failed ? 'Run failed' : 'Response'), statusPill(runStatus(run)),
      element('span', latency(run.duration) + ' · ' + number.format(run.tokens) + ' tokens', 'step-time'));
    const actions = element('div', undefined, 'section-actions');
    const inspect = iconButton('traces', 'View trace', 'button');
    inspect.addEventListener('click', () => showTrace(run));
    const reuse = iconButton('copy', 'Reuse input', 'button quiet');
    reuse.addEventListener('click', () => {
      fillMessage(current().instructions && typeof run.input === 'string' ? run.input : JSON.stringify(run.input ?? null, null, 2));
    });
    inputHeader.append(element('h3', 'Input'), reuse);
    input.append(inputHeader, readableContent(run.input));
    actions.append(inspect);
    reply.append(header, readableContent(failed ? run.error ?? 'Run failed' : run.output), actions);
    session.replaceChildren(input, reply);
  }

  function readableContent(value) {
    if (typeof value === 'string') {
      const content = element('div', undefined, 'studio-message-text');
      value.split(/(`[^`\n]+`)/).forEach((part, index) => {
        content.append(index % 2 ? element('code', part.slice(1, -1)) : part);
      });
      return content;
    }
    return element('pre', JSON.stringify(value ?? null, null, 2));
  }

  message.addEventListener('input', () => {
    if (notice.classList.contains('is-error')) setNotice();
    updateRunButton();
  });
  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !send.disabled) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (send.disabled) return;
    const target = current();
    let input;
    try {
      input = target.instructions ? message.value : jsonInput(message.value);
    } catch (error) {
      setNotice(error.message, true);
      message.focus();
      return;
    }
    pending = true;
    targetInput.disabled = true;
    setNotice('Running test…');
    updateRunButton();
    const submitted = message.value;
    try {
      const trace = await platformRequest('/runs', {target:target.id, target_kind:target.kind, input});
      selectedRun = requestTrace = trace;
      if (message.value === submitted) message.value = '';
      setNotice(runStatus(trace) === 'error' ? 'Test failed. See the result below.' : 'Test complete.');
      refresh();
    } catch (error) {
      setNotice(error.message, true, error.status === 402);
    } finally {
      pending = false;
      targetInput.disabled = false;
      updateRunButton();
      draw();
    }
  });
  refreshWorkspaceView = () => {if (panel.isConnected && !pending && !byId('trace-inspector').open && !runList.contains(document.activeElement)) draw();};
  selectTarget(false);
  return panel;
}

function agentRegistry() {
  const agents = ofKind('agent');
  const panel = element('section', undefined, 'panel agent-panel wide');
  if (!agents.length) {
    const empty = element('div', undefined, 'agent-empty');
    const create = iconButton('plus', 'New agent', 'button primary');
    create.addEventListener('click', openCreateAgent);
    empty.append(brandMark(), element('h2', 'Create your first agent'),
      element('p', 'Build a Studio agent or connect one that already runs in your application.'), create);
    panel.append(empty);
    return panel;
  }
  const head = element('header', undefined, 'registry-toolbar');
  const search = element('input');
  search.type = 'search';
  search.placeholder = 'Search agents…';
  search.value = registryFilters.query;
  search.setAttribute('aria-label', 'Search agents');
  const source = element('select');
  source.setAttribute('aria-label', 'Agent type');
  source.append(new Option('All types', ''), new Option('Studio', 'studio'), new Option('External', 'external'));
  source.value = registryFilters.source;
  const activityFilter = element('select');
  activityFilter.setAttribute('aria-label', 'Agent activity');
  activityFilter.append(new Option('All activity', ''), new Option('Awaiting first trace', 'waiting'),
    new Option('Latest run failed', 'failed'), new Option('Has runs', 'runs'));
  activityFilter.value = registryFilters.activity;
  activityFilter.disabled = !tracesReady;
  const sort = element('select');
  sort.setAttribute('aria-label', 'Sort agents');
  sort.append(new Option('Most recent run', 'recent'), new Option('Agent name', 'name'));
  sort.value = registryFilters.sort;
  const count = element('p', undefined, 'registry-count');
  const refreshButton = iconButton('traces', 'Refresh activity', 'button quiet');
  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    const loaded = await refresh();
    refreshButton.disabled = false;
    if (!loaded) count.textContent = 'Could not refresh activity';
  });
  head.append(search, source, activityFilter, sort, count, refreshButton);
  const grid = element('div', undefined, 'table-wrap registry-table');
  const table = element('table');
  table.setAttribute('aria-label', 'Agent registry');
  const headers = element('tr');
  for (const column of ['Agent', 'Model', 'Last run', 'Runs · 7d', 'Error rate · 7d', 'Actions']) {
    const cell = element('th', column);
    cell.scope = 'col';
    headers.append(cell);
  }
  const thead = element('thead');
  thead.append(headers);
  const rows = element('tbody');
  table.append(thead, rows);
  grid.append(table);
  panel.append(head, grid);

  function stats() {
    const oneWeekAgo = Date.now() - 7 * 86400000;
    const map = new Map();
    for (const trace of traces) {
      if (!trace.agent_id) continue;
      const time = Date.parse(trace.at);
      if (!Number.isFinite(time)) continue;
      const old = map.get(trace.agent_id) ?? {last:0, total:0, errors:0};
      if (!old.latest || time > old.last) {
        old.last = time;
        old.latest = trace;
      }
      if (time >= oneWeekAgo) {
        old.total++;
        if (trace.status === 'error') old.errors++;
      }
      map.set(trace.agent_id, old);
    }
    return map;
  }

  function draw() {
    const activity = stats();
    const query = registryFilters.query.trim().toLowerCase();
    activityFilter.disabled = !tracesReady;
    const filtered = agents.filter(agent => {
      const latest = activity.get(agent.identifier)?.latest;
      const matchesActivity = !tracesReady || {
        '':true, waiting:agent.source === 'external' && !latest,
        failed:latest?.status === 'error', runs:Boolean(latest)
      }[registryFilters.activity];
      return matchesActivity && (!registryFilters.source || (agent.source ?? 'studio') === registryFilters.source) &&
        [agent.name, agent.identifier, agent.description, agent.provider && recordName(agent.provider)]
          .some(value => value?.toLowerCase().includes(query));
    });
    const byName = (first, second) => first.name.localeCompare(second.name);
    filtered.sort(registryFilters.sort === 'name' ? byName : (first, second) =>
      (activity.get(second.identifier)?.last ?? 0) - (activity.get(first.identifier)?.last ?? 0) || byName(first, second));
    count.textContent = (filtered.length === agents.length ? number.format(agents.length) :
      number.format(filtered.length) + ' of ' + number.format(agents.length)) +
      (agents.length === 1 && filtered.length === 1 ? ' agent' : ' agents');

    rows.replaceChildren(...filtered.map(agent => {
      const row = element('tr');
      const external = agent.source === 'external';
      const identity = element('div', undefined, 'agent-identity');
      const avatar = element('span', undefined, 'agent-avatar');
      avatar.append(icon(external ? 'external' : 'agents'));
      const labels = element('div');
      const details = element('button', agent.name, 'agent-name');
      details.addEventListener('click', () => openAgentDetail(agent.id));
      labels.append(details, element('p', agent.description || (external ? 'External agent' : 'Studio agent')));
      const usage = activity.get(agent.identifier);
      const observed = Boolean(usage);
      if (external && tracesReady) labels.append(element('span', observed ? 'Trace received' : 'Awaiting first trace',
        observed ? 'pill success' : 'pill'));
      identity.append(avatar, labels);
      const actions = element('div', undefined, 'agent-actions');
      if (observed) {
        const openTraces = iconButton('traces', 'Traces', 'button quiet');
        openTraces.setAttribute('aria-label', 'View traces for ' + agent.name);
        openTraces.addEventListener('click', () => openAgentTraces(agent));
        actions.append(openTraces);
      }
      if (external) {
        const setup = iconButton('external', observed ? 'Integration' : 'Set up integration', 'button');
        setup.setAttribute('aria-label', 'Integration setup for ' + agent.name);
        setup.addEventListener('click', () => openAgentDetail(agent.id, 'integration'));
        actions.append(setup);
      } else {
        const studio = iconButton('studio', 'Test in Studio', 'button');
        studio.setAttribute('aria-label', 'Open ' + agent.name + ' in Studio');
        studio.addEventListener('click', () => loadModule('studio', agent.id));
        actions.append(studio);
      }
      const modelName = external ? 'Runs externally' : agent.provider ? recordName(agent.provider) : 'Workspace default';
      const latest = usage?.latest;
      const runSummary = element('div', undefined, 'registry-latest');
      if (latest) {
        const inspect = element('button', timeLabel(usage.last), 'agent-name registry-run-link');
        inspect.type = 'button';
        inspect.setAttribute('aria-label', 'Open latest trace for ' + agent.name);
        inspect.addEventListener('click', () => openConsoleTrace(latest));
        runSummary.append(inspect, statusPill(runStatus(latest)));
      } else runSummary.textContent = tracesReady ? 'No runs yet' : '—';
      labels.append(element('p', modelName, 'registry-mobile-model'));
      const values = [
        identity, modelName, runSummary, tracesReady ? number.format(usage?.total ?? 0) : '—',
        usage?.total ? (100 * usage.errors / usage.total).toFixed(1) + '%' : '—', actions
      ];
      values.forEach((value, index) => {
        const cell = element('td');
        if (index > 1 && index < 5) cell.className = 'registry-metric';
        cell.append(value);
        row.append(cell);
      });
      return row;
    }));
    if (!filtered.length) {
      const empty = element('td', undefined, 'empty');
      empty.colSpan = 6;
      const reset = element('button', 'Clear filters', 'button quiet');
      reset.addEventListener('click', () => {
        registryFilters.query = search.value = '';
        registryFilters.source = source.value = '';
        registryFilters.activity = activityFilter.value = '';
        syncSelect(source);
        syncSelect(activityFilter);
        draw();
        search.focus();
      });
      empty.append(element('p', 'No agents match these filters.'), reset);
      const row = element('tr');
      row.append(empty);
      rows.append(row);
    }
  }
  search.addEventListener('input', () => {registryFilters.query = search.value; draw();});
  source.addEventListener('change', () => {registryFilters.source = source.value; draw();});
  activityFilter.addEventListener('change', () => {registryFilters.activity = activityFilter.value; draw();});
  sort.addEventListener('change', () => {registryFilters.sort = sort.value; draw();});
  refreshWorkspaceView = () => {if (panel.isConnected && !rows.contains(document.activeElement)) draw();};
  draw();
  return panel;
}

async function loadModule(module, selectedTarget) {
  const request = ++moduleRequest;
  const currentRequest = () => request === moduleRequest && activeModule === module && !platformContent.hidden;
  activeModule = module;
  if (['agent', 'agents', 'studio', 'connections', 'skills'].includes(module)) showWorkspaceArea('home');
  else showWorkspaceArea('console');
  closeWorkspaceMenu();
  byId('tracing-content').hidden = true;
  platformContent.hidden = false;
  byId('crumb').textContent = modules[module][0];
  platformContent.replaceChildren(element('p', 'Loading…', 'loading'));
  document.querySelectorAll('.nav').forEach(button => {
    const current = button.dataset.module === (module === 'agent' ? 'agents' : module);
    button.classList.toggle('active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  try {
    const needsKeys = module === 'billing' || ((module === 'experiments' ||
      (module === 'console-agents' && selectedTarget?.section === 'evaluations')) && accountStatus?.user);
    const [nextRecords, nextBilling, nextKeys] = await Promise.all([
      module === 'billing' ? null : platformRequest(),
      ['billing', 'models'].includes(module) ? billingRequest() : null,
      needsKeys ? keyRequest() : null,
      module === 'feedback' ? refresh() : null
    ]);
    if (!currentRequest()) return;
    if (nextRecords) records = nextRecords;
    if (['billing', 'models'].includes(module)) billing = nextBilling;
    if (nextKeys) apiKeys = nextKeys;
    renderModule(module, selectedTarget);
  } catch (error) {
    if (currentRequest()) platformContent.replaceChildren(element('p', error.message));
  }
}

document.querySelectorAll('[data-module]').forEach(button => {
  button.addEventListener('click', () => loadModule(button.dataset.module));
});

byId('connect').addEventListener('click', async () => {
  const button = byId('connect');
  button.disabled = true;
  try {
    records = await platformRequest();
    openCreateAgent();
  } catch (error) {
    openModal('New agent', [element('p', error.message)]);
  } finally {
    button.disabled = false;
  }
});
