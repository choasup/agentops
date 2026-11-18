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
  deployments: ['Deployments', 'Publish saved Agent versions by environment.'],
  agent: ['Agent', ''],
  agents: ['All agents', 'Build an agent in Studio or connect one that runs in your application.'],
  studio: ['Studio', 'Send a test message and inspect the response and trace.']
};
let activeModule;
let moduleRequest = 0;
let records = [];
let apiKeys = [];
let billing;
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
    item.append(
      element('strong', key ? key.name + ' · ' + entry.model :
        entry.reference.startsWith('test-credit:') ? 'Test credit' : 'Top-up'),
      element('span', (entry.key_id ? '−' : '+') + billingMoney(Math.abs(entry.nanos))),
      element('small', timeLabel(entry.at))
    );
    if (entry.key_id) item.append(element('small',
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
  ...(billing?.model_available ? [[hostedProvider, recordName(hostedProvider)]] : []),
  ...ofKind('model').map(model => [model.id, model.name])
];
const promptOptions = () => ofKind('prompt').map(record => {
  const history = ofKind('prompt').filter(item => item.name === record.name);
  return [record.id, record.name + ' · v' + (history.length - history.indexOf(record))];
});

async function platformRequest(path = '', data) {
  const response = await fetch('/api/platform' + path, data === undefined ? {cache:'no-store'} : {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
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
    const skillName = field('name', 'Skill name');
    const skillInstructions = field('instructions', 'Instructions', 'textarea');
    skillName.querySelector('input').maxLength = 80;
    skillInstructions.querySelector('textarea').maxLength = 2000;
    const template = iconButton('prompt', 'Use repository quickstart template', 'button quiet');
    template.type = 'button';
    template.addEventListener('click', () => {
      skillName.querySelector('input').value = '仓库快速上手';
      skillInstructions.querySelector('textarea').value =
        '基于 GitHub 只读工具返回的 README，用中文按「项目用途」「快速启动」「阅读入口」三项提供上手指南。保留 README 里的启动命令和链接，缺失信息请明确说明。';
    });
    panels.push(formPanel('Create a Skill', [
      element('p', 'Requires the GitHub · agentops README connection. Assign the connection and Skill in each Agent’s Configuration.'),
      template, skillName, skillInstructions
    ], 'Save Skill', data => create('skills', data)));
    panels.push(listPanel('Saved Skills', ofKind('skill').map(skill => expandable(skill.name, {
      instructions:skill.instructions, required_connection:'GitHub · agentops README'
    }))));
  }

  if (module === 'connections') {
    const catalogue = [
      {id:'cloudflare-docs', name:'Cloudflare Documentation', access:'Read-only MCP',
        description:'Search public Cloudflare developer documentation.'},
      {id:'github-agentops', name:'GitHub · agentops', access:'Read-only connector',
        description:'Read only the public README from choasup/agentops on main. No GitHub account authorization is needed.'}
    ];
    for (const provider of catalogue) {
      const connection = ofKind('mcp_connection').find(item => !item.revoked &&
        (item.provider ?? 'cloudflare-docs') === provider.id);
      const card = listPanel(provider.name, [
        element('span', provider.access, 'pill'),
        element('p', provider.description),
        element('span', connection ? 'Connected' : 'Available', connection ? 'pill success' : 'pill')
      ]);
      card.classList.add('connection-card');
      const action = iconButton(connection ? 'close' : 'plus', connection ? 'Disconnect' : 'Connect');
      action.setAttribute('aria-label', (connection ? 'Disconnect ' : 'Connect ') + provider.name);
      const status = element('p');
      status.setAttribute('role', 'status');
      action.addEventListener('click', async () => {
        action.disabled = true;
        try {
          if (connection) await platformRequest('/mcp-disconnect', {connection:connection.id});
          else await platformRequest('/mcp-connect', {provider:provider.id});
          await loadModule('connections');
        } catch (error) {
          status.textContent = error.message;
          action.disabled = false;
        }
      });
      card.append(action, status);
      panels.push(card);
    }
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
      return expandable(dataset.name + ' · ' + examples.length + ' examples',
        examples.map(({input, expected}) => ({input, expected})));
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

  if (module === 'agent') {
    const agent = ofKind('agent').find(item => item.id === selectedTarget.id);
    if (!agent) {
      panels.push(listPanel('Agent unavailable', [element('p', 'Return to All agents to choose an Agent.')]));
    } else {
      const external = agent.source === 'external';
      const tabs = external ? [['integration', 'Integration'], ['activity', 'Activity']] :
        [['configuration', 'Configuration'], ['studio', 'Studio'], ...(accountStatus?.user ?
          [['versions', 'Versions'], ['evaluations', 'Evaluations'], ['releases', 'Releases']] : [])];
      const section = tabs.some(([id]) => id === selectedTarget.section) ? selectedTarget.section : tabs[0][0];
      headingText.replaceChildren(element('h1', agent.name));
      byId('crumb').textContent = agent.name;
      if (agent.description) headingText.append(element('p', agent.description));
      const back = iconButton('arrow', 'All agents', 'button quiet setup-back');
      back.addEventListener('click', () => loadModule('agents'));
      heading.append(back);
      const nav = element('nav', undefined, 'agent-detail-nav wide');
      nav.setAttribute('aria-label', 'Agent sections');
      for (const [id, label] of tabs) {
        const button = element('button', label, 'trace-tab');
        if (id === section) button.setAttribute('aria-current', 'page');
        button.addEventListener('click', () => openAgentDetail(agent.id, id));
        nav.append(button);
      }
      panels.push(nav);
      if (section === 'configuration') panels.push(agentConfigurationPanel(agent, async () => openAgentDetail(agent.id, section)));
      if (section === 'studio') panels.push(studioWorkspace([agent], agent.id, true));
      if (section === 'versions') panels.push(...agentReleasePanels(agent.id, 'versions'));
      if (section === 'releases') panels.push(...agentReleasePanels(agent.id, 'releases'));
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
  return loadModule('agent', {id, section});
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
      return expandable((version?.label ?? variant.version) + ' · ' + passed + '/' + variant.results.length, variant.results);
    });
    const section = element('div', undefined, 'release-entry');
    section.append(element('strong', recordName(item.agent) + ' · ' + recordName(item.dataset)),
      element('small', timeLabel(item.at)), ...variants);
    return section;
  }));
  if (versions.length < 2 || !datasets.length) return [listPanel('Compare Agent versions', [
    element('p', 'Save two versions of the same Agent in Deployments and add a dataset with expected text replies.')
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

function agentReleasePanels(agentId, section) {
  const agents = ofKind('agent').filter(agent => agent.source !== 'external' && (!agentId || agent.id === agentId));
  const versions = ofKind('agent_version').filter(version => !agentId || version.agent === agentId);
  const releases = ofKind('agent_release').filter(release => !agentId || release.agent === agentId);
  const reload = () => agentId ? openAgentDetail(agentId, section) : loadModule('deployments');
  const agentField = field('agent', 'Agent', agents.map(agent => [agent.id, agent.name]));
  if (agentId) {
    agentField.querySelector('select').value = agentId;
    agentField.hidden = true;
  }
  const byVersion = new Map(versions.map(version => [version.id, version]));
  const env = [['staging', 'Staging'], ['production', 'Production']];
  const save = agents.length ? formPanel('Save an Agent version', [
    agentField,
    field('label', 'Version label')
  ], 'Save version', async data => {
    await platformRequest('/agent-versions', data);
    await reload();
  }) : listPanel('Agent versions', [element('p', 'Create a Studio Agent first.')]);
  const versionOptions = versions.map(version => [version.id, recordName(version.agent) + ' · ' + version.label]);
  const publish = versions.length ? formPanel('Publish a saved version', [
    element('p', 'Production requires the version to pass its latest Agent evaluation. Staging is available for testing.'),
    field('version', 'Version', versionOptions), field('environment', 'Environment', env)
  ], 'Publish version', async data => {
    await platformRequest('/agent-releases', data);
    await reload();
  }) : listPanel('Publish a saved version', [element('p', 'Save a version before publishing.')]);
  const active = new Map();
  for (const release of releases) {
    const key = release.agent + ':' + release.environment;
    if (!active.has(key)) active.set(key, release);
  }
  const deployments = listPanel('Active Agent releases', Array.from(active.values(), release => {
    const name = recordName(release.agent);
    const version = byVersion.get(release.version);
    const item = element('section', undefined, 'release-entry');
    item.append(element('strong', name + ' · ' + release.environment),
      element('p', (version?.label ?? release.version) + ' · ' + timeLabel(release.at)));
    const request = {target_kind:'agent_release', target:release.agent, environment:release.environment, input:'Your message'};
    item.append(expandable('Run via API', {endpoint:'POST /api/platform/runs', required_scope:'agents:run',
      ...(version?.provider === hostedProvider ? {hosted_model_scope:'models:invoke'} : {}), body:request}));
    const previous = byVersion.get(release.previous);
    if (previous) {
      const disclosure = element('details');
      disclosure.append(element('summary', 'Roll back to ' + previous.label));
      const rollback = element('button', 'Confirm rollback', 'button');
      const status = element('p');
      status.setAttribute('role', 'status');
      rollback.addEventListener('click', async () => {
        rollback.disabled = true;
        try {
          await platformRequest('/agent-releases', {version:previous.id, environment:release.environment,
            expected_release:release.id});
          await reload();
        } catch (error) {
          status.textContent = error.message;
          rollback.disabled = false;
        }
      });
      disclosure.append(rollback, status);
      item.append(disclosure);
    }
    return item;
  }));
  const history = listPanel('Saved Agent versions', versions.map(version => expandable(
    recordName(version.agent) + ' · ' + version.label, {id:version.id, model:version.model,
      max_tokens:version.max_tokens, instructions:version.instructions})));
  if (section === 'versions') return [save, history];
  if (section === 'releases') return [publish, deployments];
  return [save, publish, deployments, history];
}

function brandMark() {
  const mark = element('img', undefined, 'mark');
  mark.src = 'mark.png';
  mark.alt = '';
  return mark;
}

function agentFields(data, models) {
  const root = element('div', undefined, 'agent-form-fields');
  const identity = element('div', undefined, 'agent-form-identity');
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
  const advanced = element('details', undefined, 'connection-advanced');
  const limit = field('max_tokens', 'Maximum output tokens', 'number', data.max_tokens ?? '');
  const limitInput = limit.querySelector('input');
  limitInput.required = false;
  limitInput.min = 1;
  limitInput.max = 4096;
  limitInput.placeholder = 'Model default';
  advanced.append(element('summary', 'Run settings'), limit);
  advanced.open = data.max_tokens != null && data.max_tokens !== '';
  root.append(identity, model, instructions, starter, advanced);
  const connections = ofKind('mcp_connection').filter(item => !item.revoked || item.id === data.mcp_connection);
  if (connections.length) {
    const tool = field('mcp_connection', 'Read-only tool', connections.map(item =>
      [item.id, item.name + (item.revoked ? ' (disconnected)' : '')]));
    const toolInput = tool.querySelector('select');
    toolInput.options[0].textContent = 'No tools';
    toolInput.required = false;
    toolInput.value = data.mcp_connection ?? '';
    const skills = ofKind('skill');
    const skill = field('skill', 'Installed Skill', skills.map(item => [item.id, item.name]));
    const skillInput = skill.querySelector('select');
    skillInput.options[0].textContent = 'No Skill';
    skillInput.required = false;
    skillInput.value = data.skill ?? '';
    const note = element('small');
    const showTool = () => {
      tool.hidden = modelInput.value !== hostedProvider;
      if (tool.hidden) toolInput.value = '';
      const connection = connections.find(item => item.id === toolInput.value);
      skill.hidden = !skills.length || connection?.provider !== 'github-agentops';
      if (skill.hidden) skillInput.value = '';
      note.hidden = !connection;
      if (connection) note.textContent = connection.scope ? 'Each run reads ' + connection.scope + '.' :
        'Each run searches public Cloudflare docs using the message you send.';
    };
    modelInput.addEventListener('change', showTool);
    toolInput.addEventListener('change', showTool);
    showTool();
    root.append(tool, note, skill);
  }
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

function agentSettings(agent, returnTo = 'agents') {
  if (agent.source === 'external') {
    externalIntegration(agent);
    return;
  }
  const currentModel = agent.provider ? recordName(agent.provider) : 'Workspace default';
  const content = element('div', undefined, 'agent-settings');
  content.append(element('p', 'Model: ' + currentModel));
  if (agent.identifier) content.append(element('p', 'Trace identifier: ' + agent.identifier));
  if (agent.kind === 'agent') content.append(agentConfigurationPanel(agent, async () => {
    byId('modal').close();
    await loadModule(returnTo, agent.id);
  }));
  openModal(agent.name, [content]);
}

function agentConfigurationPanel(agent, afterSave) {
  const choices = studioModels();
  if (agent.provider && !choices.some(([id]) => id === agent.provider)) choices.unshift([agent.provider, recordName(agent.provider)]);
  if (!agent.provider && choices.length) choices.unshift(['', 'Workspace default']);
  const fields = agentFields({...agent, provider:agent.provider ?? ''}, choices);
  const providerInput = fields.querySelector('select');
  if (!agent.provider) {
    providerInput.required = false;
    if (choices.length) providerInput.remove(0);
  }
  return formPanel('Agent configuration', [fields], 'Save changes', async data => {
    await platformRequest('/agent-update', {...agentPayload(data), agent:agent.id});
    await afterSave();
  });
}

function studioWorkspace(targets, selectedTarget, scoped = false) {
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
  selector.hidden = scoped;
  targetInput.value = selectedTarget ?? lastStudioTarget ?? targets[0].id;
  if (!targetInput.value) targetInput.value = targets[0].id;
  const model = element('span', undefined, 'studio-model');
  const configure = iconButton('settings', 'Configuration', 'button');
  toolbar.append(selector, model, configure);

  const split = element('div', undefined, 'studio-split');
  const history = element('aside', undefined, 'studio-history');
  history.append(element('h2', 'Runs'));
  const runList = element('div', undefined, 'studio-run-list');
  history.append(runList);
  const stage = element('div', undefined, 'studio-stage');
  const session = element('div', undefined, 'studio-stream');
  session.setAttribute('aria-live', 'polite');
  const form = element('form', undefined, 'studio-composer');
  const availableKeys = apiKeys.filter(key => !key.revoked && key.scopes.includes('models:invoke'));
  const billingField = field('billing_key', 'Charge to API key', availableKeys.map(key => [key.id, key.name]));
  const billingInput = billingField.querySelector('select');
  if (availableKeys.length === 1) billingInput.value = availableKeys[0].id;
  const manageKeys = iconButton('wallet', 'Open billing', 'button');
  manageKeys.type = 'button';
  manageKeys.addEventListener('click', () => loadModule('billing').then(() => {
    if (!availableKeys.length) byId('billing-api-keys')?.scrollIntoView();
  }));
  const message = element('textarea');
  message.rows = 2;
  message.required = true;
  const messageLabel = element('label', 'Message', 'sr');
  message.id = 'studio-message';
  messageLabel.htmlFor = message.id;
  const send = iconButton('play', 'Run', 'button primary');
  const hint = element('p', 'Each run is independent.');
  const formFooter = element('div', undefined, 'composer-footer');
  formFooter.append(hint, manageKeys, send);
  form.append(messageLabel, message, billingField, formFooter);
  stage.append(session, form);
  split.append(history, stage);
  panel.append(toolbar, split);

  let pending = false;
  let selectedRun;
  let lastError;
  let requestTrace;
  const current = () => targets.find(target => target.id === targetInput.value);
  const selectTarget = (reset = true) => {
    const target = current();
    lastStudioTarget = target.id;
    model.textContent = target.provider ? recordName(target.provider) : target.kind === 'deployment' ? 'Deployment' : 'Workspace default';
    const hosted = target.provider === hostedProvider;
    billingField.hidden = !hosted;
    billingInput.disabled = !hosted;
    manageKeys.hidden = !hosted;
    const connection = ofKind('mcp_connection').find(item => item.id === target.mcp_connection);
    const skill = ofKind('skill').find(item => item.id === target.skill);
    hint.textContent = connection?.revoked ? 'This Agent’s tool is disconnected. Change it in Configuration.' :
      connection?.scope ? (skill ? skill.name + ' · ' : '') + 'Reads ' + connection.scope + ' before answering.' :
      connection ? 'Your message is sent to Cloudflare Documentation for a read-only search.' :
      hosted ? 'Charges use your account balance.' : 'Each run is independent.';
    send.disabled = hosted && !availableKeys.length;
    configure.hidden = target.kind === 'deployment';
    if (reset) {
      selectedRun = undefined;
      requestTrace = undefined;
      lastError = undefined;
      message.value = '';
    }
    messageLabel.textContent = target.instructions ? 'Message' : 'Input JSON';
    message.placeholder = target.instructions ? 'Send a test message…' : 'Enter JSON input…';
    draw();
  };
  targetInput.addEventListener('change', () => selectTarget());
  configure.addEventListener('click', () => scoped ? openAgentDetail(current().id, 'configuration') : agentSettings(current(), 'studio'));

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
    if (!selectedRun) selectedRun = runs[0];
    runList.replaceChildren(...runs.map(run => {
      const row = element('button', undefined, 'studio-run');
      if (selectedRun?.id === run.id) row.setAttribute('aria-current', 'true');
      const label = typeof run.input === 'string' && run.input.trim() ? run.input : 'JSON input';
      const main = element('span', label, 'studio-run-name');
      const meta = element('span', timeLabel(run.at), 'studio-run-time');
      row.append(main, meta, statusPill(runStatus(run)));
      row.addEventListener('click', () => {
        selectedRun = run;
        lastError = undefined;
        draw();
        runList.querySelector('[aria-current]')?.focus();
      });
      return row;
    }));
    if (!runs.length) runList.append(element('p', 'No runs yet.', 'history-empty'));

    if (pending || lastError) {
      session.replaceChildren(element('p', pending ? 'Running…' : lastError,
        pending ? 'studio-pending' : 'studio-response is-error'));
      return;
    }
    if (!selectedRun) {
      session.replaceChildren(element('h2', 'Test ' + current().name),
        element('p', current().description || 'Run a test to see its response and execution trace.'));
      if (current().starter) {
        const starter = iconButton('arrow', 'Use starter message', 'button');
        starter.type = 'button';
        starter.addEventListener('click', () => {
          message.value = current().starter;
          message.focus();
        });
        session.append(starter);
      }
      return;
    }
    const run = selectedRun;
    const failed = runStatus(run) === 'error';
    const input = element('article', undefined, 'studio-message user-message');
    input.append(element('h3', 'Input'), readableContent(run.input));
    const reply = element('article', undefined, 'studio-message');
    const header = element('header', undefined, 'studio-response-head');
    header.append(element('h3', failed ? 'Run failed' : 'Response'), statusPill(runStatus(run)),
      element('span', latency(run.duration) + ' · ' + number.format(run.tokens) + ' tokens', 'step-time'));
    const actions = element('div', undefined, 'section-actions');
    const inspect = iconButton('traces', 'View trace', 'button');
    inspect.addEventListener('click', () => openConsoleTrace(run));
    const reuse = iconButton('copy', 'Reuse input', 'button quiet');
    reuse.addEventListener('click', () => {
      message.value = current().instructions && typeof run.input === 'string' ? run.input : JSON.stringify(run.input ?? null, null, 2);
      message.focus();
    });
    actions.append(inspect, reuse);
    reply.append(header, readableContent(failed ? run.error ?? 'Run failed' : run.output), actions);
    session.replaceChildren(input, reply);
  }

  function readableContent(value) {
    if (typeof value === 'string') return element('div', value, 'studio-message-text');
    return element('pre', JSON.stringify(value ?? null, null, 2));
  }

  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !pending) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const target = current();
    let input;
    try {
      input = target.instructions ? message.value : jsonInput(message.value);
      if (target.instructions && !input.trim()) throw new Error('Enter a test message.');
    } catch (error) {
      lastError = error.message;
      draw();
      return;
    }
    pending = true;
    lastError = undefined;
    targetInput.disabled = true;
    send.disabled = true;
    runList.inert = true;
    draw();
    const submitted = message.value;
    try {
      const trace = await platformRequest('/runs', {target:target.id, target_kind:target.kind, input,
        ...(target.provider === hostedProvider ? {billing_key:billingInput.value} : {})});
      selectedRun = requestTrace = trace;
      if (message.value === submitted) message.value = '';
      refresh();
    } catch (error) {
      lastError = error.message;
    } finally {
      pending = false;
      targetInput.disabled = false;
      send.disabled = false;
      runList.inert = false;
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
        const studio = iconButton('studio', 'Open Studio', 'button');
        studio.setAttribute('aria-label', 'Open ' + agent.name + ' in Studio');
        studio.addEventListener('click', () => openAgentDetail(agent.id, 'studio'));
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
  else if (!['models', 'billing'].includes(module)) showWorkspaceArea('console');
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
    if (module === 'feedback') await refresh();
    if ((module === 'experiments' || (module === 'agent' && selectedTarget.section === 'evaluations')) && accountStatus?.user) {
      const nextKeys = await keyRequest();
      if (!currentRequest()) return;
      apiKeys = nextKeys;
    }
    if (['billing','models','agents','agent','studio'].includes(module)) {
      const nextBilling = await billingRequest();
      const nextKeys = module === 'billing' || ((module === 'studio' || (module === 'agent' && selectedTarget.section === 'studio')) && nextBilling) ? await keyRequest() : null;
      if (!currentRequest()) return;
      billing = nextBilling;
      if (nextKeys) apiKeys = nextKeys;
    }
    if (module !== 'billing') {
      const next = await platformRequest();
      if (!currentRequest()) return;
      records = next;
    }
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
