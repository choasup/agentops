const platformContent = byId('platform-content');
const modules = {
  billing: ['Billing', 'Manage your balance, review usage, and access API keys.'],
  skills: ['Skills', 'Save reusable instructions that Agents can apply.'],
  connections: ['Connections', 'Explore available connectors and authorize resources such as WeCom channels.'],
  models: ['Models', 'Manage the model connections your agents run on.'],
  datasets: ['Datasets', 'Curate examples and reference outputs for evaluation.'],
  experiments: ['Experiments', 'Evaluate prompt versions against a dataset and compare scores.'],
  feedback: ['Review Queue', 'Score ingested traces and record reviewer feedback.'],
  prompts: ['Prompts', 'Save and reuse prompt template versions.'],
  playground: ['Playground', 'Test prompt versions with your inputs.'],
  deployments: ['Deployments', 'Inspect the active versions in each environment.'],
  agent: ['Agent', ''],
  'console-agents': ['Agents', 'Evaluate and monitor your Agents.'],
  gallery: ['Gallery', 'Chat with published Agents and find their integrations.'],
  'gallery-chat': ['Agent', ''],
  agents: ['Gallery', 'Find drafts, published agents, and external integrations.'],
  studio: ['Studio', 'Build, test, and publish Agents.']
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
    source:'https://github.com/choasup/agentops'},
  {id:'wecom-channel', brand:'WeCom', name:'WeCom',
    access:'Read-only connector', description:'Read recent posts from channels authorized through your WeCom bot.',
    source:'https://developer.work.weixin.qq.com/document/path/101964'}
];

function activeConnection(provider) {
  return ofKind('mcp_connection').find(item => !item.revoked &&
    (item.provider ?? 'cloudflare-docs') === provider.id);
}

function connectionIdentity(provider) {
  const identity = element('div', undefined, 'connection-identity');
  if (provider.logo) {
    const logo = element('img');
    logo.src = 'connectors/' + provider.logo;
    logo.alt = '';
    identity.append(logo);
  } else {
    identity.append(icon('external'));
  }
  identity.append(element('span', provider.brand));
  return identity;
}

function openWeComChannelConnection(provider, onAuthorized = () => loadModule('connections'), channelName = '') {
  const marker = 'AD-' + crypto.randomUUID().slice(0, 8).toUpperCase();
  const status = element('p', 'Checking the connected WeCom bot…');
  status.setAttribute('role', 'status');
  const topic = field('topic_id', 'Channel topic ID');
  const input = topic.querySelector('input');
  const fallback = element('details');
  fallback.append(element('summary', 'Enter a topic ID manually'), topic);
  const instructions = element('div');
  instructions.hidden = true;
  instructions.append(element('p', 'In the channel you want to connect, @mention your bot and send this code.'),
    element('code', marker));
  const copy = element('button', 'Copy code', 'button quiet');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(marker);
      copy.textContent = 'Copied';
    } catch {
      status.textContent = 'Copy the code shown above.';
    }
  });
  instructions.append(copy);
  const form = formPanel('Channel access', [status, instructions, field('name', 'Channel display name', 'text', channelName), fallback,
    ...(channelName ? [element('p', 'After restoring access, set up a new trigger for the channel.')] : [])
  ], 'Authorize channel', async data => {
    await platformRequest('/mcp-connect', {...data, provider:provider.id});
    byId('modal').close();
    await onAuthorized();
  });
  const submit = form.querySelector('button[type="submit"]');
  const updateButton = () => {submit.disabled = !input.value.trim();};
  input.addEventListener('input', updateButton);
  updateButton();
  openModal('Authorize WeCom channel', [form]);

  const active = () => form.isConnected && byId('modal').open;
  async function waitForTopic() {
    try {
      const gateway = await platformRequest('/wecom-status');
      if (!active()) return;
      if (!gateway.agent || gateway.status !== 'connected') {
        status.textContent = 'Connect your WeCom bot from the Agent’s Publish page, then reopen this setup.';
        return;
      }
      const discovery = await platformRequest('/wecom-topic-discover', {agent:gateway.agent, marker});
      if (!active()) return;
      if (discovery.state !== 'waiting') throw new Error('The WeCom bot disconnected. Reopen setup to retry.');
      status.textContent = 'Waiting for your @mention in WeCom.';
      instructions.hidden = false;
      async function poll() {
        if (!active()) return;
        try {
          const {topicDiscovery} = await platformRequest('/wecom-status');
          if (!active()) return;
          if (topicDiscovery?.id !== discovery.id) {
            status.textContent = 'This connection code expired or was replaced. Reopen setup to get a new code.';
          } else if (topicDiscovery.state === 'found') {
            if (!input.value.trim()) input.value = topicDiscovery.topicId;
            updateButton();
            status.textContent = 'Channel found. Enter a display name and verify read access.';
          } else if (topicDiscovery.state === 'missing') {
            status.textContent = 'WeCom delivered the @mention without a channel ID. Reopen setup to retry in the channel.';
          } else {
            setTimeout(poll, 2500);
          }
        } catch (error) {
          if (active()) status.textContent = error.message;
        }
      }
      setTimeout(poll, 1000);
    } catch (error) {
      if (active()) status.textContent = error.message;
    }
  }
  waitForTopic();
}

const readWeComPosts = '读取近期帖子';
const isWeComChannel = item => item.provider === 'wecom-channel';
const toolDisplayName = item => isWeComChannel(item) ? 'WeCom · ' + item.name : item.name;

function openWeComTrigger(agentId, channel, releases) {
  const trigger = ofKind('wecom_trigger').find(item => item.connection === channel.id && !item.disabled);
  if (trigger && trigger.agent !== agentId) return;
  async function change(action, data) {
    await platformRequest('/wecom-trigger-' + action, {...data, connection:channel.id});
    byId('modal').close();
    await openAgentDetail(agentId, 'publish');
  }
  if (trigger) {
    const current = element('p', recordName(trigger.agent) + ' · ' + trigger.environment +
      (trigger.marker ? ' · Matching posts only' : ' · All new posts') +
      (trigger.comment ? ' · Summarizes and comments on the original post' : ''));
    openModal(channel.name + ' · New post trigger', [current,
      ...(channel.revoked ? [element('p', 'Paused because channel access was removed.')] : []),
      formPanel('Trigger settings', [], 'Disable trigger', () => change('disable', {expected_trigger:trigger.id}))]);
    return;
  }
  if (!releases.length) {
    openModal(channel.name + ' · New post trigger', [
      element('p', 'Publish a version of this Agent using Hosted DeepSeek without an attached tool to enable this trigger.')]);
    return;
  }
  const target = field('environment', 'Released environment', releases.map(item =>
    [item.environment, item.environment === 'production' ? 'Production' : 'Staging']));
  if (releases.length === 1) target.querySelector('select').value = releases[0].environment;
  const marker = field('marker', 'Only posts containing (optional)');
  marker.querySelector('input').required = false;
  marker.querySelector('input').maxLength = 80;
  const comment = element('label', undefined, 'check-row');
  const commentInput = element('input');
  commentInput.type = 'checkbox';
  commentInput.name = 'comment';
  comment.append(commentInput, element('span', 'Summarize and comment on the original post'));
  openModal(channel.name + ' · New post trigger', [
    formPanel('When someone creates a post', [target, marker, comment,
      element('p', 'Matching new posts run this Agent without an @mention. The post text is sent to Hosted DeepSeek, uses your account balance, and appears in Console Traces.')
    ], 'Enable trigger', async data => {
      await change('enable', {agent:agentId, environment:data.environment, marker:data.marker,
        comment:data.comment === 'on'});
    })
  ]);
}

