import { DurableObject } from 'cloudflare:workers';
import { WeComGateway } from './wecom.mjs';
import { builtinSkills, builtinSkillById } from './builtin-skills.mjs';
import { Billing, BillingError, checkout, hostedModel, hostedProviderId, paymentWebhook } from './billing.mjs';
import { docsConnection, searchDocs, verifyDocsConnection } from './mcp.mjs';
import { githubConnection, readReadme, verifyReadmeConnection } from './github.mjs';
import { cookie, cookieValue, emailConfigured, json, randomId as id, sessionCookie, sha256,
  smsConfigured, workspaceCookie, workspacePattern } from './accounts.mjs';
export { Accounts } from './accounts.mjs';

const environments = ['local', 'development', 'staging', 'production'];
const wecomProvider = 'wecom-channel';
const wecomConnection = {name:'WeCom channel', tool:'read_wecom_channel_posts'};
const readOnlyConnections = new Map([
  ['cloudflare-docs', {details:docsConnection, verify:verifyDocsConnection, read:searchDocs}],
  ['github-agentops', {details:githubConnection, verify:verifyReadmeConnection, read:readReadme}],
  [wecomProvider, {details:wecomConnection}]
]);
const connectionProvider = connection => connection.provider ??
  (connection.tool === docsConnection.tool ? 'cloudflare-docs' : undefined);

const releaseEnvironments = ['staging', 'production'];
const chatPath = '/v1/chat/completions';
class InputError extends Error {}

function publicRecord(record) {
  const {api_key, encrypted_key, wecom_bot_id, ...visible} = record;
  return record.kind === 'model' ? {...visible, has_api_key:Boolean(api_key || encrypted_key)} : visible;
}

function requiredText(data, key) {
  const value = data[key];
  if (typeof value !== 'string' || !value.trim()) throw new InputError(key + ' is required');
  return value.trim();
}

function agentProfile(data) {
  const profile = {name:requiredText(data, 'name'), instructions:requiredText(data, 'instructions')};
  for (const [key, limit] of [['description', 240], ['starter', 1000]]) {
    const value = data[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw new InputError(key + ' exceeds ' + limit + ' characters');
    profile[key] = value.trim();
  }
  const limit = data.max_tokens;
  if (limit != null) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw new InputError('Output limit must be between 1 and 4096 tokens');
    profile.max_tokens = limit;
  }
  return profile;
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
  if (path === chatPath && method === 'POST') return 'models:invoke';
  if (path === '/api/traces' && method === 'GET') return 'traces:read';
  if (path === '/api/traces' && method === 'POST') return 'traces:write';
  if (path === '/api/platform/runs' && method === 'POST') return 'agents:run';
  if (path === '/api/agents' && method === 'GET') return 'agents:run';
  if ((path === '/api/agents' && method === 'POST') || (path === '/api/models' && method === 'GET')) return 'agents:create';
  return null;
}

