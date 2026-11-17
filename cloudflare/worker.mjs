import { DurableObject } from 'cloudflare:workers';
import { cookie, cookieValue, emailConfigured, json, randomId as id, sessionCookie, sha256,
  smsConfigured, workspaceCookie, workspacePattern } from './accounts.mjs';
export { Accounts } from './accounts.mjs';

const environments = ['local', 'development', 'staging', 'production'];
class InputError extends Error {}

function publicRecord(record) {
  const {api_key, encrypted_key, ...visible} = record;
  return record.kind === 'model' ? {...visible, has_api_key:Boolean(api_key || encrypted_key)} : visible;
}

function requiredText(data, key) {
  const value = data[key];
  if (typeof value !== 'string' || !value.trim()) throw new InputError(key + ' is required');
  return value.trim();
}

async function encryptionKey(secret, purpose) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(purpose + ':' + secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(value, secret, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv},
    await encryptionKey(secret, purpose), new TextEncoder().encode(value)));
  let binary = String.fromCharCode(...iv);
  for (const byte of payload) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
}

async function unseal(token, secret, purpose) {
  try {
    const bytes = Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/')),
      char => char.charCodeAt(0));
    const payload = await crypto.subtle.decrypt({name:'AES-GCM', iv:bytes.slice(0, 12)},
      await encryptionKey(secret, purpose), bytes.slice(12));
    return new TextDecoder().decode(payload);
  } catch {
    return null;
  }
}

function allowedScope(path, method) {
  if (path === '/api/traces' && method === 'GET') return 'traces:read';
  if (path === '/api/traces' && method === 'POST') return 'traces:write';
  if (path === '/api/platform/runs' && method === 'POST') return 'agents:run';
  if (path === '/api/agents' && method === 'GET') return 'agents:run';
  return null;
}