function openWeComConnector(provider) {
  const channels = ofKind('mcp_connection').filter(item => isWeComChannel(item) && !item.revoked);
  const add = iconButton('plus', 'Add channel', 'button primary');
  add.addEventListener('click', () => openWeComChannelConnection(provider));
  const list = listPanel('Available channels', channels.length ? channels.map(channel => {
    const row = element('div', undefined, 'studio-attachment-row');
    const text = element('div');
    text.append(element('strong', channel.name), element('small', readWeComPosts));
    const remove = element('button', 'Disconnect', 'button quiet');
    remove.setAttribute('aria-label', 'Disconnect ' + channel.name);
    remove.addEventListener('click', () => openModal('Disconnect ' + channel.name, [
      formPanel('Remove channel access', [element('p', 'Removing access stops Agent reads and triggers for this channel.')],
        'Disconnect channel', async () => {
          await platformRequest('/mcp-disconnect', {connection:channel.id});
          await loadModule('connections');
          openWeComConnector(provider);
        })
    ]));
    row.append(text, remove);
    return row;
  }) : [element('p', 'Add a channel to grant read access.')]);
  openModal('WeCom channel access', [
    element('p', 'Choose channels in an Agent’s Configure panel to read posts, or in Publish to set up a new-post trigger.'),
    list, add
  ]);
}

function openConnectionReview(provider) {
  if (provider.id === 'wecom-channel') return openWeComConnector(provider);
  openModal(provider.name, [connectionIdentity(provider), element('p', provider.description),
    element('code', provider.source), element('p', 'No account authorization required. Add this tool in an Agent’s Configure panel.')]);
}

function connectionCard(provider) {
  const card = element('section', undefined, 'panel module-panel connection-card');
  const wecom = provider.id === 'wecom-channel';
  const status = wecom ? 'Channel access required' : 'Public access';
  const head = element('div', undefined, 'connection-card-head');
  head.append(connectionIdentity(provider), element('span', status, 'pill'));
  const label = wecom ? 'Manage access' : 'Details';
  const action = iconButton(wecom ? 'settings' : 'external', label, 'button');
  action.setAttribute('aria-label', label + ' · ' + provider.name);
  action.addEventListener('click', () => openConnectionReview(provider));
  const footer = element('div', undefined, 'connection-card-head');
  footer.append(element('span', provider.access, 'pill'), action);
  card.append(head, element('h2', provider.name),
    element('p', provider.description), footer);
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
      provider.id === 'cloudflare-docs' ? 'Docs MCP' : provider.id === 'github-agentops' ? 'agentops README' : 'Channel access'));
    button.addEventListener('click', () => openConnectionReview(provider));
    actions.append(button);
  }
  shortcuts.append(actions);
  openModal('Find by link or command', [form, shortcuts]);
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
    const install = iconButton('terminal', 'Find by link or command', 'button');
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

  if (module === 'gallery' || module === 'agents') {
    const navigation = element('nav', undefined, 'agent-detail-nav wide');
    navigation.setAttribute('aria-label', 'Gallery views');
    for (const [view, label] of [['gallery', 'Published'], ['agents', 'All agents']]) {
      const tab = element('button', label, 'trace-tab');
      if (view === module) tab.setAttribute('aria-current', 'page');
      else tab.addEventListener('click', () => loadModule(view));
      navigation.append(tab);
    }
    panels.push(navigation, ...(module === 'gallery' ? agentGallery() : [agentRegistry()]));
  }

  if (module === 'gallery-chat') {
    const agent = ofKind('agent').find(item => item.id === selectedTarget?.id);
    const back = iconButton('arrow', 'Switch Agent', 'button quiet');
    back.addEventListener('click', () => loadModule('gallery'));
    heading.append(back);
    const releases = agent && galleryReleases(agent.id);
    if (accountStatus?.user && releases?.size) {
      headingText.replaceChildren(element('h1', agent.name));
      if (agent.description) headingText.append(element('p', agent.description));
      byId('crumb').textContent = agent.name;
      panels.push(agentSections(agent.id, 'chat', agentHomeTabs(agent.id)),
        publishedAgentChat(agent, releases, selectedTarget.environment));
    } else {
      const unavailable = listPanel('Agent unavailable', [element('p', 'Choose an active release in Gallery.')]);
      unavailable.classList.add('wide');
      panels.push(unavailable);
    }
  }

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
      const back = iconButton('arrow', inConsole ? 'Console agents' : 'Studio', 'button quiet');
      back.addEventListener('click', () => loadModule(inConsole ? 'console-agents' : 'gallery'));
      panels.push(listPanel('Agent unavailable', [back]));
    } else {
      const external = agent.source === 'external';
      const tabs = inConsole ? [] : external ? [['integration', 'Integration'], ['activity', 'Activity']] :
        accountStatus?.user ? agentHomeTabs(agent.id) : [];
      const section = inConsole ? 'evaluations' : !external && selectedTarget.section === 'configure' ? 'configure' : tabs.some(([id]) => id === selectedTarget.section)
        ? selectedTarget.section : external ? 'integration' : accountStatus?.user ? 'configure' : 'studio';
      const showIdentity = updated => {
        headingText.replaceChildren(element('h1', updated.name));
        byId('crumb').textContent = updated.name;
        if (updated.description) headingText.append(element('p', updated.description));
      };
      showIdentity(agent);
      const actions = element('div', undefined, 'section-actions');
      const back = iconButton('arrow', inConsole ? 'Console agents' : 'Switch Agent', 'button quiet setup-back');
      back.addEventListener('click', () => loadModule(inConsole ? 'console-agents' : 'gallery'));
      actions.append(back);
      if (!external && accountStatus?.user) {
        const jump = iconButton(inConsole ? 'studio' : 'external', inConsole ? 'Open Build' : 'Evaluations', 'button quiet');
        jump.addEventListener('click', () => openAgentDetail(agent.id, inConsole ? 'configure' : 'evaluations'));
        actions.append(jump);
        if (inConsole) {
          const publish = iconButton('deploy', 'Open Publish', 'button');
          publish.addEventListener('click', () => openAgentDetail(agent.id, 'publish'));
          actions.append(publish);
        }
      }
      heading.append(actions);
      if (tabs.length) panels.push(agentSections(agent.id, section, tabs));
      if (section === 'studio') panels.push(studioWorkspace([agent], agent.id, true));
      if (section === 'configure') panels.push(accountStatus?.user
        ? agentChatBuilder(agent, showIdentity) : agentConfigurationPage(agent, showIdentity));
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
    if (accountStatus?.user && studioModels().length) panels.push(agentChatBuilder());
    else {
      const manual = element('button', 'Other setup options', 'button quiet');
      manual.addEventListener('click', openCreateAgent);
      heading.append(manual);
      panels.push(agentDraftComposer());
    }
    const deployments = ofKind('deployment');
    if (deployments.length) {
      const test = element('details', undefined, 'panel module-panel wide');
      test.append(element('summary', 'Test a registered deployment'), studioWorkspace(deployments));
      panels.push(test);
    }
  }

  const grid = element('div', undefined, 'module-grid');
  grid.append(...panels);
  platformContent.replaceChildren(heading, grid);
}