export default {
  async fetch(request, env) {
    const {hostname, pathname, search, origin} = new URL(request.url);
    if (hostname === 'agentops.cloudmoro.com') {
      return Response.redirect('https://agentdeck.cloudmoro.com' + pathname + search, 308);
    }
    if (pathname === '/healthz' && request.method === 'GET') return json({status:'ok'});
    if (pathname === '/api/billing/stripe' && request.method === 'POST') return paymentWebhook(request, env);

    const guest = cookieValue(request, workspaceCookie);
    const session = cookieValue(request, sessionCookie);
    if (!pathname.startsWith('/api/') && pathname !== chatPath) {
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
      if (request.method !== 'POST' || !['login','send','verify','password','logout'].includes(action)) {
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
          if ((pathname === chatPath || env.REQUIRE_LOGIN === 'true') && !await isClaimed(workspace)) {
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

    if (pathname === chatPath) return json({error:'Supply an Agent Deck API key'}, 401);
    const {user, workspace:accountWorkspace, claimed} = await (await accountRequest('resolve')).json();
    if (pathname.startsWith('/api/billing') && !user) return json({error:'Please sign in to continue'}, 401);
    if (!user && (env.REQUIRE_LOGIN === 'true' || claimed)) return json({error:'Please sign in to continue'}, 401);
    const workspace = accountWorkspace ?? guest;
    if (!workspacePattern.test(workspace ?? '')) return json({error:'请打开 Agent Deck 以初始化工作区'}, 401);
    if (pathname === '/api/workspace' && request.method === 'GET') {
      if (user) return json({error:'Create a scoped key under API Keys'}, 403);
      if (!secret) return json({error:'Trace ingestion has not been configured'}, 503);
      return json({ingest_token:await seal(workspace, secret, 'agentops-ingest')});
    }
    const internal = new Request(request);
    internal.headers.set('X-AgentOps-Workspace', workspace);
    internal.headers.delete('X-AgentOps-Studio-Session');
    const source = request.headers.get('Origin');
    if (user && (!source || source === origin)) internal.headers.set('X-AgentOps-Studio-Session', '1');
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
    this.billing = new Billing(ctx.storage, env);
    this.wecom = new WeComGateway(ctx,
      token => unseal(token, env.AGENTOPS_INGEST_TOKEN, 'wecom-bot'),
      async (config, input, conversation) => {
        const session = conversation ? await sha256(JSON.stringify([ctx.id.toString(),
          config.botId, config.agent, config.environment, ...conversation])) : undefined;
        return this.action('runs', {target_kind:'agent_release',target:config.agent,
          environment:config.environment,input,history:[]}, true, {channel:'wecom', session_id:session});
      }, (traceId, delivery) => this.sql.exec(
        "UPDATE traces SET payload=json_set(payload,'$.delivery',?) WHERE json_extract(payload,'$.id')=?",
        delivery, traceId));
  }

  async alarm() {await this.wecom.alarm();}

  rows(table) {
    return this.sql.exec('SELECT payload FROM ' + table + ' ORDER BY rowid DESC')
      .toArray().map(({payload}) => JSON.parse(payload));
  }

  save(kind, fields) {
    const record = {...fields, kind, id:id(), at:new Date().toISOString()};
    this.sql.exec('INSERT INTO records VALUES (?, ?, ?)', record.id, kind, JSON.stringify(record));
    return record;
  }

  modelConfiguration(records, providerId) {
    if (providerId === hostedProviderId) {
      if (!this.env.DEEPSEEK_API_KEY) throw new InputError('Hosted DeepSeek is unavailable');
      return {model:hostedModel, url:'https://api.deepseek.com/chat/completions'};
    }
    const provider = records.find(item => item.kind === 'model' && item.id === providerId);
    if (providerId && !provider) throw new InputError('The model connection was removed');
    const model = provider?.model ?? this.env.TRACE_STUDIO_MODEL;
    const url = provider?.url ?? this.env.TRACE_STUDIO_MODEL_URL;
    if (!model || !url) throw new InputError('Configure a model before saving a version');
    return {model, url};
  }

  async verifyVersionModel(records, version) {
    const config = this.modelConfiguration(records, version.provider);
    if (await sha256(JSON.stringify(config)) !== version.model_digest) {
      throw new InputError('The saved model connection changed. Restore it or save a new version.');
    }
  }

  usesWeComConnection(records, agent) {
    return records.some(item => item.kind === 'mcp_connection' && item.id === agent.mcp_connection &&
      connectionProvider(item) === wecomProvider);
  }

  assignedReadTool(records, agent, input) {
    if (!agent.mcp_connection) return undefined;
    const connection = records.find(item => item.kind === 'mcp_connection' &&
      item.id === agent.mcp_connection && !item.revoked);
    const provider = connection && connectionProvider(connection);
    const tool = readOnlyConnections.get(provider);
    if (!tool || connection.tool !== tool.details.tool) throw new InputError('This Agent’s tool connection is no longer authorized');
    if (provider === 'cloudflare-docs' && (typeof input !== 'string' || !input.trim() || input.length > 400)) {
      throw new InputError('Cloudflare Documentation search requires a message of 1 to 400 characters');
    }
    return async () => {
      const current = this.rows('records').find(item => item.id === connection.id && !item.revoked);
      if (!current) throw new BillingError('Tool connection is no longer authorized', 403);
      try {
        if (provider === wecomProvider) {
          const start = performance.now();
          const result = await this.wecom.readTopicPosts(current.topic_id, current.wecom_bot_id);
          if (result.state !== 'ok') {
            throw new Error('WeCom connection changed or is unavailable');
          }
          const posts = result.posts.filter(post => !post?.is_recalled && typeof post?.content === 'string')
            .slice(0, 5).map(post => ({
              content:Array.from(post.content).slice(0, 400).join(''),
              ...(Number.isInteger(post.create_time) ? {created:post.create_time} : {})
            }));
          return {name:wecomConnection.tool, type:'tool', connection_id:current.id, connection_scope:current.name,
            input:{limit:5, recent_minutes:15}, output:{channel:current.name, posts}, duration:performance.now() - start};
        }
        return {...await tool.read(input.trim()), connection_id:connection.id,
          ...(tool.details.scope ? {connection_scope:tool.details.scope} : {})};
      } catch {
        throw new BillingError(tool.details.name + ' could not return a result', 502);
      }
    };
  }

  authorizeReadTool(records, data, agent) {
    if (!Object.hasOwn(data, 'mcp_connection')) return;
    if (!data.mcp_connection) {
      delete agent.mcp_connection;
      return;
    }
    if (agent.provider !== hostedProviderId) throw new InputError('This tool requires Hosted DeepSeek');
    const connection = records.find(item => item.kind === 'mcp_connection' &&
      item.id === data.mcp_connection && !item.revoked);
    if (!connection || readOnlyConnections.get(connectionProvider(connection))?.details.tool !== connection.tool) {
      throw new InputError('Choose an active read-only connection');
    }
    agent.mcp_connection = connection.id;
  }

  resolveSkill(records, agent) {
    if (!agent.skill) return undefined;
    const skill = builtinSkillById.get(agent.skill) ?? records.find(item => item.kind === 'skill' && item.id === agent.skill);
    if (!skill || agent.provider !== hostedProviderId) throw new InputError('Choose an installed Skill for Hosted DeepSeek');
    if (skill.requires) {
      const connection = records.find(item => item.kind === 'mcp_connection' &&
        item.id === agent.mcp_connection && !item.revoked);
      const provider = readOnlyConnections.get(skill.requires);
      if (!connection || !provider || connectionProvider(connection) !== skill.requires || connection.tool !== provider.details.tool) {
        throw new InputError('This Skill requires an authorized ' + (provider?.details.name ?? 'read-only') + ' connection');
      }
    }
    return skill;
  }

  applySkillSelection(records, data, agent) {
    if (Object.hasOwn(data, 'skill')) {
      if (data.skill) agent.skill = requiredText(data, 'skill');
      else delete agent.skill;
    }
    this.resolveSkill(records, agent);
  }

  async evaluateVersion(version, agent, examples, records, billingKey) {
    const provider = records.find(item => item.kind === 'model' && item.id === version.provider);
    const results = [];
    for (const example of examples) {
      try {
        const result = version.provider === hostedProviderId
          ? await this.billing.complete({model:hostedModel, max_tokens:version.max_tokens, messages:[
            {role:'system', content:version.instructions}, {role:'user', content:example.input}
          ]}, this.billableKey(billingKey), agent, {environment:'development', agent_version:version.id},
          this.assignedReadTool(records, version, example.input), this.resolveSkill(records, version))
          : await this.execute(null, example.input, version.instructions, provider, version.max_tokens);
        results.push({example:example.id, input:example.input, expected:example.expected, output:result.output,
          passed:typeof result.output === 'string' && (example.match === 'contains'
            ? result.output.includes(example.expected.trim()) : result.output.trim() === example.expected.trim()),
          ...(result.id ? {trace:result.id} : {}), ...(example.source_trace ? {source_trace:example.source_trace} : {})});
      } catch (error) {
        if (!(error instanceof InputError || error instanceof BillingError)) throw error;
        results.push({example:example.id, input:example.input, expected:example.expected, error:error.message, passed:false,
          ...(example.source_trace ? {source_trace:example.source_trace} : {})});
      }
    }
    return {version:version.id, passed:results.every(result => result.passed), results};
  }

  async createApiKey(data, workspace) {
    const name = requiredText(data, 'name');
    if (name.length > 80) throw new InputError('Use a name of up to 80 characters');
    if (!Array.isArray(data.scopes) || !data.scopes.length ||
        data.scopes.some(scope => !['traces:read','traces:write','agents:run','agents:create','models:invoke'].includes(scope))) {
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
    const key = this.sql.exec('SELECT id,scopes FROM api_keys WHERE digest=? AND revoked IS NULL', digest).toArray()[0];
    if (!key) return json({error:'API key is invalid or revoked'}, 401);
    if (!JSON.parse(key.scopes).includes(scope)) return json({error:'API key is missing the required permission'}, 403);
    this.sql.exec('UPDATE api_keys SET last_used=? WHERE digest=?', new Date().toISOString(), digest);
    return key.id;
  }

  saveTrace(fields) {
    const trace = {...fields, id:id(), at:new Date().toISOString()};
    this.sql.exec('INSERT INTO traces VALUES (?)', JSON.stringify(trace));
    return trace;
  }

  ingest(data) {
    const {cost_nanos, key_id, agent_version, agent_release, session_id, ...reported} = data;
    const trace = {project:'default', status:'success', duration:0, tokens:0, cost:0, steps:[], ...reported};
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

  async execute(prompt, value, instructions, provider, maxTokens, history = []) {
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
    const messages = [...history, {role:'user', content}];
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
        method:'POST', headers, body:JSON.stringify({model, messages, max_tokens:maxTokens}),
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

  async action(action, data, studioSession = false, channelAttribution) {
    const records = this.rows('records');
    const find = (key, kind) => {
      const identifier = requiredText(data, key);
      const record = records.find(item => item.kind === kind && item.id === identifier);
      if (!record) throw new InputError(kind + ' was not found');
      return record;
    };
    if (action === 'wecom-topic-probe' || action === 'wecom-topic-discover') {
      if (!studioSession) throw new BillingError('Sign in to check a WeCom channel', 403);
      const agent = find('agent', 'agent');
      const marker = requiredText(data, 'marker');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(marker)) throw new InputError('Enter an 8–64 character test marker');
      if (action === 'wecom-topic-discover') return this.wecom.discoverTopic(agent.id, marker);
      const topicId = requiredText(data, 'topic_id');
      if (new TextEncoder().encode(topicId).length > 128) {
        throw new InputError('Use a topic ID of up to 128 bytes');
      }
      return this.wecom.probeTopic(agent.id, topicId, marker);
    }
    if (action === 'wecom-connect' || action === 'wecom-disconnect') {
      if (!studioSession) throw new BillingError('Sign in to manage WeCom', 403);
      if (action === 'wecom-disconnect') return this.wecom.configure(null);
      const agent = find('agent', 'agent');
      if (agent.source === 'external' || !releaseEnvironments.includes(data.environment) ||
          !records.some(item => item.kind === 'agent_release' && item.agent === agent.id && item.environment === data.environment)) {
        throw new InputError('Choose a published Agent environment');
      }
      const botId = requiredText(data, 'bot_id');
      const secret = requiredText(data, 'secret');
      if (botId.length > 256 || secret.length > 512 || !this.env.AGENTOPS_INGEST_TOKEN) {
        throw new InputError('Could not save Bot ID and Secret');
      }
      return this.wecom.configure({agent:agent.id,environment:data.environment,botId,
        secret:await seal(secret, this.env.AGENTOPS_INGEST_TOKEN, 'wecom-bot')});
    }
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
      const message = requiredText(data, 'message');
      const checkedAt = new Date().toISOString();
      const start = performance.now();
      let status = 'failed';
      try {
        const result = await this.execute(null, message, 'Reply briefly.', provider);
        status = 'ready';
        return {...result, duration:performance.now() - start};
      } finally {
        const row = this.sql.exec('SELECT payload FROM records WHERE id=? AND kind=?', provider.id, 'model').toArray()[0];
        const current = row && JSON.parse(row.payload);
        if (current && current.updated_at === provider.updated_at && (!current.check || current.check.at <= checkedAt)) {
          current.check = {status, at:checkedAt, duration:performance.now() - start};
          this.sql.exec('UPDATE records SET payload=? WHERE id=?', JSON.stringify(current), provider.id);
        }
      }
    }
    if (action === 'skills') {
      const name = requiredText(data, 'name');
      const instructions = requiredText(data, 'instructions');
      const requires = data.requires === undefined ? 'github-agentops' : data.requires;
      if (requires !== null && !readOnlyConnections.has(requires)) throw new InputError('Unknown required connection');
      if (name.length > 80 || instructions.length > 16000) throw new InputError('Use a name up to 80 characters and instructions up to 16000');
      return this.save('skill', {name, instructions, requires});
    }
    if (action === 'mcp-connect') {
      const provider = readOnlyConnections.get(data.provider);
      if (!provider) throw new InputError('Unknown tool connection');
      if (data.provider === wecomProvider) {
        if (!studioSession) throw new BillingError('Sign in to connect a WeCom channel', 403);
        const topicId = requiredText(data, 'topic_id');
        const name = requiredText(data, 'name');
        if (new TextEncoder().encode(topicId).length > 128 || name.length > 80) {
          throw new InputError('Use a channel name up to 80 characters and a topic ID up to 128 bytes');
        }
        const result = await this.wecom.readTopicPosts(topicId);
        if (result.state !== 'ok') throw new BillingError(result.state === 'rejected'
          ? 'WeCom rejected the channel read (code ' + result.code + ')'
          : 'Could not verify channel read access. Check the connected bot and topic ID.', 502);
        const existing = this.rows('records').find(item => item.kind === 'mcp_connection' &&
          item.provider === wecomProvider && !item.revoked);
        if (existing && (existing.topic_id !== topicId || existing.wecom_bot_id !== result.botId)) {
          throw new InputError('Disconnect the current WeCom channel before connecting another one');
        }
        return publicRecord(existing ?? this.save('mcp_connection', {...wecomConnection, name, topic_id:topicId,
          provider:wecomProvider, wecom_bot_id:result.botId}));
      }
      const matches = item => item.kind === 'mcp_connection' && !item.revoked && connectionProvider(item) === data.provider;
      const existing = records.find(matches);
      if (existing) return existing;
      try { await provider.verify(); }
      catch { throw new BillingError('Could not verify ' + provider.details.name, 502); }
      return this.rows('records').find(matches) ??
        this.save('mcp_connection', {...provider.details, provider:data.provider});
    }
    if (action === 'mcp-disconnect') {
      const connection = find('connection', 'mcp_connection');
      if (connection.provider === wecomProvider && !studioSession) {
        throw new BillingError('Sign in to manage WeCom connections', 403);
      }
      const revoked = {...connection, revoked:new Date().toISOString()};
      this.sql.exec('UPDATE records SET payload=? WHERE id=?', JSON.stringify(revoked), revoked.id);
      return publicRecord(revoked);
    }
    if (action === 'datasets') return this.save('dataset', {name:requiredText(data, 'name')});
    if (action === 'examples') {
      const dataset = find('dataset', 'dataset');
      if (!('input' in data) || !('expected' in data)) throw new InputError('input and expected are required');
      const example = {dataset:dataset.id, input:data.input, expected:data.expected};
      if (data.source_trace !== undefined) {
        const trace = this.rows('traces').find(item => item.id === data.source_trace);
        if (!trace) throw new InputError('Trace was not found');
        example.source_trace = trace.id;
      }
      if (data.match === 'contains') {
        if (typeof data.expected !== 'string' || !data.expected.trim()) {
          throw new InputError('Enter the required text');
        }
        example.match = 'contains';
      }
      return this.save('example', example);
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
        Object.assign(agent, agentProfile(data));
        if (data.provider === hostedProviderId && this.env.DEEPSEEK_API_KEY) agent.provider = hostedProviderId;
        else if (data.provider) agent.provider = find('provider', 'model').id;
        else if (!this.env.TRACE_STUDIO_MODEL) throw new InputError('Choose a model before creating the agent');
        this.authorizeReadTool(records, data, agent);
        this.applySkillSelection(records, data, agent);
      }
      return this.save('agent', agent);
    }
    if (action === 'agent-model' || action === 'agent-update') {
      const agent = find('agent', 'agent');
      if (agent.source === 'external') throw new InputError('External agents do not use a Studio model');
      let provider = agent.provider;
      if (action === 'agent-model' || (data.provider && data.provider !== agent.provider)) {
        provider = data.provider === hostedProviderId && this.env.DEEPSEEK_API_KEY
          ? hostedProviderId : find('provider', 'model').id;
      }
      const updated = {...agent, provider};
      if (action === 'agent-update') {
        delete updated.max_tokens;
        Object.assign(updated, agentProfile(data));
        this.authorizeReadTool(records, data, updated);
        this.applySkillSelection(records, data, updated);
      }
      if (provider !== hostedProviderId) {
        delete updated.mcp_connection;
        delete updated.skill;
      }
      this.sql.exec('UPDATE records SET payload=? WHERE id=?', JSON.stringify(updated), agent.id);
      return updated;
    }
    if (action === 'agent-versions') {
      const agent = find('agent', 'agent');
      if (agent.source === 'external') throw new InputError('External agents are versioned in your application');
      const label = requiredText(data, 'label');
      if (label.length > 80) throw new InputError('Use a version label of up to 80 characters');
      const {name, instructions, description, starter, max_tokens, provider, mcp_connection, skill} = agent;
      this.resolveSkill(records, agent);
      const config = this.modelConfiguration(records, provider);
      const model_digest = await sha256(JSON.stringify(config));
      return this.save('agent_version', {agent:agent.id, label, name, instructions, description, starter,
        max_tokens, provider, mcp_connection, skill, model:config.model, model_digest});
    }
    if (action === 'agent-releases') {
      const version = find('version', 'agent_version');
      if (this.usesWeComConnection(records, version)) {
        throw new InputError('Versions with a WeCom channel connection are for Studio only');
      }
      if (!releaseEnvironments.includes(data.environment)) throw new InputError('Choose staging or production');
      const agent = records.find(item => item.kind === 'agent' && item.id === version.agent);
      if (!agent || agent.source === 'external') throw new InputError('Studio agent was not found');
      await this.verifyVersionModel(records, version);
      const latest = this.rows('records');
      const current = latest.find(item => item.kind === 'agent_release' && item.agent === agent.id &&
        item.environment === data.environment);
      if (data.only_if_unpublished === true && current) return current;
      if (data.expected_release && current?.id !== data.expected_release) throw new InputError('This release changed. Refresh before rolling back.');
      if (current?.version === version.id) return current;
      const comparison = latest.find(item => item.kind === 'agent_evaluation' &&
        item.variants.some(variant => variant.version === version.id));
      const passed = comparison?.variants.find(variant => variant.version === version.id)?.passed;
      const rollback = data.expected_release === current?.id && current?.previous === version.id;
      if (data.environment === 'production' && !rollback && !passed) {
        throw new InputError('This version must pass its latest Agent evaluation before production release');
      }
      return this.save('agent_release', {agent:agent.id, version:version.id,
        environment:data.environment, previous:current?.version,
        ...(data.environment === 'production' && passed ? {evaluation:comparison.id} : {})});
    }
    if (action === 'agent-evaluations') {
      const baseline = find('baseline', 'agent_version');
      const candidate = find('candidate', 'agent_version');
      if (!studioSession && [baseline, candidate].some(version => this.usesWeComConnection(records, version))) {
        throw new BillingError('Sign in to evaluate a WeCom channel connection', 403);
      }
      if (baseline.id === candidate.id || baseline.agent !== candidate.agent) {
        throw new InputError('Choose two different versions of the same Agent');
      }
      const agent = records.find(item => item.kind === 'agent' && item.id === candidate.agent);
      if (!agent) throw new InputError('Agent was not found');
      const dataset = find('dataset', 'dataset');
      const examples = records.filter(item => item.kind === 'example' && item.dataset === dataset.id).reverse();
      if (!examples.length || examples.length > 5 || examples.some(item => typeof item.input !== 'string' ||
        !item.input.trim() || typeof item.expected !== 'string' || !item.expected.trim())) {
        throw new InputError('Use a dataset with one to five non-empty text inputs and expected replies');
      }
      await Promise.all([this.verifyVersionModel(records, baseline), this.verifyVersionModel(records, candidate)]);
      if ([baseline, candidate].some(version => version.provider === hostedProviderId)) this.billableKey(data.billing_key);
      const variants = [];
      for (const version of [baseline, candidate]) {
        variants.push(await this.evaluateVersion(version, agent, examples, records, data.billing_key));
      }
      return this.save('agent_evaluation', {agent:agent.id, dataset:dataset.id, variants});
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
      if (!['agent', 'deployment', 'agent_release'].includes(kind)) throw new InputError('Invalid target kind');
      const agent = find('target', kind === 'agent_release' ? 'agent' : kind);
      let target = agent;
      let release;
      if (kind === 'agent_release') {
        if (!releaseEnvironments.includes(data.environment)) throw new InputError('Choose staging or production');
        release = records.find(item => item.kind === 'agent_release' && item.agent === agent.id &&
          item.environment === data.environment);
        const version = release && records.find(item => item.kind === 'agent_version' && item.id === release.version);
        if (!version) throw new InputError('No version is published to this environment');
        await this.verifyVersionModel(records, version);
        target = {...version, id:agent.id, identifier:agent.identifier};
      }
      if (this.usesWeComConnection(records, target) && (!studioSession || kind !== 'agent' || channelAttribution)) {
        throw new BillingError('Use a WeCom channel connection in signed-in Studio', 403);
      }
      const history = data.history === undefined ? [] : data.history;
      if (data.history !== undefined && (kind === 'deployment' || !Array.isArray(history) ||
        history.length > 12 || history.length % 2 || !history.every((message, index) =>
          message?.role === (index % 2 ? 'assistant' : 'user') && typeof message.content === 'string' &&
          (index % 2 || message.content.trim())) || new TextEncoder().encode(JSON.stringify(history)).length > 20_000)) {
        throw new InputError('Use up to six complete user and assistant turns in history');
      }
      const previousMessages = history.map(({role, content}) => ({role, content}));
      const attribution = release ? {environment:release.environment, agent_version:release.version,
        agent_release:release.id} : {environment:'local'};
      Object.assign(attribution, channelAttribution);
      if (target.source === 'external') throw new InputError('External agents run in your application');
      if (target.provider === hostedProviderId) {
        if (typeof data.input !== 'string' || !data.input.trim()) throw new InputError('Enter a test message');
        const billingKey = studioSession && (kind === 'agent' || data.history !== undefined) && data.billing_key == null
          ? null : this.billableKey(data.billing_key);
        return this.billing.complete({model:hostedModel, messages:[
          {role:'system', content:target.instructions}, ...previousMessages, {role:'user', content:data.input}
        ], max_tokens:target.max_tokens}, billingKey, target, attribution,
        this.assignedReadTool(records, target, data.input), this.resolveSkill(records, target));
      }
      const prompt = records.find(item => item.id === target.prompt);
      const provider = records.find(item => item.kind === 'model' && item.id === target.provider);
      const model = provider?.model ?? this.env.TRACE_STUDIO_MODEL;
      const step = {name:model ? 'generate' : 'render_prompt', type:model ? 'llm' : 'template', input:data.input};
      if (model) step.model = model;
      const start = performance.now();
      let tokens = 0;
      try {
        const result = await this.execute(prompt, data.input, target.instructions, provider, target.max_tokens, previousMessages);
        step.output = result.output;
        tokens = result.tokens;
        if (model) step.tokens = tokens;
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        step.error = error.message;
      }
      step.duration = performance.now() - start;
      const trace = {...step, name:target.name, target_id:target.id, project:kind + ':' + target.name,
        status:step.error ? 'error' : 'success', tokens, cost:0, steps:[step]};
      if (target.identifier) Object.assign(trace, {
        agent_id:target.identifier, project:'agent:' + target.identifier, ...attribution
      });
      return this.saveTrace(trace);
    }
    throw new InputError('Unknown action');
  }

  billableKey(id) {
    const key = this.sql.exec('SELECT scopes FROM api_keys WHERE id=? AND revoked IS NULL', typeof id === 'string' ? id : '').toArray()[0];
    if (!key || !JSON.parse(key.scopes).includes('models:invoke')) throw new BillingError('Choose an active key with hosted model access', 403);
    return id;
  }

  async fetch(request) {
    const {hostname, pathname, origin} = new URL(request.url);
    if (hostname === 'billing.internal' && pathname === '/stripe-credit' && request.method === 'POST') {
      const {reference, cents} = await request.json();
      this.billing.credit(reference, cents);
      return json({ok:true});
    }
    const bearer = request.headers.get('Authorization') ?? '';
    let keyId;
    if (bearer.startsWith('Bearer aops_')) {
      const scope = allowedScope(pathname, request.method);
      if (!scope) return json({error:'API key cannot use this endpoint'}, 403);
      const result = await this.checkApiKey(bearer.slice(7), scope);
      if (result instanceof Response) return result;
      keyId = result;
    }
    if (request.method === 'GET') {
      if (pathname === '/api/keys') {
        const keys = this.sql.exec(`SELECT k.id,k.name,k.prefix,k.scopes,k.created,k.last_used,k.revoked,
          COALESCE(usage.requests,0) AS requests, COALESCE(usage.tokens,0) AS tokens, COALESCE(usage.spend_nanos,0) AS spend_nanos
          FROM api_keys k LEFT JOIN (SELECT key_id, COUNT(*) AS requests, SUM(input_tokens+output_tokens) AS tokens,
          -SUM(nanos) AS spend_nanos FROM billing_ledger WHERE key_id IS NOT NULL GROUP BY key_id) usage
          ON usage.key_id=k.id ORDER BY k.created DESC`).toArray();
        return json(keys.map(key => ({...key, scopes:JSON.parse(key.scopes)})));
      }
      if (pathname === '/api/platform/wecom-status') {
        if (request.headers.get('X-AgentOps-Studio-Session') !== '1') return json({error:'Please sign in'}, 403);
        return json(await this.wecom.getStatus());
      }
      if (pathname === '/api/billing') return json(this.billing.summary());
      if (pathname === '/api/models') return json([
        ...(this.env.DEEPSEEK_API_KEY ? [{id:hostedProviderId, name:'DeepSeek Flash · Hosted'}] : []),
        ...this.rows('records').filter(record => record.kind === 'model').map(({id, name}) => ({id, name})),
        ...(this.env.TRACE_STUDIO_MODEL ? [{id:'default', name:'Workspace default'}] : [])
      ]);
      if (pathname === '/api/agents') return json(this.rows('records').filter(record => record.kind === 'agent').map(
        ({id, identifier, name, source}) => ({id, identifier, name, source})
      ));
      if (pathname === '/api/traces') return json(this.rows('traces'));
      if (pathname === '/api/platform') return json([...this.rows('records').map(publicRecord), ...builtinSkills], 200, {
        'X-Agent-Deck-Hosted-Model': this.env.DEEPSEEK_API_KEY ? 'available' : 'unavailable'
      });
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
        if (pathname === chatPath) {
          if (!keyId) return json({error:'Supply an Agent Deck API key'}, 401);
          return json(await this.billing.complete(data, this.billableKey(keyId)));
        }
        if (pathname === '/api/billing/checkout') {
          return json(await checkout(this.env, request.headers.get('X-AgentOps-Workspace'), data.cents, origin), 201);
        }
        if (pathname === '/api/keys') return json(await this.createApiKey(data, request.headers.get('X-AgentOps-Workspace')), 201);
        if (pathname === '/api/keys/revoke') {
          const key = requiredText(data, 'id');
          const updated = this.sql.exec('UPDATE api_keys SET revoked=? WHERE id=? AND revoked IS NULL RETURNING id',
            new Date().toISOString(), key).toArray();
          if (!updated.length) return json({error:'Active API key was not found'}, 404);
          return json({ok:true});
        }
        if (pathname === '/api/traces') return json(this.ingest(data), 201);
        if (pathname === '/api/agents') {
          const {name, source, provider, instructions, description, starter, max_tokens} = data;
          return json(await this.action('agents', {name, source, provider, instructions, description, starter, max_tokens}), 201);
        }
        if (pathname.startsWith('/api/platform/')) {
          if (keyId && pathname === '/api/platform/runs') {
            if (data.billing_key && data.billing_key !== keyId) return json({error:'Use the calling key for billing'}, 403);
            data.billing_key = keyId;
          }
          const studioSession = !keyId && request.headers.get('X-AgentOps-Studio-Session') === '1';
          return json(await this.action(pathname.slice(14), data, studioSession), 201);
        }
      } catch (error) {
        if (error instanceof BillingError) return json({error:error.message}, error.status);
        if (error instanceof InputError || error instanceof SyntaxError) return json({error:error.message}, 400);
        console.error('Workspace request failed', error.name);
        return json({error:'Workspace request failed'}, 500);
      }
    }
    return json({error:'Unknown endpoint'}, 404);
  }
}
