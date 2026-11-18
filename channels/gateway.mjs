import { createHash, createDecipheriv, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const agent = requireEnv('AGENT_DECK_AGENT_ID');
const agentKey = requireEnv('AGENT_DECK_API_KEY');
const environment = requireEnv('AGENT_DECK_ENVIRONMENT');
if (!['staging', 'production'].includes(environment)) throw new Error('Select staging or production.');
const mode = process.argv[2];
if (mode === 'wecom') await startWeCom();
else if (mode === 'wechat-kf') startCustomerService();
else throw new Error('Use wecom or wechat-kf.');

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Set ' + name);
  return value;
}

async function runAgent(text) {
  const response = await fetch('https://agentdeck.cloudmoro.com/api/platform/runs', {
    method:'POST', signal:AbortSignal.timeout(45_000), redirect:'error',
    headers:{Authorization:'Bearer ' + agentKey, 'Content-Type':'application/json'},
    body:JSON.stringify({target_kind:'agent_release',target:agent,environment,input:text})
  });
  const result = await response.json();
  if (!response.ok || result.status === 'error' || typeof result.output !== 'string') {
    throw new Error('Agent request failed (HTTP ' + response.status + ').');
  }
  console.info('Agent Trace:', result.id);
  return result.output.trim() || '暂时没有可发送的回复。';
}

function limitText(text, bytes) {
  if (Buffer.byteLength(text) <= bytes) return text;
  let output = '';
  let length = 0;
  for (const character of text) {
    length += Buffer.byteLength(character);
    if (length > bytes - 3) break;
    output += character;
  }
  return output + '…';
}

async function startWeCom() {
  const botId = requireEnv('WECOM_BOT_ID');
  const secret = requireEnv('WECOM_BOT_SECRET');
  const { WSClient } = await import('@wecom/aibot-node-sdk');
  const client = new WSClient({botId, secret, maxReconnectAttempts:-1, logger:{
    debug() {}, info() {}, warn() {console.warn('WeCom connection warning');},
    error() {console.error('WeCom connection error');}
  }});
  const seen = new Map();
  client.on('authenticated', () => console.info('WeCom bot authenticated.'));
  client.on('error', () => console.error('WeCom bot reported a connection error.'));
  client.on('message.text', async frame => {
    const text = frame.body?.text?.content;
    const key = frame.body?.msgid ?? frame.headers?.req_id;
    if (typeof text !== 'string' || !text.trim() || !key || seen.has(key)) return;
    seen.set(key, true);
    if (seen.size > 2048) seen.delete(seen.keys().next().value);
    const streamId = randomUUID();
    try {
      await client.replyStream(frame, streamId, '正在处理，请稍候…', false);
      let reply;
      try {reply = await runAgent(text);} catch (error) {
        console.error(error.message);
        reply = '暂时无法回复，请稍后重试。';
      }
      await client.replyStream(frame, streamId, limitText(reply, 12_000), true);
    } catch {
      console.error('WeCom reply could not be delivered.');
    }
  });
  client.connect();
}

function readXml(xml, name) {
  return new RegExp('<' + name + '>(?:<!\\[CDATA\\[([^]*?)\\]\\]>|([^<]*))</' + name + '>')
    .exec(xml)?.slice(1).find(value => value !== undefined)?.trim();
}