export default {
  async fetch(request, env) {
    const {pathname, origin} = new URL(request.url);
    if (pathname === '/healthz' && request.method === 'GET') return json({status:'ok'});

    const guest = cookieValue(request, workspaceCookie);
    const session = cookieValue(request, sessionCookie);
    if (!pathname.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      if (pathname !== '/' || request.method !== 'GET' || !response.ok) return response;
      const page = new Response(response.body, response);
      page.headers.set('Cache-Control', 'private, no-store');
      if (!session && !workspacePattern.test(guest ?? '')) {
        page.headers.append('Set-Cookie', cookie(workspaceCookie, id(), 31536000));
      }
      return page;
    }

    const authorization = request.headers.get('Authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const ingestion = pathname === '/api/traces' && request.method === 'POST';
    const secret = env.AGENTOPS_INGEST_TOKEN;
    const accounts = env.ACCOUNTS.getByName('accounts');
    const accountRequest = action => {
      const url = 'https://accounts.internal/' + action;
      const internal = action === 'resolve' ? new Request(url) : new Request(url, request);
      internal.headers.delete('Cookie');
      internal.headers.delete('Authorization');
      internal.headers.set('X-AgentOps-Session', session ?? '');
      internal.headers.set('X-AgentOps-Guest', guest ?? '');
      internal.headers.set('X-AgentOps-Address', request.headers.get('CF-Connecting-IP') ?? '');
      return accounts.fetch(internal);
    };
    const isClaimed = async workspace => {
      const response = await accounts.fetch(new Request('https://accounts.internal/resolve',
        {headers:{'X-AgentOps-Guest':workspace}}));
      return (await response.json()).claimed;
    };

    if (request.method === 'POST' && (!token || pathname.startsWith('/api/auth/'))) {
      const source = request.headers.get('Origin');
      if ((source && source !== origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        return json({error:'Cross-origin write rejected'}, 403);
      }
    }
    if (pathname.startsWith('/api/auth/')) {
      const action = pathname.slice('/api/auth/'.length);
      if (action === 'status' && request.method === 'GET') {
        const {user, claimed} = await (await accountRequest('resolve')).json();
        const response = json({user, email_configured:emailConfigured(env), sms_configured:smsConfigured(env), required:env.REQUIRE_LOGIN === 'true'});
        if (!user && (session || claimed || !workspacePattern.test(guest ?? ''))) {
          response.headers.append('Set-Cookie', cookie(sessionCookie, '', 0));
          response.headers.append('Set-Cookie', cookie(workspaceCookie, id(), 31536000));
        }
        return response;
      }
      if (request.method !== 'POST' || !['send','verify','password','logout'].includes(action)) {
        return json({error:'Unknown auth endpoint'}, 404);
      }
      return accountRequest(action);
    }

    if (token) {
      if (!secret) return json({error:'API credentials are unavailable'}, 503);
      if (token.startsWith('aops_') && /^aops_[A-Za-z0-9_-]{80}$/.test(token)) {
        if (!allowedScope(pathname, request.method)) return json({error:'API key cannot use this endpoint'}, 403);
        const workspace = await unseal(token.slice(5), secret, 'agentops-api');
        if (workspacePattern.test(workspace ?? '')) {
          if (env.REQUIRE_LOGIN === 'true' && !await isClaimed(workspace)) {
            return json({error:'Sign in to activate this workspace key'}, 403);
          }
          return env.WORKSPACE.getByName('browser:' + workspace).fetch(request);
        }
      } else if (ingestion && /^[A-Za-z0-9_-]{80}$/.test(token) && env.REQUIRE_LOGIN !== 'true') {
        const workspace = await unseal(token, secret, 'agentops-ingest');
        if (workspacePattern.test(workspace ?? '')) {
          if (!await isClaimed(workspace)) return env.WORKSPACE.getByName('browser:' + workspace).fetch(request);
        }
      }
      return json({error:'Invalid API credential'}, 401);
    }

    const {user, workspace:accountWorkspace, claimed} = await (await accountRequest('resolve')).json();
    if (!user && (env.REQUIRE_LOGIN === 'true' || claimed)) return json({error:'Please sign in to continue'}, 401);
    const workspace = accountWorkspace ?? guest;
    if (!workspacePattern.test(workspace ?? '')) return json({error:'请打开智能体工坊以初始化工作区'}, 401);
    if (pathname === '/api/workspace' && request.method === 'GET') {
      if (user) return json({error:'Create a scoped key under API Keys'}, 403);
      if (!secret) return json({error:'Trace ingestion has not been configured'}, 503);
      return json({ingest_token:await seal(workspace, secret, 'agentops-ingest')});
    }
    const internal = new Request(request);
    internal.headers.set('X-AgentOps-Workspace', workspace);
    return env.WORKSPACE.getByName('browser:' + workspace).fetch(internal);
  }
};

export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT, payload TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS traces (payload TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL, prefix TEXT NOT NULL, scopes TEXT NOT NULL, created TEXT NOT NULL, last_used TEXT, revoked TEXT)');
  }

  rows(table) {
    return this.sql.exec('SELECT payload FROM ' + table + ' ORDER BY rowid DESC')
      .toArray().map(({payload}) => JSON.parse(payload));
  }

  save(kind, fields) {
    const record = {...fields, kind, id:id(), at:new Date().toISOString()};
    this.sql.exec('INSERT INTO records VALUES (?, ?, ?)', record.id, kind, JSON.stringify(record));
    return record;
  }

  async createApiKey(data, workspace) {
    const name = requiredText(data, 'name');
    if (name.length > 80) throw new InputError('Use a name of up to 80 characters');
    if (!Array.isArray(data.scopes) || !data.scopes.length ||
        data.scopes.some(scope => !['traces:read','traces:write','agents:run'].includes(scope))) {
      throw new InputError('Choose at least one valid scope');
    }
    if (!this.env.AGENTOPS_INGEST_TOKEN || !workspacePattern.test(workspace ?? '')) {
      throw new InputError('API key service is unavailable');
    }
    const token = 'aops_' + await seal(workspace, this.env.AGENTOPS_INGEST_TOKEN, 'agentops-api');
    const digest = await sha256(token);
    const scopes = [...new Set(data.scopes)];
    const key = {id:id(), name, prefix:token.slice(0, 14), scopes, created:new Date().toISOString()};
    this.sql.exec('INSERT INTO api_keys (id,digest,name,prefix,scopes,created) VALUES (?,?,?,?,?,?)',
      key.id, digest, key.name, key.prefix, JSON.stringify(scopes), key.created);
    return {...key, token};
  }

  async checkApiKey(token, scope) {
    const digest = await sha256(token);
    const key = this.sql.exec('SELECT scopes FROM api_keys WHERE digest=? AND revoked IS NULL', digest).toArray()[0];
    if (!key) return json({error:'API key is invalid or revoked'}, 401);
    if (!JSON.parse(key.scopes).includes(scope)) return json({error:'API key is missing the required permission'}, 403);
    this.sql.exec('UPDATE api_keys SET last_used=? WHERE digest=?', new Date().toISOString(), digest);
    return null;
  }

  saveTrace(fields) {
    const trace = {...fields, id:id(), at:new Date().toISOString()};
    this.sql.exec('INSERT INTO traces VALUES (?)', JSON.stringify(trace));
    return trace;
  }

  ingest(data) {
    const trace = {project:'default', status:'success', duration:0, tokens:0, cost:0, steps:[], ...data};
    trace.name = requiredText(trace, 'name');
    trace.project = requiredText(trace, 'project');
    if ('agent_id' in trace || 'environment' in trace) {
      trace.environment = requiredText(trace, 'environment').toLowerCase();
      if (!environments.includes(trace.environment)) throw new InputError('Invalid environment');
      const agent = this.rows('records').find(record => record.kind === 'agent' && record.identifier &&
        record.identifier === trace.agent_id);
      if (!agent) throw new InputError('Agent identifier was not found');
      trace.project = 'agent:' + agent.identifier;
    }
    if (!['success', 'error'].includes(trace.status)) throw new InputError('Invalid status');
    for (const key of ['duration', 'tokens', 'cost']) {
      if (!Number.isFinite(trace[key]) || trace[key] < 0) throw new InputError('Invalid ' + key);
    }
    if (!Array.isArray(trace.steps) || trace.steps.some(step => typeof step?.name !== 'string')) {
      throw new InputError('steps must contain objects with names');
    }
    return this.saveTrace(trace);
  }

  async execute(prompt, value, instructions, provider) {
    let content = value;
    if (instructions) {
      if (typeof value !== 'string' || !value.trim()) throw new InputError('Enter a message');
    } else {
      const variables = value && typeof value === 'object' && !Array.isArray(value) ? value : {input:value};
      content = prompt.template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
        if (!Object.hasOwn(variables, key)) throw new InputError('Missing prompt variable: ' + key);
        return typeof variables[key] === 'string' ? variables[key] : JSON.stringify(variables[key]);
      });
    }
    const model = provider?.model ?? this.env.TRACE_STUDIO_MODEL;
    if (!model) {
      if (instructions) throw new InputError('Configure a model service before running this agent');
      return {output:content, tokens:0};
    }
    const endpoint = provider?.url ?? this.env.TRACE_STUDIO_MODEL_URL;
    if (!endpoint) throw new InputError('Model URL is missing');
    const messages = [{role:'user', content}];
    if (instructions) messages.unshift({role:'system', content:instructions});
    const headers = {'Content-Type':'application/json'};
    const apiKey = provider?.encrypted_key
      ? await unseal(provider.encrypted_key, this.env.AGENTOPS_INGEST_TOKEN, 'agentops-model')
      : provider ? provider.api_key : this.env.TRACE_STUDIO_MODEL_KEY;
    if (provider?.encrypted_key && !apiKey) throw new InputError('Model key could not be decrypted');
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const adapter = endpoint === this.env.MODEL_ADAPTER_URL ? this.env.MODEL_ADAPTER : null;
      const request = new Request(endpoint, {
        method:'POST', headers, body:JSON.stringify({model, messages}),
        ...(adapter ? {} : {signal:controller.signal}), redirect:'manual'
      });
      const response = await (adapter ? adapter.fetch(request) : fetch(request));
      if (!response.ok) throw new InputError('Model service returned HTTP ' + response.status);
      const result = await response.json();
      const output = result.choices?.[0]?.message?.content;
      if (typeof output !== 'string') throw new Error();
      return {output, tokens:result.usage?.total_tokens ?? 0};
    } catch (error) {
      if (error instanceof InputError) throw error;
      console.error('Model request failed', error.name);
      throw new InputError('Could not read a response from the model service');
    } finally {
      clearTimeout(timeout);
    }
  }

  async action(action, data) {
    const records = this.rows('records');
    const find = (key, kind) => {
      const identifier = requiredText(data, key);
      const record = records.find(item => item.kind === kind && item.id === identifier);
      if (!record) throw new InputError(kind + ' was not found');
      return record;
    };
    if (action === 'models' || action === 'models-update') {
      const existing = action === 'models-update' ? find('provider', 'model') : null;
      const name = requiredText(data, 'name');
      const model = requiredText(data, 'model');
      const vendor = data.vendor ?? existing?.vendor ?? 'custom';
      if (!['custom','deepseek','bailian'].includes(vendor)) throw new InputError('Invalid model provider');
      let url;
      try { url = new URL(requiredText(data, 'url')); }
      catch { throw new InputError('Enter a valid HTTPS Chat Completions endpoint'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new InputError('Use an HTTPS endpoint without embedded credentials or a fragment');
      }
      if (vendor === 'deepseek' && url.hostname !== 'api.deepseek.com') throw new InputError('Use the official DeepSeek endpoint');
      if (vendor === 'bailian' && !/^(dashscope(-intl)?\.aliyuncs\.com|[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com)$/.test(url.hostname)) {
        throw new InputError('Use the Bailian endpoint for your API key’s region');
      }
      const supplied = typeof data.api_key === 'string' ? data.api_key.trim() : '';
      if (supplied.length > 1024 || /[\r\n]/.test(supplied)) throw new InputError('Invalid API key');
      if (existing && !supplied && new URL(existing.url).origin !== url.origin &&
          (existing.api_key || existing.encrypted_key)) throw new InputError('Enter a new API key when changing the endpoint host');
      if (supplied && !this.env.AGENTOPS_INGEST_TOKEN) throw new InputError('Model credential storage is unavailable');
      const oldKey = existing?.api_key;
      const encrypted_key = supplied || oldKey
        ? await seal(supplied || oldKey, this.env.AGENTOPS_INGEST_TOKEN, 'agentops-model')
        : existing?.encrypted_key;
      if (!encrypted_key && vendor !== 'custom') throw new InputError('Enter the provider API key');
      const fields = {name, model, vendor, url:url.href, encrypted_key};
      if (!existing) return publicRecord(this.save('model', fields));
      const updated = {...fields, kind:existing.kind, id:existing.id, at:existing.at, updated_at:new Date().toISOString()};
      this.sql.exec('UPDATE records SET payload=? WHERE id=?', JSON.stringify(updated), updated.id);
      return publicRecord(updated);
    }
    if (action === 'models-delete') {
      const model = find('provider', 'model');
      if (records.some(item => item.kind === 'agent' && item.provider === model.id)) {
        throw new InputError('Reassign agents using this model before removing it');
      }
      this.sql.exec('DELETE FROM records WHERE id=?', model.id);
      return {ok:true};
    }
    if (action === 'model-test') {
      const provider = find('provider', 'model');
      return this.execute(null, requiredText(data, 'message'), 'Reply briefly.', provider);
    }
    if (action === 'datasets') return this.save('dataset', {name:requiredText(data, 'name')});
    if (action === 'examples') {
      const dataset = find('dataset', 'dataset');
      if (!('input' in data) || !('expected' in data)) throw new InputError('input and expected are required');
      return this.save('example', {dataset:dataset.id, input:data.input, expected:data.expected});
    }
    if (action === 'prompts') return this.save('prompt', {
      name:requiredText(data, 'name'), template:requiredText(data, 'template')
    });
    if (action === 'agents') {
      const name = requiredText(data, 'name');
      const source = data.source ?? 'studio';
      if (!['studio', 'external'].includes(source)) throw new InputError('Invalid agent source');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
      const agent = {name, source, identifier:slug + '-' + id().slice(0, 12)};
      if (source === 'studio') {
        agent.instructions = requiredText(data, 'instructions');
        if (data.provider) agent.provider = find('provider', 'model').id;
        else if (!this.env.TRACE_STUDIO_MODEL) throw new InputError('Choose a model before creating the agent');
      }
      return this.save('agent', agent);
    }
    if (action === 'agent-model') {
      const agent = find('agent', 'agent');
      if (agent.source === 'external') throw new InputError('External agents do not use a Studio model');
      const updated = {...agent, provider:find('provider', 'model').id};
      this.sql.exec('UPDATE records SET payload=? WHERE id=?', JSON.stringify(updated), agent.id);
      return updated;
    }
    if (action === 'deployments') return this.save('deployment', {
      name:requiredText(data, 'name'), prompt:find('prompt', 'prompt').id
    });
    if (action === 'feedback') {
      const trace = requiredText(data, 'trace');
      if (!this.rows('traces').some(item => item.id === trace)) throw new InputError('Trace was not found');
      if (![0, 1].includes(data.score)) throw new InputError('Invalid score');
      return this.save('feedback', {trace, score:data.score, comment:requiredText(data, 'comment')});
    }
    if (action === 'playground') return this.execute(find('prompt', 'prompt'), data.input);
    if (action === 'experiments') {
      const name = requiredText(data, 'name');
      const prompt = find('prompt', 'prompt');
      const dataset = find('dataset', 'dataset');
      const examples = records.filter(item => item.kind === 'example' && item.dataset === dataset.id).reverse();
      if (!examples.length) throw new InputError('Add at least one example to the dataset');
      const results = [];
      for (const {input, expected} of examples) {
        try {
          const {output} = await this.execute(prompt, input);
          results.push({input, expected, output, passed:output === expected});
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          results.push({input, expected, error:error.message, passed:false});
        }
      }
      return this.save('experiment', {name, dataset:dataset.id, prompt:prompt.id, results});
    }
    if (action === 'runs') {
      const kind = data.target_kind;
      if (!['agent', 'deployment'].includes(kind)) throw new InputError('Invalid target kind');
      const target = find('target', kind);
      if (target.source === 'external') throw new InputError('External agents run in your application');
      const prompt = records.find(item => item.id === target.prompt);
      const provider = records.find(item => item.kind === 'model' && item.id === target.provider);
      const model = target.instructions || this.env.TRACE_STUDIO_MODEL;
      const step = {name:model ? 'generate' : 'render_prompt', type:model ? 'llm' : 'template', input:data.input};
      const start = performance.now();
      let tokens = 0;
      try {
        const result = await this.execute(prompt, data.input, target.instructions, provider);
        step.output = result.output;
        tokens = result.tokens;
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        step.error = error.message;
      }
      step.duration = performance.now() - start;
      const trace = {...step, name:target.name, project:kind + ':' + target.name,
        status:step.error ? 'error' : 'success', tokens, cost:0, steps:[step]};
      if (target.identifier) Object.assign(trace, {
        agent_id:target.identifier, environment:'local', project:'agent:' + target.identifier
      });
      return this.saveTrace(trace);
    }
    throw new InputError('Unknown action');
  }

  async fetch(request) {
    const {pathname} = new URL(request.url);
    const bearer = request.headers.get('Authorization') ?? '';
    if (bearer.startsWith('Bearer aops_')) {
      const scope = allowedScope(pathname, request.method);
      if (!scope) return json({error:'API key cannot use this endpoint'}, 403);
      const problem = await this.checkApiKey(bearer.slice(7), scope);
      if (problem) return problem;
    }
    if (request.method === 'GET') {
      if (pathname === '/api/keys') {
        const keys = this.sql.exec('SELECT id,name,prefix,scopes,created,last_used,revoked FROM api_keys ORDER BY created DESC').toArray();
        return json(keys.map(key => ({...key, scopes:JSON.parse(key.scopes)})));
      }
      if (pathname === '/api/agents') return json(this.rows('records').filter(record => record.kind === 'agent').map(
        ({id, identifier, name, source}) => ({id, identifier, name, source})
      ));
      if (pathname === '/api/traces') return json(this.rows('traces'));
      if (pathname === '/api/platform') return json(this.rows('records').map(publicRecord));
    }
    if (request.method === 'POST') {
      try {
        const reader = request.body?.getReader();
        if (!reader) throw new InputError('Expected a JSON object');
        const decoder = new TextDecoder('utf-8', {fatal:true});
        let size = 0;
        let body = '';
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_000_000) {
            await reader.cancel();
            return json({error:'Request body exceeds 1 MB'}, 413);
          }
          body += decoder.decode(value, {stream:true});
        }
        const data = JSON.parse(body + decoder.decode());
        if (!data || Array.isArray(data) || typeof data !== 'object') throw new InputError('Expected a JSON object');
        if (pathname === '/api/keys') return json(await this.createApiKey(data, request.headers.get('X-AgentOps-Workspace')), 201);
        if (pathname === '/api/keys/revoke') {
          const key = requiredText(data, 'id');
          const updated = this.sql.exec('UPDATE api_keys SET revoked=? WHERE id=? AND revoked IS NULL RETURNING id',
            new Date().toISOString(), key).toArray();
          if (!updated.length) return json({error:'Active API key was not found'}, 404);
          return json({ok:true});
        }
        if (pathname === '/api/traces') return json(this.ingest(data), 201);
        if (pathname.startsWith('/api/platform/')) return json(await this.action(pathname.slice(14), data), 201);
      } catch (error) {
        if (error instanceof InputError || error instanceof SyntaxError) return json({error:error.message}, 400);
        console.error('Workspace request failed', error.name);
        return json({error:'Workspace request failed'}, 500);
      }
    }
    return json({error:'Unknown endpoint'}, 404);
  }
}
