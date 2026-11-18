// One outbound WeCom connection per workspace. Storage alarms recover it after eviction.
const configKey = 'wecom-bot';
export class WeComGateway {
  constructor(ctx, decrypt, run, recordDelivery) {
    this.ctx = ctx;
    this.decrypt = decrypt;
    this.run = run;
    this.recordDelivery = recordDelivery;
    this.status = 'connecting';
    this.seen = new Map();
    this.pendingReplies = new Map();
  }

  async getStatus() {
    const config = await this.ctx.storage.get(configKey);
    return config ? {agent:config.agent, environment:config.environment,
      status:this.status, detail:this.detail, lastTrace:await this.ctx.storage.get('wecom-trace'),
      delivery:await this.ctx.storage.get('wecom-delivery')} :
      {status:'disconnected'};
  }

  async configure(config) {
    this.close();
    this.status = 'connecting';
    this.detail = undefined;
    this.seen.clear();
    await this.ctx.storage.delete(['wecom-trace','wecom-delivery']);
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
        headers:{Upgrade:'websocket'}, redirect:'manual'
      });
      const socket = response.webSocket;
      if (!socket) throw new Error('WeCom WebSocket upgrade returned HTTP ' + response.status);
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
      socket.addEventListener('close', event => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.status = 'reconnecting';
          this.detail = 'WebSocket closed (' + event.code + ')';
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

  reply(socket, request, streamId, content, finish) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(request);
        reject(new Error('No reply acknowledgement from WeCom'));
      }, 5000);
      this.pendingReplies.set(request, {
        socket,
        finish(frame) {
          clearTimeout(timer);
          if (frame.errcode === 0) resolve();
          else reject(new Error('WeCom rejected the reply (' + frame.errcode + ')'));
        }
      });
      try {
        this.send(socket, 'aibot_respond_msg', request, {msgtype:'stream',stream:{id:streamId,content,finish}});
      } catch (error) {
        this.pendingReplies.delete(request);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async updateDelivery(socket, key, state, detail) {
    if (this.socket === socket && this.latestMessage === key) {
      await this.ctx.storage.put('wecom-delivery', {state, detail, at:new Date().toISOString()});
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
    if (frame.cmd !== 'aibot_msg_callback') {
      const pending = this.pendingReplies.get(request);
      if (pending?.socket === socket && Number.isInteger(frame.errcode)) {
        this.pendingReplies.delete(request);
        pending.finish(frame);
      }
      return;
    }
    if (this.status !== 'connected') return;
    const text = frame.body?.text?.content;
    const key = frame.body?.msgid ?? request;
    if (typeof text !== 'string' || !text.trim() || this.seen.has(key)) return;
    this.seen.set(key, true);
    if (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value);
    const id = crypto.randomUUID();
    this.latestMessage = key;
    const acknowledgement = this.reply(socket, request, id, '正在处理，请稍候…', false);
    try {
      await Promise.all([this.updateDelivery(socket, key, 'received'), acknowledgement]);
    } catch (error) {
      await this.updateDelivery(socket, key, 'reply_failed', error.message);
      return;
    }
    let content;
    let failure;
    let traceId;
    try {
      const body = frame.body;
      const group = body.chattype === 'group';
      const conversation = group ? body.chatid : body.from?.userid;
      const trace = await this.run(config, text, typeof conversation === 'string' && conversation
        ? [group ? 'group' : 'direct', conversation] : null);
      traceId = trace.id;
      if (this.socket === socket && this.latestMessage === key) await this.ctx.storage.put('wecom-trace', trace.id);
      if (trace.status === 'error' || typeof trace.output !== 'string') throw new Error(trace.error ?? 'Agent could not generate a reply');
      content = trace.output.trim() || '暂时没有可发送的回复。';
    } catch (error) {
      failure = error.message;
      content = '暂时无法回复，请稍后重试。';
    }
    if (this.socket !== socket) {
      if (traceId) this.recordDelivery(traceId, 'reply_failed');
      return;
    }
    try {
      await this.reply(socket, request, id, Array.from(content).slice(0, 2048).join(''), true);
    } catch (error) {
      if (traceId) this.recordDelivery(traceId, 'reply_failed');
      await this.updateDelivery(socket, key, 'reply_failed', error.message);
      return;
    }
    if (traceId) this.recordDelivery(traceId, failure ? 'fallback_replied' : 'replied');
    await this.updateDelivery(socket, key, failure ? 'agent_failed' : 'replied', failure);
  }
}