async function readCallback(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Callback too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function startCustomerService() {
  const corpId = requireEnv('WECHAT_KF_CORP_ID');
  const secret = requireEnv('WECHAT_KF_SECRET');
  const account = requireEnv('WECHAT_KF_OPEN_KFID');
  const token = requireEnv('WECHAT_KF_CALLBACK_TOKEN');
  const key = Buffer.from(requireEnv('WECHAT_KF_ENCODING_AES_KEY') + '=', 'base64');
  if (key.length !== 32) throw new Error('Invalid callback AES key.');
  const db = new DatabaseSync(process.env.WECHAT_KF_DB ?? 'wechat-kf.sqlite3');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS events (token TEXT PRIMARY KEY, received INTEGER, done INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, content TEXT, sent INTEGER DEFAULT 0)`);
  const read = name => db.prepare('SELECT value FROM settings WHERE name=?').get(name)?.value;
  const save = (name, value) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(name, value);
  if (read('account') && read('account') !== account) throw new Error('Use a separate DB per customer-service account.');
  save('account', account);
  if (!read('started')) save('started', String(Math.floor(Date.now() / 1000)));
  let cachedToken;
  let draining = false;

  function decrypt(encrypted, params) {
    const stamp = params.get('timestamp') ?? '';
    const nonce = params.get('nonce') ?? '';
    const signature = params.get('msg_signature') ?? '';
    if (!encrypted || !/^\d{1,12}$/.test(stamp) || !nonce || !/^[a-f0-9]{40}$/.test(signature) ||
        Math.abs(Date.now() / 1000 - Number(stamp)) > 300) throw new Error('Invalid callback.');
    const expected = createHash('sha1').update([token, stamp, nonce, encrypted].sort().join('')).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid signature.');
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const data = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]);
    const padding = data.at(-1);
    if (!padding || padding > 32 ||
        data.subarray(data.length - padding).some(byte => byte !== padding)) throw new Error('Invalid padding.');
    const end = data.length - padding;
    if (end < 20) throw new Error('Invalid callback body.');
    const messageEnd = 20 + data.readUInt32BE(16);
    if (messageEnd > end || data.toString('utf8', messageEnd, end) !== corpId) throw new Error('Invalid receiver.');
    return data.toString('utf8', 20, messageEnd);
  }

  async function call(path, params, body) {
    const response = await fetch('https://qyapi.weixin.qq.com/cgi-bin/' + path + '?' + new URLSearchParams(params),
      {method:body ? 'POST' : 'GET', redirect:'error', signal:AbortSignal.timeout(12_000),
        headers:body ? {'Content-Type':'application/json'} : undefined, body:body ? JSON.stringify(body) : undefined});
    const result = await response.json();
    if (!response.ok) throw new Error('WeChat API HTTP ' + response.status);
    return result;
  }

  async function kf(path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!cachedToken || cachedToken.until <= Date.now()) {
        const auth = await call('gettoken', {corpid:corpId, corpsecret:secret});
        if (auth.errcode || !auth.access_token) throw new Error('WeChat credential rejected: ' + auth.errcode);
        cachedToken = {value:auth.access_token, until:Date.now() + (auth.expires_in - 60) * 1000};
      }
      const result = await call('kf/' + path, {access_token:cachedToken.value}, body);
      if ([40014, 42001].includes(result.errcode)) {
        cachedToken = undefined;
        continue;
      }
      if (result.errcode) throw new Error('WeChat ' + path + ' rejected: ' + result.errcode);
      return result;
    }
    throw new Error('WeChat access token expired.');
  }

  async function reply(message) {
    if (message.origin !== 3 || message.msgtype !== 'text' || message.open_kfid !== account ||
        message.send_time < Number(read('started')) || !message.msgid || !message.external_userid ||
        !message.text?.content?.trim()) return;
    const id = createHash('sha256').update(message.msgid).digest('hex').slice(0,32);
    const saved = db.prepare('SELECT content,sent FROM replies WHERE id=?').get(id);
    if (saved?.sent) return;
    const state = await kf('service_state/get', {open_kfid:account,external_userid:message.external_userid});
    if (![0,1].includes(state.service_state)) return;
    const content = saved?.content ?? limitText(await runAgent(message.text.content), 2048);
    if (!saved) db.prepare('INSERT INTO replies (id,content) VALUES (?,?)').run(id, content);
    await kf('send_msg', {touser:message.external_userid,open_kfid:account,msgid:id,msgtype:'text',text:{content}});
    db.prepare('UPDATE replies SET sent=1,content=NULL WHERE id=?').run(id);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const jobs = db.prepare('SELECT token FROM events WHERE done=0 ORDER BY received,rowid LIMIT 20').all();
      for (const job of jobs) {
        try {
          let more;
          do {
            const cursor = read('cursor');
            const page = await kf('sync_msg', {token:job.token, open_kfid:account, limit:100, ...(cursor ? {cursor} : {})});
            for (const message of page.msg_list ?? []) await reply(message);
            if (page.has_more && (!page.next_cursor || page.next_cursor === cursor)) throw new Error('WeChat cursor did not advance.');
            if (page.next_cursor) save('cursor', page.next_cursor);
            more = page.has_more;
          } while (more);
          db.prepare('UPDATE events SET done=1 WHERE token=?').run(job.token);
        } catch (error) {
          console.error(error.message);
        }
      }
      db.prepare('DELETE FROM events WHERE received<?').run(Date.now()-3*86400_000);
    } catch {
      console.error('WeChat queue could not be processed.');
    } finally {draining = false;}
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/wechat-kf/callback') {response.writeHead(404).end(); return;}
      if (request.method === 'GET') {
        const echo = decrypt(url.searchParams.get('echostr'), url.searchParams);
        response.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}).end(echo);
        return;
      }
      if (request.method !== 'POST') {response.writeHead(405).end(); return;}
      const xml = decrypt(readXml(await readCallback(request), 'Encrypt'), url.searchParams);
      if (readXml(xml,'Event') === 'kf_msg_or_event' && readXml(xml,'OpenKfId') === account) {
        const trigger = readXml(xml,'Token');
        if (trigger) db.prepare('INSERT OR IGNORE INTO events (token,received) VALUES (?,?)').run(trigger,Date.now());
      }
      response.end('success');
      void drain();
    } catch {response.writeHead(400).end('Invalid callback');}
  });
  server.listen(Number(process.env.PORT ?? 8788), '127.0.0.1', () => console.info('WeChat callback listening.'));
  setInterval(drain, 15_000);
  void drain();
}
