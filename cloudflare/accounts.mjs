import { DurableObject } from 'cloudflare:workers';

export const workspaceCookie = '__Host-agentops-workspace';
export const sessionCookie = '__Host-agentops-session';
export const workspacePattern = /^[0-9a-f]{32}$/;
export const randomId = () => crypto.randomUUID().replaceAll('-', '');
export const json = (body, status = 200, headers = {}) =>
  Response.json(body, {status, headers:{'Cache-Control':'no-store', ...headers}});
const encoder = new TextEncoder();
const day = 86400000;
const sessionAge = 30 * day;
const challengeAge = 300000;
const passwordIterations = 100000;
const smsHost = 'dypnsapi.aliyuncs.com';

export function cookieValue(request, name) {
  return (request.headers.get('Cookie') ?? '').split(';').map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(name + '='))?.slice(name.length + 1);
}

export function cookie(name, value, seconds) {
  return name + '=' + value + '; Path=/; Max-Age=' + seconds + '; HttpOnly; Secure; SameSite=Strict';
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const sha256 = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
export const smsConfigured = env => Boolean(env.PNVS_ACCESS_KEY_ID && env.PNVS_ACCESS_KEY_SECRET &&
  env.PNVS_SIGN_NAME && env.PNVS_TEMPLATE_CODE);
export const emailConfigured = env => Boolean(env.AUTH_EMAIL && env.LOGIN_FROM && env.AGENTOPS_INGEST_TOKEN);
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char =>
  '%' + char.charCodeAt(0).toString(16).toUpperCase());

async function smsRequest(env, action, parameters) {
  const query = Object.keys(parameters).sort().map(key => encode(key) + '=' + encode(parameters[key])).join('&');
  const headers = {
    host:smsHost,
    'x-acs-action':action,
    'x-acs-content-sha256':await sha256(''),
    'x-acs-date':new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    'x-acs-signature-nonce':randomId(),
    'x-acs-version':'2017-05-25'
  };
  const names = Object.keys(headers).sort();
  const signed = names.join(';');
  const canonical = ['POST', '/', query, names.map(name => name + ':' + headers[name] + '\n').join(''),
    signed, headers['x-acs-content-sha256']].join('\n');
  const algorithm = 'ACS3-HMAC-SHA256';
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.PNVS_ACCESS_KEY_SECRET),
    {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(algorithm + '\n' + await sha256(canonical))));
  delete headers.host;
  headers.Authorization = algorithm + ' Credential=' + env.PNVS_ACCESS_KEY_ID +
    ',SignedHeaders=' + signed + ',Signature=' + signature;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('https://' + smsHost + '/?' + query, {
      method:'POST', headers, redirect:'manual', signal:controller.signal
    });
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function phoneNumber(value) {
  if (typeof value !== 'string') return;
  const digits = value.trim().replace(/^\+86\s*/, '');
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;
}

function emailAddress(value) {
  if (typeof value !== 'string') return;
  const address = value.trim().toLowerCase();
  if (address.length <= 254 && /^[^\s@<>(),;:"\\]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address)) return address;
}

function sixDigits() {
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= 4294000000);
  return String(bytes[0] % 1000000).padStart(6, '0');
}

async function emailCodeDigest(secret, challenge, identity, code) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(
    ['agentops-email-otp', challenge, identity, code].join(':')
  )));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({
    name:'PBKDF2', hash:'SHA-256', salt:encoder.encode(salt), iterations:passwordIterations
  }, key, 256));
}

