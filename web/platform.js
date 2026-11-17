const platformContent = byId('platform-content');
const modules = {
  keys: ['API Keys', 'Create scoped credentials for applications using this workspace.'],
  models: ['Models', 'Connect and test an OpenAI-compatible model for your agents.'],
  datasets: ['Datasets', 'Curate examples and reference outputs for evaluation.'],
  experiments: ['Experiments', 'Evaluate prompt versions against a dataset and compare scores.'],
  feedback: ['Review Queue', 'Score ingested traces and record reviewer feedback.'],
  prompts: ['Prompts', 'Save and reuse prompt template versions.'],
  playground: ['Playground', 'Test prompt versions with sample inputs.'],
  deployments: ['Deployments', 'Pin a prompt version to a local execution target.'],
  agents: ['All agents', 'Build an agent in Studio or connect one that runs in your application.'],
  studio: ['Studio', 'Run a local agent or deployment and inspect its trace.']
};
let activeModule;
let records = [];
let apiKeys = [];

const providerPresets = {
  deepseek: {label:'DeepSeek', url:'https://api.deepseek.com/chat/completions', model:'deepseek-v4-flash'},
  bailian: {label:'Alibaba Cloud Bailian · 北京', url:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model:'qwen-plus'},
  custom: {label:'Custom · OpenAI compatible', url:'', model:''}
};

async function keyRequest(path = '', data) {
  const response = await fetch('/api/keys' + path, data === undefined ? {cache:'no-store'} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'API key request failed');
  return result;
}

function modelForm(existing, onSave) {
  const vendor = field('vendor', 'Provider', Object.entries(providerPresets).map(([key, preset]) => [key, preset.label]));
  const select = vendor.querySelector('select');
  select.value = existing?.vendor ?? 'custom';
  const name = field('name', 'Name', 'text', existing?.name ?? '');
  const url = field('url', 'Chat Completions URL', 'url', existing?.url ?? '');
  const model = field('model', 'Model ID', 'text', existing?.model ?? '');
  const key = field('api_key', existing?.has_api_key ? 'API key (leave blank to keep current key)' : 'Provider API key', 'password');
  const nameInput = name.querySelector('input');
  const urlInput = url.querySelector('input');
  const modelInput = model.querySelector('input');
  const keyInput = key.querySelector('input');
  urlInput.placeholder = 'https://api.example.com/v1/chat/completions';
  keyInput.autocomplete = 'off';
  keyInput.required = !existing?.has_api_key && select.value !== 'custom';
  select.addEventListener('change', () => {
    const preset = providerPresets[select.value];
    urlInput.value = preset?.url ?? '';
    modelInput.value = preset?.model ?? '';
    if (!nameInput.value) nameInput.value = preset?.label ?? '';
    keyInput.required = !existing?.has_api_key && select.value !== 'custom';
  });
  return formPanel(existing ? 'Edit model connection' : 'Connect a model',
    [vendor, name, url, model, key], 'Save model', onSave);
}