let currentAgentId;
const currentAgentKey = 'agent-deck:current-agent';

async function openCurrentAgent() {
  try {
    const catalog = await platformRequest();
    const agents = catalog.filter(item => item.kind === 'agent' && item.source !== 'external');
    const releases = catalog.filter(item => item.kind === 'agent_release');
    const versions = new Set(catalog.filter(item => item.kind === 'agent_version').map(item => item.id));
    let remembered = currentAgentId;
    try {remembered ??= sessionStorage.getItem(currentAgentKey);}
    catch {}
    const hasRelease = (agent, environment) => {
      const release = releases.find(item => item.agent === agent.id && item.environment === environment);
      return versions.has(release?.version);
    };
    const agent = agents.find(item => item.id === remembered) ?? agents.find(item => hasRelease(item, 'production')) ??
      agents.find(item => hasRelease(item, 'staging')) ?? agents[0];
    if (!agent) return loadModule('studio');
    if (accountStatus?.user && ['production', 'staging'].some(environment => hasRelease(agent, environment))) {
      return loadModule('gallery-chat', {id:agent.id});
    }
    return openAgentDetail(agent.id, 'configure');
  } catch {
    return loadModule('gallery');
  }
}

function agentHomeTabs(agentId) {
  return [...(galleryReleases(agentId).size ? [['chat', 'Chat']] : []),
    ['configure', 'Build'], ['studio', 'Runs'], ['publish', 'Publish']];
}

function agentSections(agentId, current, tabs) {
  const nav = element('nav', undefined, 'agent-detail-nav wide');
  nav.setAttribute('aria-label', 'Agent sections');
  for (const [id, label] of tabs) {
    const button = element('button', label, 'trace-tab');
    if (id === current) button.setAttribute('aria-current', 'page');
    else button.addEventListener('click', () => openAgentDetail(agentId, id));
    nav.append(button);
  }
  return nav;
}

function openAgentDetail(id, section) {
  const module = section === 'evaluations' ? 'console-agents' : section === 'chat' ? 'gallery-chat' : 'agent';
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

function galleryReleases(agentId) {
  const releases = ofKind('agent_release');
  const versions = new Map(ofKind('agent_version').map(version => [version.id, version]));
  const active = new Map();
  for (const environment of ['production', 'staging']) {
    const release = releases.find(item => item.agent === agentId && item.environment === environment);
    const version = versions.get(release?.version);
    if (version) active.set(environment, {release, version});
  }
  return active;
}

function agentGallery() {
  const triggers = ofKind('wecom_trigger').filter(item => !item.disabled);
  const channels = new Set(ofKind('mcp_connection').filter(item => !item.revoked).map(item => item.id));
  const botStatus = accountStatus?.user ? platformRequest('/wecom-status').catch(() => null) : Promise.resolve(null);
  const cards = [];
  for (const agent of ofKind('agent')) {
    const environments = galleryReleases(agent.id);
    if (!environments.size) continue;
    const card = element('article', undefined, 'panel module-panel gallery-card');
    const badges = element('div', undefined, 'section-actions');
    if (environments.has('production')) badges.append(element('span', 'Production', 'pill success'));
    if (environments.has('staging')) badges.append(element('span', 'Staging · Test', 'pill'));
    badges.append(element('span', 'API', 'pill'));
    const hasTrigger = triggers.some(item => item.agent === agent.id &&
      environments.has(item.environment) && channels.has(item.connection));
    botStatus.then(bot => {
      const direct = bot?.agent === agent.id && environments.has(bot.environment);
      if (direct || hasTrigger) badges.append(element('span', direct
        ? 'WeCom · ' + (bot.status === 'connected' ? 'Online' : 'Offline') : 'WeCom trigger', 'pill'));
    });
    const actions = element('div', undefined, 'section-actions');
    const chat = element('button', 'Chat', 'button primary');
    chat.setAttribute('aria-label', 'Chat with ' + agent.name);
    chat.addEventListener('click', () => loadModule('gallery-chat', {id:agent.id}));
    const use = element('button', 'Integrations', 'button quiet');
    use.setAttribute('aria-label', 'Integrations for ' + agent.name);
    use.addEventListener('click', () => openAgentUsage(agent, true));
    actions.append(chat, use);
    card.append(element('h2', agent.name));
    if (agent.description) card.append(element('p', agent.description));
    card.append(badges, actions);
    cards.push(card);
  }
  if (cards.length) return cards;
  const studio = element('button', 'Open Studio', 'button primary');
  studio.addEventListener('click', () => loadModule('studio'));
  const empty = listPanel('No published Agents', [element('p', 'Publish an Agent from Studio to add it to Gallery.'), studio]);
  empty.classList.add('wide');
  return [empty];
}

function recentChatMessages(turns) {
  const history = turns.filter(turn => !turn.trace.error && typeof turn.trace.output === 'string')
    .slice(-6).flatMap(turn => [{role:'user', content:turn.input}, {role:'assistant', content:turn.trace.output}]);
  while (new TextEncoder().encode(JSON.stringify(history)).length > 20_000) history.splice(0, 2);
  return history;
}

function appendChatTurn(conversation, input, trace) {
  const reply = element('article', undefined, 'agent-chat-reply');
  reply.append(element('p', trace.error ?? trace.output ?? 'No reply.'));
  const link = traceLink(trace.id, 'View trace');
  link.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showTrace(trace);
  });
  reply.append(link);
  conversation.append(element('p', input, 'agent-chat-user'), reply);
}

function publishedAgentChat(agent, releases, environment) {
  const panel = element('section', undefined, 'agent-chat-builder wide');
  const toolbar = element('div', undefined, 'agent-chat-heading published-chat-heading');
  const target = field('environment', 'Release', Array.from(releases, ([environment, {version}]) =>
    [environment, (environment === 'production' ? 'Production' : 'Staging · Test') + ' · ' + version.label]));
  const select = target.querySelector('select');
  select.value = releases.has(environment) ? environment : releases.keys().next().value;
  const newChat = element('button', 'New conversation', 'button quiet');
  const integrations = element('button', 'Integrations', 'button quiet');
  integrations.addEventListener('click', () => openAgentUsage(agent, true));
  const actions = element('div', undefined, 'section-actions');
  actions.append(newChat, integrations);
  toolbar.append(target, actions);
  const conversation = element('div', undefined, 'agent-chat-conversation');
  conversation.setAttribute('role', 'log');
  conversation.setAttribute('aria-label', 'Conversation');
  const form = element('form', undefined, 'agent-chat-composer');
  const message = element('textarea');
  message.rows = 3;
  message.required = true;
  message.placeholder = 'Message ' + agent.name + '…';
  message.setAttribute('aria-label', 'Message');
  const send = iconButton('arrow', 'Send', 'button primary agent-chat-send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Send');
  const status = element('p', undefined, 'studio-run-notice');
  status.setAttribute('role', 'status');
  const controls = element('div', undefined, 'agent-chat-controls published-chat-controls');
  controls.append(send);
  form.append(message, controls, status);
  panel.append(toolbar, conversation, form);

  const turns = [];
  let pending = false;
  function update() {
    send.disabled = pending || !message.value.trim();
    select.disabled = pending || turns.length > 0;
    syncSelect(select);
    newChat.hidden = !turns.length;
    newChat.disabled = pending;
  }
  newChat.addEventListener('click', () => {
    turns.length = 0;
    conversation.replaceChildren();
    status.textContent = '';
    message.value = '';
    update();
    message.focus();
  });
  message.addEventListener('input', update);
  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (send.disabled) return;
    const input = message.value.trim();
    const environment = select.value;
    const {release} = releases.get(environment);
    pending = true;
    message.value = '';
    status.textContent = '';
    const question = element('p', input, 'agent-chat-user');
    const waiting = element('p', 'Waiting for a reply…', 'agent-chat-pending');
    conversation.append(question, waiting);
    update();
    message.focus();
    try {
      const trace = await platformRequest('/runs', {target_kind:'agent_release', target:agent.id,
        environment, expected_release:release.id, surface:'gallery', input, history:recentChatMessages(turns)});
      turns.push({input, trace});
      question.remove();
      waiting.remove();
      appendChatTurn(conversation, input, trace);
      conversation.lastElementChild.scrollIntoView({block:'nearest'});
    } catch (error) {
      question.remove();
      waiting.remove();
      if (!message.value) message.value = input;
      status.textContent = error.message;
    } finally {
      pending = false;
      update();
    }
  });
  update();
  return panel;
}

