// One outbound WeCom connection per workspace. Storage alarms recover it after eviction.
const configKey = 'wecom-bot';
export class WeComGateway {
  constructor(ctx, decrypt, run) {
    this.ctx = ctx;
    this.decrypt = decrypt;
    this.run = run;
    this.status = 'connecting';
    this.seen = new Map();
  }

  async getStatus() {
    const config = await this.ctx.storage.get(configKey);
    return config ? {agent:config.agent, environment:config.environment,
      status:this.status, detail:this.detail, lastTrace:this.lastTrace ?? await this.ctx.storage.get('wecom-trace')} :
      {status:'disconnected'};
  }

  async configure(config) {
    this.close();
    this.status = 'connecting';
    this.detail = undefined;
    this.lastTrace = undefined;
    this.seen.clear();
    await this.ctx.storage.delete('wecom-trace');
    if (config) {
      await this.ctx.storage.put(configKey, config);
      await this.ctx.storage.setAlarm(Date.now()+1000);
    } else {
      await this.ctx.storage.delete(configKey);
      await this.ctx.storage.deleteAlarm();
    }
    return this.getStatus();
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    try {socket?.close(1000, 'Reconnecting');} catch {}
  }

  send(socket, cmd, reqId, body) {
    socket.send(JSON.stringify({cmd,headers:{req_id:reqId},...(body ? {body} : {})}));
  }

  async alarm() {
    const config = await this.ctx.storage.get(configKey);
    if (!config) return;
    await this.ctx.storage.setAlarm(Date.now()+25_000);
    try {
      if (this.socket && this.status === 'connected' && Date.now()-this.lastAck < 55_000) {
        this.send(this.socket, 'ping', 'ping_' + crypto.randomUUID());
        return;
      }
      this.close();
      const secret = await this.decrypt(config.secret);
      if (!secret) throw new Error('Saved Bot Secret could not be opened');
      const response = await fetch('https://openws.work.weixin.qq.com/', {
        headers:{Upgrade:'websocket'}, redirect:'error', signal:AbortSignal.timeout(10_000)
      });
      const socket = response.webSocket;
      if (!socket) throw new Error('WeCom did not accept the WebSocket upgrade');
      // A concurrent configuration update owns the next connection attempt.
      const latest = await this.ctx.storage.get(configKey);
      socket.accept();
      if (latest?.secret !== config.secret) {socket.close(1000, 'Configuration changed'); return;}
      this.socket = socket;
      this.status = 'connecting';
      this.detail = undefined;
      socket.addEventListener('message', event => {
        this.ctx.waitUntil(this.onMessage(socket, config, event.data).catch(() => {
          if (this.socket === socket) this.detail = 'A message could not be handled';
        }));
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.status = 'reconnecting';
        }
      });
      this.send(socket, 'aibot_subscribe', 'aibot_subscribe_' + crypto.randomUUID(),
        {bot_id:config.botId,secret});
    } catch (error) {
      this.close();
      this.status = 'reconnecting';
      this.detail = error.message;
    }
  }

  async onMessage(socket, config, data) {
    if (this.socket !== socket || typeof data !== 'string' || data.length > 100_000) return;
    const frame = JSON.parse(data);
    const request = frame.headers?.req_id;
    if (typeof request !== 'string') return;
    if (request.startsWith('aibot_subscribe_')) {
      this.status = frame.errcode === 0 ? 'connected' : 'authentication failed';
      this.detail = frame.errcode === 0 ? undefined : 'WeCom error ' + frame.errcode;
      this.lastAck = Date.now();
      return;
    }
    if (request.startsWith('ping_') && frame.errcode === 0) this.lastAck = Date.now();
    if (frame.cmd !== 'aibot_msg_callback' || this.status !== 'connected') return;
    const text = frame.body?.text?.content;
    const key = frame.body?.msgid ?? request;
    if (typeof text !== 'string' || !text.trim() || this.seen.has(key)) return;
    this.seen.set(key, true);
    if (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value);
    const id = crypto.randomUUID();
    const reply = (content, finish) => this.send(socket, 'aibot_respond_msg', request,
      {msgtype:'stream',stream:{id,content,finish}});
    reply('正在处理，请稍候…', false);
    let content;
    try {
      const trace = await this.run(config, text);
      if (trace.status === 'error' || typeof trace.output !== 'string') throw new Error('Agent failed');
      this.lastTrace = trace.id;
      if (this.socket === socket) await this.ctx.storage.put('wecom-trace', trace.id);
      content = trace.output.trim() || '暂时没有可发送的回复。';
    } catch {
      content = '暂时无法回复，请稍后重试。';
    }
    if (this.socket === socket) reply(Array.from(content).slice(0, 3000).join(''), true);
  }
}