const ofKind = kind => records.filter(record => record.kind === kind);
const recordName = id => records.find(record => record.id === id)?.name ?? id;
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
  const message = element('p');
  message.setAttribute('role', 'status');
  form.append(...fields, submit, message);
  form.addEventListener('submit', async event => {
    event.preventDefault();
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
  const [title, description] = modules[module];
  const heading = element('div', undefined, 'module-heading');
  heading.append(element('h1', title), element('p', description));
  const panels = [];
  const nameField = () => field('name', 'Name');
  const options = kind => ofKind(kind).map(item => [item.id, item.name]);
  const promptField = () => field('prompt', 'Prompt version', promptOptions());
  const inputField = () => field('input', 'Input JSON', 'textarea', '{"input":"Hello"}');

  if (module === 'models') {
    panels.push(modelForm(null, data => create(module, data)));
    if (ofKind('model').length) {
      panels.push(formPanel('Test connection', [
        field('provider', 'Model', options('model')), field('message', 'Message', 'textarea', 'Reply with OK.')
      ], 'Test model', async (data, section) => {
        section.querySelector('.module-result')?.remove();
        const result = await platformRequest('/model-test', data);
        section.append(element('pre', result.output, 'module-result'));
      }));
    }
    panels.push(listPanel('Connected models', ofKind('model').map(record => {
      const item = expandable(record.name + ' · ' + record.model, {
        provider:providerPresets[record.vendor ?? 'custom']?.label,
        endpoint:record.url, credential:record.has_api_key ? 'API key saved' : 'No API key'
      });
      if (location.protocol !== 'https:') return item;
      const actions = element('div', undefined, 'model-actions');
      const edit = element('button', 'Edit', 'button');
      edit.addEventListener('click', () => openModal(record.name, [
        modelForm(record, async data => {
          await platformRequest('/models-update', {...data, provider:record.id});
          byId('modal').close();
          await loadModule('models');
        })
      ]));
      const remove = element('button', 'Remove', 'button');
      const result = element('p');
      result.setAttribute('role', 'status');
      remove.addEventListener('click', async () => {
        if (!window.confirm('Remove the model connection “' + record.name + '”?')) return;
        remove.disabled = true;
        try {
          await platformRequest('/models-delete', {provider:record.id});
          await loadModule('models');
        } catch (error) {
          result.textContent = error.message;
          remove.disabled = false;
        }
      });
      actions.append(edit, remove);
      item.append(actions, result);
      return item;
    })));
  }

  if (module === 'keys') {
    const scopes = element('fieldset', undefined, 'key-scopes');
    scopes.append(element('legend', 'Permissions'));
    for (const [value, label] of [
      ['traces:read','Read traces'], ['traces:write','Send traces'], ['agents:run','List and run agents']
    ]) {
      const option = element('input');
      option.type = 'checkbox';
      option.value = value;
      const wrapper = element('label');
      wrapper.append(option, document.createTextNode(label));
      scopes.append(wrapper);
    }
    panels.push(formPanel('Create API key', [nameField(), scopes], 'Generate key', async data => {
      const requested = Array.from(scopes.querySelectorAll('input:checked'), input => input.value);
      const key = await keyRequest('', {name:data.name, scopes:requested});
      if (activeModule !== 'keys' || platformContent.hidden) return;
      await loadModule('keys');
      const value = element('pre', key.token);
      const copy = element('button', 'Copy API key', 'button primary');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(key.token); copy.textContent = 'Copied'; }
        catch { copy.textContent = 'Select and copy the key above'; }
      });
      openModal('API key created', [
        element('p', 'Copy this key now. It is displayed once.'), value, copy
      ]);
    }));
    panels.push(listPanel('Workspace keys', apiKeys.map(key => {
      const item = expandable(key.name + ' · ' + key.prefix + '… · ' + (key.revoked ? 'Revoked' : 'Active'), {
        permissions:key.scopes, created:key.created, last_used:key.last_used, revoked:key.revoked
      });
      if (key.revoked) return item;
      const revoke = element('button', 'Revoke key', 'button');
      const result = element('p');
      result.setAttribute('role', 'status');
      revoke.addEventListener('click', async () => {
        if (!window.confirm('Revoke “' + key.name + '”? Applications using it will lose access.')) return;
        revoke.disabled = true;
        try {
          await keyRequest('/revoke', {id:key.id});
          await loadModule('keys');
        } catch (error) {
          result.textContent = error.message;
          revoke.disabled = false;
        }
      });
      item.append(revoke, result);
      return item;
    })));
    panels.push(listPanel('Use the API', [
      element('p', 'Send an Authorization: Bearer header with your workspace API key.'),
      element('pre', 'GET /api/agents\nPOST /api/platform/runs\nGET /api/traces\nPOST /api/traces')
    ]));
  }

  if (module === 'datasets') {
    panels.push(formPanel('Create dataset', [nameField()], 'Create dataset', data => create(module, data)));
    if (ofKind('dataset').length) panels.push(formPanel('Add example', [
      field('dataset', 'Dataset', options('dataset')), inputField(),
      field('expected', 'Reference output JSON', 'textarea', '"Hello"')
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
    const available = traces.filter(trace => !trace.id.startsWith('demo-'));
    panels.push(formPanel('Record feedback', [
      field('trace', 'Trace', available.map(trace => [trace.id, trace.name + ' · ' + trace.project + ' · ' + trace.id.slice(0, 8)])),
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
    panels.push(formPanel('Register deployment', [nameField(), promptField()], 'Register',
      data => create(module, data)));
    panels.push(listPanel(title, ofKind('deployment').map(record =>
      expandable(record.name, {prompt: promptOptions().find(([id]) => id === record.prompt)?.[1], id:record.id}))));
  }

  if (module === 'agents') {
    if (ofKind('model').length) {
      panels.push(formPanel('Build in Studio', [
        nameField(), field('provider', 'Model', options('model')),
        field('instructions', 'Agent instructions', 'textarea')
      ], 'Create agent', async data => {
        const agent = await platformRequest('/agents', {...data, source:'studio'});
        if (!platformContent.hidden && activeModule === 'agents') await loadModule('studio', agent.id);
      }));
    } else {
      const connect = element('button', 'Connect a model', 'button primary module-result');
      connect.addEventListener('click', () => loadModule('models'));
      const section = element('section', undefined, 'panel module-panel');
      section.append(element('h2', 'Build in Studio'), element('p', 'Connect a model to create your first Studio agent.'), connect);
      panels.push(section);
    }
    panels.push(formPanel('Connect an external agent', [nameField()], 'Create external agent',
      data => create(module, {...data, source:'external'})));
    gridEntries(panelForAgents());
  }

  function gridEntries(panel) {
    panel.classList.add('wide');
    panels.push(panel);
  }

  function panelForAgents() {
    return listPanel('Agent registry', ofKind('agent').map(agent => {
      const item = element('details');
      item.append(element('summary', agent.name + ' · ' + (agent.source === 'external' ? 'External' : 'Studio')));
      if (agent.provider) item.append(element('p', 'Model · ' + recordName(agent.provider)));
      if (agent.identifier) {
        item.append(element('p', 'Identifier · ' + agent.identifier));
        const example = {
          agent_id:agent.identifier, environment:'local', name:'handle_request',
          input:{message:'Hello'}, output:{message:'Hi'}
        };
        item.append(element('p', 'POST /api/traces'), element('pre', JSON.stringify(example, null, 2)));
        if (location.protocol === 'https:') {
          const keys = element('button', 'Open API Keys', 'button');
          keys.addEventListener('click', () => loadModule('keys'));
          item.append(keys);
        }
      }
      if (agent.source !== 'external') {
        const open = element('button', 'Open in Studio', 'button');
        open.addEventListener('click', () => loadModule('studio', agent.id));
        item.append(open);
        if (location.protocol === 'https:' && ofKind('model').length) {
          const change = element('button', 'Change model', 'button');
          change.addEventListener('click', () => {
            const select = field('provider', 'Model', options('model'));
            select.querySelector('select').value = agent.provider ?? '';
            openModal(agent.name, [formPanel('Change model', [select], 'Save model', async data => {
              await platformRequest('/agent-model', {...data, agent:agent.id});
              byId('modal').close();
              await loadModule('agents');
            })]);
          });
          item.append(change);
        }
      }
      return item;
    }));
  }

  if (module === 'studio') {
    const targets = records.filter(record =>
      record.kind === 'deployment' || (record.kind === 'agent' && record.source !== 'external'));
    const targetField = field('target', 'Target', targets.map(record => [record.id, record.name + ' · ' + record.kind]));
    if (selectedTarget) targetField.querySelector('select').value = selectedTarget;
    const messageField = field('input', 'Message or input JSON', 'textarea', 'Hello');
    panels.push(formPanel('Run local target', [
      targetField, messageField
    ], 'Run in Studio', async (data, section) => {
      const target = targets.find(record => record.id === data.target);
      const input = target.instructions ? data.input : jsonInput(data.input);
      const trace = await platformRequest('/runs', {...data, target_kind:target.kind, input});
      section.querySelector('.module-result')?.remove();
      const inspect = element('button', 'Inspect trace', 'button module-result');
      inspect.addEventListener('click', () => showTrace(trace));
      section.append(inspect);
      showTrace(trace);
      await refresh();
    }));
  }

  const grid = element('div', undefined, 'module-grid');
  grid.append(...panels);
  platformContent.replaceChildren(heading, grid);
}

async function loadModule(module, selectedTarget) {
  activeModule = module;
  byId('tracing-content').hidden = true;
  platformContent.hidden = false;
  byId('crumb').textContent = modules[module][0];
  platformContent.replaceChildren(element('p', 'Loading…'));
  document.querySelectorAll('.nav').forEach(button => {
    button.classList.toggle('active', button.dataset.module === module);
    if (button.dataset.module === module) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  try {
    if (module === 'keys') {
      const next = await keyRequest();
      if (activeModule !== module || platformContent.hidden) return;
      apiKeys = next;
    } else {
      const next = await platformRequest();
      if (activeModule !== module || platformContent.hidden) return;
      records = next;
    }
    renderModule(module, selectedTarget);
  } catch (error) {
    if (activeModule === module) platformContent.replaceChildren(element('p', error.message));
  }
}

document.querySelectorAll('[data-module]').forEach(button => {
  button.addEventListener('click', () => loadModule(button.dataset.module));
});

byId('connect').addEventListener('click', () => loadModule('agents'));

loadModule('agents');