function openAgentUsage(agent, publishedOnly = false) {
  const options = publishedOnly ? [] : [['draft', 'Draft · development']];
  const releases = new Map();
  for (const [id, label] of [['production', 'Production'], ['staging', 'Staging']]) {
    const release = ofKind('agent_release').find(item => item.agent === agent.id && item.environment === id);
    const version = release && ofKind('agent_version').find(item => item.id === release.version);
    if (version) {
      releases.set(id, version);
      options.unshift([id, label + ' · ' + version.label]);
    }
  }
  if (!options.length) return;
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
  if (publishedOnly) {
    const channel = element('p');
    platformRequest('/wecom-status').then(result => {
      if (result.agent === agent.id && releases.has(result.environment)) {
        channel.textContent = 'WeCom bot · ' + result.environment + ' · ' +
          (result.status === 'connected' ? 'Online' : 'Offline');
      }
    }).catch(() => {});
    const triggers = ofKind('wecom_trigger').filter(item => item.agent === agent.id && !item.disabled && releases.has(item.environment));
    for (const trigger of triggers) {
      const resource = ofKind('mcp_connection').find(item => item.id === trigger.connection && !item.revoked);
      if (resource) body.append(element('p', 'WeCom channel · ' + resource.name + ' · ' + trigger.environment));
    }
    body.append(channel);
  }
  openModal(publishedOnly ? 'Integrations' : 'Use Agent', [body]);
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
    if (id === 'staging') {
      const publishDraft = element('button', activeRelease ? 'Update from draft' : 'Publish draft', 'button');
      publishDraft.addEventListener('click', () => {
        let savedVersion;
        openAction(activeRelease ? 'Update Staging' : 'Publish to Staging', [
          element('p', 'Save your current Agent configuration as a version and make it callable via the Staging API.')
        ], 'Publish to Staging', async () => {
          savedVersion ??= await platformRequest('/agent-versions', {agent:agentId,
            label:new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'});
          const release = await platformRequest('/agent-releases', {version:savedVersion.id, environment:'staging',
            ...(activeRelease ? {expected_release:activeRelease.id} : {only_if_unpublished:true})});
          if (release.version !== savedVersion.id) throw new Error('Staging was published elsewhere. Refresh before updating it.');
        });
      });
      actions.append(publishDraft);
    }
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
  return [...channelPublishingPanels(agentId, active), environments, management];
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
  const diagnostics = element('details');
  const events = element('pre', 'No gateway events recorded yet.');
  diagnostics.hidden = true;
  const probeResult = element('p');
  probeResult.setAttribute('role', 'status');
  const topicField = field('topic_id', 'Channel topic ID');
  const topicInput = topicField.querySelector('input');
  const discoveryStatus = element('p');
  discoveryStatus.setAttribute('role', 'status');
  const discovery = formPanel('Find channel topic ID', [
    field('marker', 'Mention test marker')
  ], 'Listen for test mention', async data => {
    const result = await platformRequest('/wecom-topic-discover', {...data, agent:agentId});
    if (result.state !== 'waiting') throw new Error('The bot is not connected to this Agent.');
    discoveryStatus.textContent = 'Mention the bot in the target channel and include the test marker.';
  });
  const probe = formPanel('Check channel read access', [
    element('p', 'Checks a test marker in up to five posts from the last 15 minutes. Channel content is neither displayed nor saved.'),
    topicField,
    field('marker', 'Test marker')
  ], 'Check channel', async data => {
    probeResult.textContent = 'Checking channel…';
    try {
      const result = await platformRequest('/wecom-topic-probe', {...data, agent:agentId});
      const messages = {matched:'Test post found.', disconnected:'The bot is not connected to this Agent.',
        no_response:'WeCom did not acknowledge the request.', invalid_response:'WeCom returned an unexpected response.',
        rejected:'WeCom rejected the request (code ' + result.code + ').',
        not_matched:'Read access confirmed. No marker in ' + result.checked + ' recent posts.' +
          (result.has_more ? ' More posts are available.' : '')};
      probeResult.textContent = messages[result.state] ?? 'Unknown response';
    } catch (error) {
      probeResult.textContent = error.message;
    }
  });
  diagnostics.append(element('summary', 'Gateway diagnostics'), events, discovery, discoveryStatus, probe, probeResult);
  heading.append(element('p', 'Cloudflare hosts this connection. Replies use the selected release and your account balance.'), status, current, diagnostics);
  async function update(data) {
    try {
      const result = data ?? await platformRequest('/wecom-status');
      renderWeComStatus(status, result, agentId);
      diagnostics.hidden = result.agent !== agentId;
      events.textContent = result.agent === agentId && result.diagnostics?.length
        ? result.diagnostics.map(({event, result}) => event + ' · ' + result).join('\n')
        : 'No gateway events recorded yet.';
      if (result.agent === agentId && result.topicDiscovery?.state === 'found') {
        discoveryStatus.textContent = 'Channel topic ID found.';
        if (!topicInput.value) topicInput.value = result.topicDiscovery.topicId;
      } else if (result.agent === agentId && result.topicDiscovery?.state === 'missing') {
        discoveryStatus.textContent = 'The test mention arrived without a channel topic ID.';
      }
      onStatus?.(result);
      disconnect.hidden = result.agent !== agentId;
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
  const form = formPanel('Connect a bot', [element('p', 'Use a bot created in API mode with a long connection. Saving replaces the bot currently connected to your account.'),
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

function wecomAgentTriggersPanel(agentId) {
  const versions = ofKind('agent_version');
  const releases = ofKind('agent_release').filter(release => {
    if (release.agent !== agentId) return false;
    const version = versions.find(item => item.id === release.version);
    return version?.provider === hostedProvider && !version.mcp_connection;
  });
  const triggers = ofKind('wecom_trigger').filter(item => !item.disabled);
  const channels = ofKind('mcp_connection').filter(item => isWeComChannel(item) &&
    (!item.revoked || triggers.some(trigger => trigger.connection === item.id && trigger.agent === agentId)));
  const provider = connectionCatalogue.find(item => item.id === 'wecom-channel');
  const authorize = name => openWeComChannelConnection(provider, () => openAgentDetail(agentId, 'publish'), name);
  const rows = channels.map(channel => {
    const trigger = triggers.find(item => item.connection === channel.id);
    const owned = trigger?.agent === agentId;
    const release = owned && releases.find(item => item.environment === trigger.environment);
    const row = element('div', undefined, 'console-agent-row');
    const info = element('div');
    const status = channel.revoked ? 'Paused · Channel access removed' :
      owned ? (release ? 'Enabled · ' : 'Needs compatible release · ') + trigger.environment :
      trigger ? 'Used by ' + recordName(trigger.agent) : 'Trigger off';
    info.append(element('strong', channel.name), element('p', status));
    if (owned) info.append(element('small', (trigger.marker ? 'Matching posts only' : 'All new posts') +
      (trigger.comment ? ' · Comments on original post' : '')));
    row.append(info);
    if (!trigger || owned) {
      const actions = element('div', undefined, 'section-actions');
      if (channel.revoked) {
        const restore = element('button', 'Reauthorize', 'button');
        restore.setAttribute('aria-label', 'Reauthorize · ' + channel.name);
        restore.addEventListener('click', () => authorize(channel.name));
        actions.append(restore);
      }
      const action = element('button', owned ? 'Manage trigger' : 'Set up trigger', 'button');
      action.setAttribute('aria-label', action.textContent + ' · ' + channel.name);
      action.addEventListener('click', () => openWeComTrigger(agentId, channel, releases));
      actions.append(action);
      row.append(actions);
    }
    return row;
  });
  const add = iconButton('plus', 'Authorize channel', 'button');
  add.addEventListener('click', () => authorize(''));
  const heading = element('div', undefined, 'wecom-channel-heading');
  heading.append(element('h3', 'Channel triggers'), add);
  const section = element('section', undefined, 'wecom-channel-triggers');
  section.append(heading, ...(rows.length ? rows : [element('p', 'Authorize a channel to run this Agent on new posts.')]));
  return section;
}

function channelPublishingPanels(agentId, releases) {
  const channels = [
    {name:'企业微信', mode:'wecom', description:'企微消息回复由 Agent Deck 托管。'},
    {name:'微信客服', mode:'wechat-kf', description:'自托管网关 · 需要 HTTPS 回调'}
  ];
  return channels.map(channel => {
    const panel = element('section', undefined, 'panel module-panel wide');
    panel.append(element('h2', channel.name));
    if (channel.mode === 'wecom') panel.classList.add('wecom-publishing');

    const row = element('div', undefined, 'console-agent-row');
    const info = element('div');
    if (channel.mode === 'wecom') info.append(element('strong', '机器人连接'));
    info.append(element('p', channel.description));
    const setup = iconButton('settings', channel.mode === 'wecom' ? 'Connect bot' : 'Set up gateway', 'button');
    const connection = element('div', undefined, 'wecom-status');
    const onStatus = channel.mode === 'wecom' ? result => {
      renderWeComStatus(connection, result, agentId);
      const label = result.agent === agentId ? 'Manage bot' : result.agent ? 'Change bot routing' : 'Connect bot';
      setup.querySelector('span').textContent = label;
      setup.setAttribute('aria-label', label);
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
    if (channel.mode === 'wecom') panel.append(wecomAgentTriggersPanel(agentId));
    return panel;
  });
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
  const advanced = element('section', undefined, 'panel module-panel agent-config-section');
  const limit = field('max_tokens', 'Maximum output tokens', 'number', data.max_tokens ?? '');
  const limitInput = limit.querySelector('input');
  limitInput.required = false;
  limitInput.min = 1;
  limitInput.max = 4096;
  limitInput.placeholder = 'Model default';
  advanced.append(element('h2', 'Run settings'), limit);
  const profile = element('section', undefined, 'panel module-panel agent-config-section');
  profile.append(element('h2', 'Agent details'), identity, starter);
  const behavior = element('section', undefined, 'panel module-panel agent-config-section');
  behavior.append(element('h2', 'Model and instructions'), model, instructions);
  const column = element('div', undefined, 'agent-config-column');
  column.append(behavior, profile, advanced);
  root.append(column, studioAttachments(data, modelInput));
  return root;
}

function studioAttachments(data, modelInput) {
  const connections = ofKind('mcp_connection');
  for (const provider of connectionCatalogue) {
    if (provider.id !== 'wecom-channel' && !activeConnection(provider)) {
      connections.push({id:provider.id, provider:provider.id, name:provider.name,
        scope:provider.access, description:provider.description});
    }
  }
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
    const section = element('section', undefined, 'panel module-panel studio-attachment-section');
    section.dataset.attachment = name;
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
      if (tool) return item.revoked ? 'Access removed' : isWeComChannel(item)
        ? readWeComPosts : item.scope ?? 'Read-only';
      if (item.builtin) return item.source + ' · Built-in';
      if (!item.requires) return '';
      const provider = connectionCatalogue.find(entry => entry.id === item.requires);
      return 'Requires ' + (provider?.name ?? item.requires);
    };
    return {section, update() {
      const id = getId();
      input.value = hosted() ? id : '';
      add.disabled = !hosted();
      if (tool) add.querySelector('span').textContent = id ? 'Replace tool' : 'Add tool';
      add.setAttribute('aria-expanded', String(picker === name));
      list.hidden = picker !== name;
      current.replaceChildren();
      const installed = items.find(item => item.id === id);
      if (installed) {
        const row = element('div', undefined, 'studio-attachment-row');
        const identity = element('div');
        identity.append(element('strong', tool ? toolDisplayName(installed) : installed.name));
        if (detail(installed)) identity.append(element('small', detail(installed)));
        const remove = iconButton('close', 'Remove', 'button quiet');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove ' + (tool ? toolDisplayName(installed) : installed.name));
        remove.addEventListener('click', () => select('', true));
        if (tool) {
          const details = element('details', undefined, 'agent-tool-details');
          const provider = connectionCatalogue.find(item => item.id === (installed.provider ?? 'cloudflare-docs'));
          const summary = element('summary', 'Tool details');
          details.append(summary, element('p', installed.revoked
            ? 'Access was removed. Choose an available resource to restore this tool.'
            : installed.scope ?? provider?.description ?? 'Read-only access.'));
          if (isWeComChannel(installed) && !installed.revoked) {
            details.append(element('p', 'Reads recent posts before answering · Last 15 minutes · Up to 5 posts'));
          }
          details.append(remove);
          row.append(identity);
          current.append(row, details);
        } else {
          row.append(identity, remove);
          current.append(row);
        }
      } else current.append(element('p', tool ? 'No connector enabled for this Agent' : 'No Skill installed'));
      list.replaceChildren();
      if (list.hidden) return;
      const choices = items.filter(item => item.id !== id && !item.revoked);
      if (!choices.length) list.append(element('p', emptyText));
      for (const item of choices) {
        const row = element('button', undefined, 'studio-attachment-choice');
        row.type = 'button';
        row.disabled = !tool && !compatible(item);
        row.append(element('strong', tool ? toolDisplayName(item) : item.name));
        if (detail(item)) row.append(element('small', detail(item)));
        if (item.description) row.append(element('small', item.description));
        row.addEventListener('click', () => select(item.id));
        list.append(row);
      }
    }};
  };
  const tools = makeSection('Connector tools', 'mcp_connection', connections, () => connectionId, id => {
    connectionId = id;
    const skill = skills.find(item => item.id === skillId);
    if (skill && !compatible(skill)) {
      skillId = '';
      notice.textContent = skill.name + ' was removed because it requires the previous tool.';
    }
  }, 'No other tools available. Authorize WeCom channels in Home → Connections.');
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
  root.addEventListener('openattachment', event => {
    picker = hosted() ? event.detail : undefined;
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

async function resolveDraftTool(draft) {
  const provider = connectionCatalogue.find(item => item.id === draft.mcp_connection && item.id !== 'wecom-channel');
  if (!provider) return draft;
  const connection = await platformRequest('/mcp-connect', {provider:provider.id});
  if (!records.some(item => item.id === connection.id)) records.push(connection);
  return {...draft, mcp_connection:connection.id};
}

function agentChatBuilder(agent, showIdentity) {
  let saved = agent;
  let busy = false;
  let testedConfiguration;
  let savedConfiguration;
  let pendingInput;
  const turns = [];
  const root = element('section', undefined, 'agent-chat-builder wide');
  const header = element('div', undefined, 'agent-chat-heading');
  const publish = iconButton('deploy', 'Publish draft', 'button primary');
  const save = element('button', 'Save draft', 'button quiet');
  const reset = element('button', 'New conversation', 'button quiet');
  const setup = element('button', 'Other setup options', 'button quiet');
  const overflow = element('details', undefined, 'agent-chat-overflow');
  const more = element('summary', '···', 'button quiet icon-button');
  more.setAttribute('aria-label', 'More Studio actions');
  const menu = element('div', undefined, 'agent-chat-overflow-items');
  menu.append(save, reset, setup);
  overflow.append(more, menu);
  overflow.addEventListener('focusout', event => {
    if (event.relatedTarget && !overflow.contains(event.relatedTarget)) overflow.open = false;
  });
  overflow.addEventListener('keydown', event => {
    if (event.key === 'Escape' && overflow.open) {
      overflow.open = false;
      more.focus();
    }
  });
  setup.addEventListener('click', () => {
    overflow.open = false;
    openCreateAgent();
  });
  const actions = element('div', undefined, 'section-actions agent-chat-actions');
  actions.append(publish, overflow);
  const draftState = element('small', undefined, 'agent-chat-draft-state');
  const identity = element('div', undefined, 'agent-chat-identity');
  const conversation = element('div', undefined, 'agent-chat-conversation');
  conversation.setAttribute('role', 'log');
  conversation.setAttribute('aria-label', 'Test conversation');

  const models = studioModels();
  if (agent?.provider && !models.some(([id]) => id === agent.provider)) models.unshift([agent.provider, recordName(agent.provider)]);
  const modelField = field('provider', 'Model', models);
  const model = modelField.querySelector('select');
  model.value = agent?.provider ?? models[0]?.[0] ?? '';
  const name = field('name', 'Agent name', 'text', agent?.name ?? '');
  const instructions = field('instructions', 'System prompt', 'textarea', agent?.instructions ?? '');
  name.querySelector('input').required = false;
  name.querySelector('input').placeholder = 'Untitled Agent';
  instructions.querySelector('textarea').required = false;
  instructions.querySelector('textarea').placeholder = 'Tell the Agent how it should respond.';
  const settings = element('div', undefined, 'agent-chat-settings');
  const done = element('button', 'Done', 'button');
  done.type = 'button';
  name.classList.add('agent-chat-name');
  identity.append(name, draftState);
  header.append(identity, actions);
  settings.append(instructions, done);
  const resources = studioAttachments(agent ?? {}, model);
  const picker = element('div', undefined, 'agent-composer-picker');
  const add = iconButton('plus', 'Add', 'button quiet agent-composer-add');
  add.type = 'button';
  add.setAttribute('aria-label', 'Add skills or connectors');
  const prompt = iconButton('prompt', 'Prompt', 'button quiet');
  prompt.type = 'button';
  prompt.setAttribute('aria-expanded', 'false');
  add.setAttribute('aria-expanded', 'false');
  const flyout = element('div', undefined, 'agent-composer-flyout');
  flyout.hidden = true;
  const categories = element('div', undefined, 'agent-composer-categories');
  const detail = element('div', undefined, 'agent-composer-detail');
  detail.hidden = true;
  let openedBy = add;
  const chips = element('div', undefined, 'agent-composer-chips');
  function openCategory(key) {
    detail.hidden = !key;
    const editingPrompt = key === 'instructions';
    categories.hidden = editingPrompt;
    flyout.classList.toggle('agent-composer-prompt', editingPrompt);
    settings.hidden = !editingPrompt;
    resources.hidden = key === 'instructions';
    for (const section of resources.querySelectorAll('[data-attachment]')) {
      section.hidden = section.dataset.attachment !== key;
    }
    for (const button of categories.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.category === key));
    }
    resources.dispatchEvent(new CustomEvent('openattachment', {
      detail:key === 'instructions' ? undefined : key
    }));
  }
  for (const [key, label, iconName] of [['skill', 'Skills', 'prompt'], ['mcp_connection', 'Connectors', 'external']]) {
    const category = iconButton(iconName, label, 'button quiet');
    category.type = 'button';
    category.dataset.category = key;
    category.append(element('span', '›', 'agent-category-arrow'));
    category.lastChild.setAttribute('aria-hidden', 'true');
    category.addEventListener('click', () => openCategory(key));
    categories.append(category);
  }
  function togglePicker(open, category) {
    flyout.hidden = !open;
    const editingPrompt = open && category === 'instructions';
    add.setAttribute('aria-expanded', String(open && !editingPrompt));
    prompt.setAttribute('aria-expanded', String(editingPrompt));
    if (open) {
      openedBy = editingPrompt ? prompt : add;
      openCategory(category);
      if (editingPrompt) instructions.querySelector('textarea').focus();
      else (categories.querySelector('[aria-pressed=true]') ?? categories.querySelector('button')).focus();
    }
  }
  add.addEventListener('click', () => togglePicker(flyout.hidden || openedBy !== add));
  prompt.addEventListener('click', () => togglePicker(flyout.hidden || openedBy !== prompt, 'instructions'));
  done.addEventListener('click', () => {
    togglePicker(false);
    prompt.focus();
  });
  picker.addEventListener('focusout', event => {
    if (event.relatedTarget && !picker.contains(event.relatedTarget)) togglePicker(false);
  });
  picker.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || flyout.hidden) return;
    event.stopPropagation();
    togglePicker(false);
    openedBy.focus();
  });
  detail.append(resources, settings);
  flyout.append(categories, detail);
  picker.append(add, prompt, flyout);

  const composer = element('form', undefined, 'agent-chat-composer');
  const message = element('textarea');
  message.rows = 3;
  message.required = true;
  message.placeholder = 'Send a test message…';
  message.setAttribute('aria-label', 'Test message');
  const send = iconButton('arrow', 'Send', 'button primary agent-chat-send');
  send.type = 'submit';
  const controls = element('div', undefined, 'agent-chat-controls');
  controls.append(picker, chips, modelField, send);
  const status = element('p', undefined, 'studio-run-notice');
  status.setAttribute('role', 'status');
  const hint = element('p', undefined, 'agent-chat-hint');
  const publishHint = element('p', undefined, 'agent-chat-hint agent-chat-publish-hint');
  publishHint.id = 'agent-chat-publish-hint';
  publish.setAttribute('aria-describedby', publishHint.id);
  composer.append(message, controls, status);
  root.append(header, publishHint, conversation, composer, hint);
  const value = (parent, selector) => parent.querySelector(selector).value;
  const configuration = () => ({name:value(name, 'input').trim() || 'Untitled Agent',
    instructions:value(instructions, 'textarea').trim() || 'Respond helpfully to the user.',
    description:saved?.description ?? '', starter:saved?.starter ?? '', max_tokens:saved?.max_tokens ?? null,
    provider:model.value, mcp_connection:value(resources, '[name=mcp_connection]'), skill:value(resources, '[name=skill]')});
  const signature = () => JSON.stringify(configuration());
  const update = () => {
    const currentSignature = signature();
    const dirty = savedConfiguration !== currentSignature;
    const tested = testedConfiguration === currentSignature;
    send.disabled = busy || !model.value || !message.value.trim();
    send.setAttribute('aria-label', pendingInput ? 'Sending…' : 'Send');
    send.title = pendingInput ? 'Sending…' : 'Send';
    save.disabled = busy || !model.value || !dirty;
    publish.disabled = busy || !tested;
    publish.hidden = !tested;
    reset.hidden = !turns.length;
    reset.disabled = busy;
    draftState.textContent = dirty ? 'Unsaved draft' : 'Draft saved';
    publishHint.textContent = testedConfiguration && !tested ? 'Configuration changed. Send a test to publish.' : '';
    hint.textContent = !turns.length && !pendingInput ? 'Enter to send · Shift + Enter for a new line' : '';
    const draft = configuration();
    prompt.classList.toggle('has-prompt', Boolean(value(instructions, 'textarea').trim()));
    const selections = [
      ['skill', draft.skill, ofKind('skill').find(item => item.id === draft.skill)?.name],
      ['mcp_connection', draft.mcp_connection, ofKind('mcp_connection').find(item => item.id === draft.mcp_connection) ??
        connectionCatalogue.find(item => item.id === draft.mcp_connection)]
    ];
    const selected = selections.filter(([, id]) => id);
    const labels = selected.map(([key, id, item]) => key === 'skill' ? item ?? id :
      item ? toolDisplayName(item) : id);
    if (JSON.stringify(labels) !== chips.dataset.labels) {
      chips.dataset.labels = JSON.stringify(labels);
      chips.replaceChildren(...selected.map(([key], index) => {
        const chip = element('button', labels[index], 'pill agent-composer-chip');
        chip.type = 'button';
        chip.addEventListener('click', () => togglePicker(true, key));
        return chip;
      }));
    }
  };
  function draw() {
    conversation.replaceChildren();
    for (const turn of turns) appendChatTurn(conversation, turn.input, turn.trace);
    if (pendingInput) conversation.append(element('p', pendingInput, 'agent-chat-user'),
      element('p', 'Waiting for a reply…', 'agent-chat-pending'));
  }
  async function persist(draft = configuration()) {
    const profile = await resolveDraftTool(draft);
    const result = saved
      ? await platformRequest('/agent-update', {...profile, agent:saved.id})
      : await platformRequest('/agents', {...profile, source:'studio'});
    saved = result;
    savedConfiguration = JSON.stringify(draft);
    records = [result, ...records.filter(item => item.id !== result.id)];
    showIdentity?.(result);
    return result;
  }
  reset.addEventListener('click', () => {
    overflow.open = false;
    turns.length = 0;
    testedConfiguration = undefined;
    status.textContent = '';
    draw();
    update();
    message.focus();
  });
  save.addEventListener('click', async () => {
    overflow.open = false;
    more.focus();
    busy = true;
    update();
    try {
      await persist();
      status.textContent = 'Draft saved.';
    } catch (error) {status.textContent = error.message;}
    finally {busy = false; update();}
  });
  publish.addEventListener('click', () => {
    if (publish.disabled) return;
    const tested = configuration();
    const destination = field('destination', 'Destination', [['api', 'API · Staging'], ['wecom', 'WeCom']]);
    destination.querySelector('select').value = 'api';
    const staging = saved && ofKind('agent_release').find(item => item.agent === saved.id && item.environment === 'staging');
    const details = element('p');
    const updateDetails = () => {
      details.textContent = destination.querySelector('select').value === 'api'
        ? (staging ? 'Replace the Staging API version with the configuration you just tested.' :
          'Publish the configuration you just tested to the Staging API.')
        : 'Save this draft and open the WeCom setup to choose a channel and release.';
    };
    destination.addEventListener('change', updateDetails);
    updateDetails();
    let version;
    const form = formPanel('Choose a destination', [destination, details], 'Publish to Staging', async data => {
      const updated = version ? saved : await persist(tested);
      if (data.destination === 'api') {
        version ??= await platformRequest('/agent-versions', {agent:updated.id,
          label:new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'});
        const release = await platformRequest('/agent-releases', {version:version.id, environment:'staging',
          ...(staging ? {expected_release:staging.id} : {only_if_unpublished:true})});
        if (release.version !== version.id) throw new Error('Staging changed. Reopen this Agent before publishing.');
        records = [release, version, ...records.filter(item => item.id !== release.id && item.id !== version.id)];
        const chat = element('button', 'Open Staging chat', 'button primary');
        chat.addEventListener('click', () => {
          byId('modal').close();
          loadModule('gallery-chat', {id:updated.id, environment:'staging'});
        });
        const api = element('button', 'API details', 'button quiet');
        api.addEventListener('click', () => openAgentUsage(updated, true));
        const actions = element('div', undefined, 'section-actions');
        actions.append(chat, api);
        openModal('Published to Staging', [element('p', updated.name + ' is ready to use in Gallery.'), actions]);
        chat.focus();
      } else {
        byId('modal').close();
        await openAgentDetail(updated.id, 'publish');
        platformContent.querySelector('.wecom-publishing')?.scrollIntoView();
      }
    });
    const submit = form.querySelector('button[type=submit]');
    destination.addEventListener('change', () => {
      submit.textContent = destination.querySelector('select').value === 'api' ? 'Publish to Staging' : 'Set up WeCom';
    });
    openModal('Publish draft', [form]);
  });
  name.addEventListener('input', update);
  composer.addEventListener('input', update);
  composer.addEventListener('change', update);
  resources.addEventListener('click', () => queueMicrotask(update));
  root.addEventListener('click', event => {
    if (!flyout.hidden && !picker.contains(event.target) && !chips.contains(event.target)) togglePicker(false);
  });
  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) composer.requestSubmit();
    }
  });
  composer.addEventListener('submit', async event => {
    event.preventDefault();
    if (send.disabled) return;
    const input = message.value.trim();
    togglePicker(false);
    const submitted = signature();
    const draft = configuration();
    busy = true;
    pendingInput = input;
    message.value = '';
    status.textContent = '';
    draw();
    update();
    message.focus();
    conversation.lastElementChild?.scrollIntoView({block:'nearest'});
    try {
      const history = recentChatMessages(turns);
      const trace = await platformRequest('/runs', {target_kind:'agent', target:saved?.id,
        draft:await resolveDraftTool(draft), input, history});
      turns.push({input, trace});
      if (!trace.error && trace.status === 'success') testedConfiguration = submitted;
    } catch (error) {
      if (!message.value) message.value = input;
      status.textContent = error.message;
    } finally {
      pendingInput = undefined;
      busy = false;
      draw();
      update();
      conversation.lastElementChild?.scrollIntoView({block:'nearest'});
    }
  });
  if (agent) savedConfiguration = signature();
  update();
  return root;
}

function agentDraftComposer(fields) {
  const request = field('request', fields ? 'What would you like to change?' : 'What should your Agent do?', 'textarea');
  const input = request.querySelector('textarea');
  input.maxLength = 2000;
  input.placeholder = fields ? 'Make the replies shorter and always link to the source…'
    : 'Build an assistant that answers questions about our project…';
  const panel = formPanel(fields ? 'Revise with a message' : 'Describe an Agent', [request,
    element('small', 'Draft requests use Hosted DeepSeek and your account balance.')
  ], 'Generate draft', async data => {
    const read = name => fields.querySelector('[name=' + name + ']').value;
    const current = fields && read('name').trim() && read('instructions').trim()
      ? Object.fromEntries(['name', 'description', 'instructions', 'starter'].map(name => [name, read(name)])) : undefined;
    const proposal = await platformRequest('/agent-draft', {request:data.request, current});
    if (!panel.isConnected) return;
    const result = element('div', undefined, 'draft-proposal');
    result.append(element('strong', proposal.name), element('p', proposal.description),
      element('pre', proposal.instructions));
    if (proposal.starter) result.append(element('p', proposal.starter));
    const apply = element('button', fields ? 'Apply to form' : 'Review configuration', 'button primary');
    apply.type = 'button';
    apply.addEventListener('click', () => {
      if (fields) {
        for (const name of ['name', 'description', 'instructions', 'starter']) {
          fields.querySelector('[name=' + name + ']').value = proposal[name] ?? '';
        }
        result.replaceChildren(element('p', 'Applied to the form. Review and save your changes.'));
      } else panel.replaceWith(agentConfigurationPage(proposal, undefined, true));
    });
    result.append(apply);
    panel.querySelector('.draft-proposal')?.remove();
    panel.append(result);
  });
  panel.classList.add('agent-draft-composer', 'wide');
  if (!hostedModelAvailable || !accountStatus?.user) {
    input.disabled = true;
    panel.querySelector('[type=submit]').disabled = true;
    panel.querySelector('[role=status]').textContent = 'Draft generation requires signed-in Hosted DeepSeek access.';
  }
  return panel;
}

function agentConfigurationPage(agent, showIdentity, creating = false) {
  const choices = studioModels();
  if (agent.provider && !choices.some(([id]) => id === agent.provider)) choices.unshift([agent.provider, recordName(agent.provider)]);
  if (!agent.provider && choices.length && !creating) choices.unshift(['', 'Default model']);
  const fields = agentFields({...agent, provider:agent.provider ?? (creating ? choices[0]?.[0] : '')}, choices);
  const providerInput = fields.querySelector('select');
  if (!agent.provider && !creating) {
    providerInput.required = false;
    if (choices.length) providerInput.remove(0);
  }
  const panel = formPanel('Configure Agent', [fields], creating ? 'Create Agent' : 'Save changes', async data => {
    back.disabled = true;
    try {
      data = await resolveDraftTool(data);
      if (creating) {
        const created = await platformRequest('/agents', {...agentPayload(data), source:'studio'});
        if (panel.isConnected) await openAgentDetail(created.id, 'configure');
        return;
      }
      const updated = await platformRequest('/agent-update', {...agentPayload(data), agent:agent.id});
      records = records.map(record => record.id === updated.id ? updated : record);
      if (!panel.isConnected) return;
      showIdentity(updated);
      panel.replaceWith(agentConfigurationPage(updated, showIdentity));
      const status = platformContent.querySelector('.studio-config-footer [role=status]');
      status.textContent = 'Configuration saved.';
      status.focus();
    } finally {
      back.disabled = false;
    }
  });
  panel.className = 'agent-configuration wide';
  panel.firstElementChild.remove();
  const form = panel.querySelector('form');
  const back = element('button', creating ? 'Back to Studio' : 'Test Agent', 'button');
  back.type = 'button';
  back.addEventListener('click', () => creating ? loadModule('studio') : openAgentDetail(agent.id, 'studio'));
  const footer = element('div', undefined, 'studio-config-footer');
  const actions = element('div', undefined, 'section-actions');
  const status = form.querySelector('[role=status]');
  status.tabIndex = -1;
  actions.append(back, form.querySelector('[type=submit]'));
  footer.append(status, actions);
  form.append(footer);
  panel.prepend(agentDraftComposer(fields));
  return panel;
}

function studioWorkspace(targets, selectedTarget, agentDetail) {
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
  selector.hidden = Boolean(agentDetail);
  targetInput.value = selectedTarget ?? lastStudioTarget ?? targets[0].id;
  if (!targetInput.value) targetInput.value = targets[0].id;
  const model = element('span', undefined, 'studio-model');
  const configure = iconButton('settings', 'Configure', 'button');
  toolbar.append(selector, model, configure);
  const use = iconButton('terminal', 'Use Agent', 'button');
  if (!agentDetail && accountStatus?.user) toolbar.append(use);
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
  const balanceHint = element('span', 'Uses account balance', 'studio-run-context');
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
  let showLatest = Boolean(agentDetail);
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
  configure.addEventListener('click', () => openAgentDetail(current().id, 'configure'));

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
      details.addEventListener('click', () => openAgentDetail(agent.id, external ? 'integration' : 'configure'));
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
  if (['agent', 'agents', 'gallery', 'gallery-chat', 'studio', 'connections', 'skills'].includes(module)) showWorkspaceArea('home');
  else showWorkspaceArea('console');
  closeWorkspaceMenu();
  byId('tracing-content').hidden = true;
  platformContent.hidden = false;
  byId('crumb').textContent = modules[module][0];
  platformContent.replaceChildren(element('p', 'Loading…', 'loading'));
  document.querySelectorAll('.nav').forEach(button => {
    const active = ['agent', 'gallery-chat'].includes(module) ? 'current-agent' : module === 'agents' ? 'gallery' : module;
    const current = button.dataset.module === active;
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
    if (module === 'agent' || module === 'gallery-chat') {
      const agent = ofKind('agent').find(item => item.id === selectedTarget?.id && item.source !== 'external');
      if (agent) {
        currentAgentId = agent.id;
        try {sessionStorage.setItem(currentAgentKey, agent.id);}
        catch {}
      }
    }
    renderModule(module, selectedTarget);
  } catch (error) {
    if (currentRequest()) platformContent.replaceChildren(element('p', error.message));
  }
}

document.querySelectorAll('[data-module]').forEach(button => {
  button.addEventListener('click', () => button.dataset.module === 'current-agent'
    ? openCurrentAgent() : loadModule(button.dataset.module));
});

byId('connect').addEventListener('click', async () => {
  const button = byId('connect');
  button.disabled = true;
  try {
    records = await platformRequest();
    if (accountStatus?.user && studioModels().length) await loadModule('studio');
    else openCreateAgent();
  } catch (error) {
    openModal('New agent', [element('p', error.message)]);
  } finally {
    button.disabled = false;
  }
});