function constantTime(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function viewer(account) {
  const identity = account.phone;
  const profile = {has_password:Boolean(account.password)};
  if (identity.includes('@')) profile.email = identity.replace(/^([^@])[^@]*/, '$1***');
  else profile.phone = '+86 ' + identity.slice(0, 3) + '****' + identity.slice(-4);
  return profile;
}

async function smallBody(request) {
  const stream = request.body?.getReader();
  if (!stream) throw new Error('Missing body');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const {done, value} = await stream.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await stream.cancel();
      throw new Error('Body too large');
    }
    text += decoder.decode(value, {stream:true});
  }
  const result = JSON.parse(text + decoder.decode());
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Invalid body');
  return result;
}

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS accounts (phone TEXT PRIMARY KEY, workspace TEXT NOT NULL UNIQUE, password TEXT, salt TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, phone TEXT NOT NULL, issued INTEGER NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, attempts INTEGER NOT NULL, state TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS email_codes (id TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS limits (name TEXT PRIMARY KEY, expires INTEGER NOT NULL, count INTEGER NOT NULL)');
  }

  one(query, ...args) {
    return this.sql.exec(query, ...args).toArray()[0];
  }

  async getSession(token) {
    if (!/^[0-9a-f]{64}$/.test(token ?? '')) return null;
    return this.one('SELECT a.*, s.issued FROM sessions s JOIN accounts a ON a.phone=s.phone WHERE s.token=? AND s.expires>?',
      await sha256(token), Date.now());
  }

  takeLimits(limits) {
    const now = Date.now();
    const snapshots = limits.map(([name, maximum, interval]) => {
      const current = this.one('SELECT expires,count FROM limits WHERE name=? AND expires>?', name, now);
      return {name, maximum, expires:current?.expires ?? now + interval, count:current?.count ?? 0};
    });
    if (snapshots.some(bucket => bucket.count >= bucket.maximum)) return false;
    for (const {name, expires, count} of snapshots) this.sql.exec('INSERT OR REPLACE INTO limits VALUES (?,?,?)', name, expires, count + 1);
    return true;
  }

  async send(identity, address, channel) {
    const now = Date.now();
    this.sql.exec('DELETE FROM limits WHERE expires<=?', now);
    this.sql.exec('DELETE FROM challenges WHERE expires<=?', now);
    this.sql.exec('DELETE FROM email_codes WHERE expires<=?', now);
    const [ipDigest, identityDigest] = await Promise.all([sha256(address || 'unknown'), sha256(identity)]);
    if (!this.takeLimits([
      [channel + ':global', 100, day], [channel + ':ip:' + ipDigest, 8, 600000],
      [channel + ':recipient:' + identityDigest, 3, 1800000], [channel + ':cooldown:' + identityDigest, 1, 60000]
    ])) return json({error:'请求过于频繁，请稍后再试。'}, 429);
    const challenge = randomId();
    this.sql.exec('INSERT OR REPLACE INTO challenges VALUES (?,?,?,0,?)', challenge, identity, now + challengeAge, 'sending');
    try {
      if (channel === 'email') {
        const code = sixDigits();
        const hashed = await emailCodeDigest(this.env.AGENTOPS_INGEST_TOKEN, challenge, identity, code);
        this.sql.exec('INSERT INTO email_codes VALUES (?,?,?)', challenge, hashed, now + challengeAge);
        await this.env.AUTH_EMAIL.send({
          to:identity, from:{email:this.env.LOGIN_FROM, name:'Agent Workshop'},
          subject:'Agent Workshop 登录验证码',
          text:'你的 Agent Workshop 登录验证码是 ' + code + '，5 分钟内有效。若你未请求此验证码，可忽略这封邮件。'
        });
      } else {
        const result = await smsRequest(this.env, 'SendSmsVerifyCode', {
          CountryCode:'86', PhoneNumber:identity, SignName:this.env.PNVS_SIGN_NAME, TemplateCode:this.env.PNVS_TEMPLATE_CODE,
          TemplateParam:'{"code":"##code##","min":"5"}', OutId:challenge, CodeLength:'6', CodeType:'1',
          ValidTime:'300', Interval:'60', DuplicatePolicy:'1', ReturnVerifyCode:'false'
        });
        if (result?.Code !== 'OK' || result.Success !== true) {
          console.error('SMS send failed', /^[a-zA-Z0-9_.-]+$/.test(result?.Code ?? '') ? result.Code : 'transport');
          throw new Error('SMS service rejected the request');
        }
      }
    } catch (error) {
      this.sql.exec('DELETE FROM challenges WHERE id=?', challenge);
      this.sql.exec('DELETE FROM email_codes WHERE id=?', challenge);
      console.error('Verification delivery failed', channel, error.name);
      return json({error:'验证码发送失败，请稍后再试。'}, 502);
    }
    this.sql.exec('UPDATE challenges SET state=? WHERE id=?', 'ready', challenge);
    return json({challenge, retry_after:60});
  }

  async verify(phone, body, guest, channel) {
    const {challenge, code, password, reset_password} = body;
    const reset = reset_password !== undefined;
    if (reset && (typeof reset_password !== 'string' || reset_password.length < 12 || reset_password.length > 128)) {
      return json({error:'新密码长度需为 12 至 128 个字符。'}, 400);
    }
    if (typeof challenge !== 'string' || !workspacePattern.test(challenge) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return json({error:'请输入有效的六位验证码。'}, 400);
    }
    const now = Date.now();
    const attempt = this.one("UPDATE challenges SET attempts=attempts+1,state='checking' WHERE id=? AND phone=? AND state='ready' AND expires>? AND attempts<5 RETURNING id", challenge, phone, now);
    if (!attempt) return json({error:'验证码已过期或尝试次数过多，请重新获取。'}, 401);
    try {
      const account = this.one('SELECT * FROM accounts WHERE phone=?', phone);
      if (account?.password && !reset) {
        const valid = typeof password === 'string' && password.length <= 128 &&
          constantTime(await passwordHash(password, account.salt), account.password);
        if (!valid) return json({error:'此账号需要正确的密码和验证码。'}, 401);
      }
      let passed;
      if (channel === 'email') {
        const expected = this.one('SELECT digest FROM email_codes WHERE id=? AND expires>?', challenge, Date.now());
        const submitted = await emailCodeDigest(this.env.AGENTOPS_INGEST_TOKEN, challenge, phone, code);
        passed = expected && constantTime(submitted, expected.digest);
      } else {
        const result = await smsRequest(this.env, 'CheckSmsVerifyCode', {
          CountryCode:'86', PhoneNumber:phone, OutId:challenge, VerifyCode:code
        }).catch(() => null);
        passed = result?.Code === 'OK' && result.Model?.VerifyResult === 'PASS';
      }
      if (!passed) return json({error:'验证码无效或已过期。'}, 401);
      const token = randomId() + randomId();
      const hashed = await sha256(token);
      const newSalt = reset ? randomId() : null;
      const newPassword = reset ? await passwordHash(reset_password, newSalt) : null;
      const consumed = this.one("DELETE FROM challenges WHERE id=? AND state='checking' AND expires>? RETURNING id", challenge, Date.now());
      if (!consumed) return json({error:'验证码已失效，请重新获取。'}, 401);
      if (channel === 'email') this.sql.exec('DELETE FROM email_codes WHERE id=?', challenge);
      if (!account) {
        const candidate = workspacePattern.test(guest ?? '') ? guest : randomId();
        const occupied = this.one('SELECT 1 FROM accounts WHERE workspace=?', candidate);
        this.sql.exec('INSERT INTO accounts (phone,workspace) VALUES (?,?)', phone, occupied ? randomId() : candidate);
      }
      if (reset) {
        this.sql.exec('UPDATE accounts SET password=?,salt=? WHERE phone=?', newPassword, newSalt, phone);
        this.sql.exec('DELETE FROM sessions WHERE phone=?', phone);
      }
      this.sql.exec('DELETE FROM sessions WHERE expires<=?', now);
      this.sql.exec('INSERT INTO sessions VALUES (?,?,?,?)', hashed, phone, now, now + sessionAge);
      const current = this.one('SELECT * FROM accounts WHERE phone=?', phone);
      const response = json({user:viewer(current)});
      response.headers.append('Set-Cookie', cookie(sessionCookie, token, sessionAge / 1000));
      response.headers.append('Set-Cookie', cookie(workspaceCookie, '', 0));
      return response;
    } finally {
      this.sql.exec("UPDATE challenges SET state='ready' WHERE id=? AND state='checking'", challenge);
    }
  }

  async fetch(request) {
    const action = new URL(request.url).pathname;
    const token = request.headers.get('X-AgentOps-Session');
    const guest = request.headers.get('X-AgentOps-Guest');
    if (action === '/resolve') {
      const account = await this.getSession(token);
      if (account) return json({user:viewer(account), workspace:account.workspace});
      const claimed = workspacePattern.test(guest ?? '') && Boolean(this.one('SELECT 1 FROM accounts WHERE workspace=?', guest));
      return json({user:null, claimed});
    }
    if (request.method !== 'POST') return json({error:'Method not allowed'}, 405);
    if (action === '/logout') {
      if (/^[0-9a-f]{64}$/.test(token ?? '')) this.sql.exec('DELETE FROM sessions WHERE token=?', await sha256(token));
      return json({ok:true}, 200, {'Set-Cookie':cookie(sessionCookie, '', 0)});
    }
    let body;
    try { body = await smallBody(request); }
    catch { return json({error:'无效请求。'}, 400); }
    if (action === '/password') {
      const account = await this.getSession(token);
      if (!account) return json({error:'请先登录。'}, 401);
      const password = body.password;
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
        return json({error:'密码长度需为 12 至 128 个字符。'}, 400);
      }
      if (Date.now() - account.issued > 600000) return json({error:'请重新登录后再设置密码。'}, 403);
      const salt = randomId();
      const hashed = await passwordHash(password, salt);
      this.sql.exec('UPDATE accounts SET password=?,salt=? WHERE phone=?', hashed, salt, account.phone);
      const currentSession = await sha256(token);
      this.sql.exec('DELETE FROM sessions WHERE phone=? AND token!=?', account.phone, currentSession);
      return json({ok:true});
    }
    if (!['/send', '/verify'].includes(action)) return json({error:'Unknown auth action'}, 404);
    const useEmail = body.email !== undefined;
    if (!useEmail && !smsConfigured(this.env)) return json({error:'短信服务尚未配置。'}, 503);
    if (useEmail && !emailConfigured(this.env)) return json({error:'邮件服务尚未配置。'}, 503);
    const identity = useEmail ? emailAddress(body.email) : phoneNumber(body.phone);
    if (!identity) return json({error:useEmail ? '请输入有效的邮箱地址。' : '请输入中国大陆手机号。'}, 400);
    const channel = useEmail ? 'email' : 'sms';
    if (action === '/send') return this.send(identity, request.headers.get('X-AgentOps-Address'), channel);
    return this.verify(identity, body, guest, channel);
  }
}
