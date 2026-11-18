// One outbound WeCom connection per workspace. Storage alarms recover it after eviction.
const configKey = 'wecom-bot';
const topicEventCommand = 'aibot_topic_event_callback';
const validTopicId = value => typeof value === 'string' && value.length > 0 &&
  new TextEncoder().encode(value).length <= 128;
const messageTypes = new Set(['text', 'image', 'voice', 'video', 'file', 'mixed', 'markdown', 'location', 'link']);
export class WeComGateway {
  constructor(ctx, decrypt, run, recordDelivery, onNewPost) {
    this.ctx = ctx;
    this.decrypt = decrypt;
    this.run = run;
    this.recordDelivery = recordDelivery;
    this.onNewPost = onNewPost;
    this.status = 'connecting';
    this.seen = new Map();
    this.pendingReplies = new Map();
    this.diagnostics = [];
  }

  diagnostic(event, result) {
    this.diagnostics.push({event, result});
    if (this.diagnostics.length > 32) this.diagnostics.shift();
  }

  async getStatus() {
    const config = await this.ctx.storage.get(configKey);
    return config ? {agent:config.agent, environment:config.environment,
      status:this.status, detail:this.detail, lastTrace:await this.ctx.storage.get('wecom-trace'),
      delivery:await this.ctx.storage.get('wecom-delivery'), diagnostics:this.diagnostics,
      topicDiscovery:this.topicDiscovery?.expires > Date.now() ? {state:this.topicDiscovery.state,
        topicId:this.topicDiscovery.topicId, id:this.topicDiscovery.id} : undefined} :
      {status:'disconnected'};
  }

  async configure(config) {
    this.close();
    this.status = 'connecting';
    this.detail = undefined;
    this.seen.clear();
    this.diagnostics.length = 0;
    this.topicDiscovery = undefined;
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

  request(socket, command, requestId, body) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        reject(new Error('No acknowledgement from WeCom'));
      }, 5000);
      this.pendingReplies.set(requestId, {
        socket,
        finish(frame) {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      try {
        this.send(socket, command, requestId, body);
      } catch (error) {
        this.pendingReplies.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async reply(socket, request, streamId, content, finish) {
    const frame = await this.request(socket, 'aibot_respond_msg', request,
      {msgtype:'stream', stream:{id:streamId,content,finish}});
    if (frame.errcode !== 0) throw new Error('WeCom rejected the reply (' + frame.errcode + ')');
  }

  async discoverTopic(agent, marker) {
    const config = await this.ctx.storage.get(configKey);
    if (config?.agent !== agent || !this.socket || this.status !== 'connected') return {state:'disconnected'};
    const id = crypto.randomUUID();
    this.topicDiscovery = {id, marker, expires:Date.now() + 300_000, state:'waiting'};
    return {state:'waiting', id};
  }

  waitingForTopic() {
    const discovery = this.topicDiscovery;
    return discovery?.state === 'waiting' && discovery.expires > Date.now() ? discovery : undefined;
  }

  async onTopicEvent(socket, config, body) {
    if (body?.msgtype === 'event' && body.event?.eventtype === 'topic_event' &&
        body.event.topic_event?.type === 1) {
      const postId = body.event.topic_event.post_id;
      if (this.status !== 'connected' || body.aibotid !== config.botId || !body.from?.userid ||
          !validTopicId(body.topic_id) || !validTopicId(postId) || !Number.isInteger(body.create_time)) {
        return this.diagnostic('topic_post_created', 'invalid_event');
      }
      const result = await this.onNewPost({botId:config.botId, topicId:body.topic_id, postId, created:body.create_time,
        read:() => this.readCreatedPost(socket, body.topic_id, postId),
        comment:content => this.commentOnPost(socket, body.topic_id, postId, content)});
      return this.diagnostic('topic_post_created', result);
    }
    if (body?.msgtype !== 'event' || body.event?.eventtype !== 'topic_at_bot') {
      return this.diagnostic('topic_event', 'ignored');
    }
    const discovery = this.waitingForTopic();
    if (!discovery || this.status !== 'connected') return this.diagnostic('topic_at_bot', 'no_pending_setup');
    const {post_id:postId, reply_id:replyId} = body.event.topic_at_bot ?? {};
    const topicId = body.topic_id;
    if (body.aibotid !== config.botId || !validTopicId(topicId) || !validTopicId(postId) ||
        (replyId !== undefined && !validTopicId(replyId)) || typeof body.msgid !== 'string' || !body.msgid) {
      return this.diagnostic('topic_at_bot', 'invalid_event');
    }
    const key = 'topic:' + body.msgid;
    if (this.seen.has(key)) return this.diagnostic('topic_at_bot', 'duplicate');
    this.remember(key);
    const target = replyId
      ? {command:'aibot_topic_get_reply_list', body:{topic_id:topicId, post_id:postId, reply_id_list:[replyId]},
        list:'reply_list', id:'reply_id', value:replyId}
      : {command:'aibot_topic_get_post_list', body:{topic_id:topicId, post_id_list:[postId]},
        list:'post_list', id:'post_id', value:postId};
    let frame;
    try {
      frame = await this.request(socket, target.command, 'topic_mention_' + crypto.randomUUID(), target.body);
    } catch {
      return this.diagnostic('topic_at_bot', 'no_response');
    }
    if (this.socket !== socket || this.waitingForTopic() !== discovery) return;
    if (frame.errcode !== 0) return this.diagnostic('topic_at_bot', 'rejected');
    const entries = frame.body?.[target.list];
    if (!Array.isArray(entries)) return this.diagnostic('topic_at_bot', 'invalid_response');
    const found = entries.some(entry => entry?.[target.id] === target.value && !entry.is_recalled &&
      typeof entry.content === 'string' && entry.content.includes(discovery.marker));
    if (!found) return this.diagnostic('topic_at_bot', 'marker_not_found');
    discovery.topicId = topicId;
    discovery.state = 'found';
    this.diagnostic('topic_discovery', 'found');
  }

  remember(key) {
    this.seen.set(key, true);
    if (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value);
  }

  async commentOnPost(socket, topicId, postId, content) {
    if (this.socket !== socket || this.status !== 'connected') return {state:'comment_not_sent'};
    let frame;
    try {
      frame = await this.request(socket, 'aibot_topic_send_reply', 'topic_comment_' + crypto.randomUUID(),
        {topic_id:topicId, post_id:postId, content});
    } catch {
      return {state:'comment_unconfirmed'};
    }
    if (frame.errcode !== 0) return {state:'comment_rejected', code:frame.errcode};
    const replyId = frame.body?.reply_id;
    return validTopicId(replyId) ? {state:'comment_sent', reply_id:replyId} : {state:'comment_unconfirmed'};
  }

  async readCreatedPost(socket, topicId, postId) {
    const frame = await this.request(socket, 'aibot_topic_get_post_list', 'topic_trigger_' + crypto.randomUUID(),
      {topic_id:topicId, post_id_list:[postId]});
    if (this.socket !== socket || frame.errcode !== 0 || !Array.isArray(frame.body?.post_list)) {
      throw new Error('WeCom could not return the new post');
    }
    const post = frame.body.post_list.find(item => item?.post_id === postId);
    if (!post || post.is_recalled || typeof post.content !== 'string') return '';
    return post.content.trim();
  }

  async readTopicPosts(topicId, expectedBotId) {
    const config = await this.ctx.storage.get(configKey);
    const socket = this.socket;
    if (!config || !socket || this.status !== 'connected' || (expectedBotId && config.botId !== expectedBotId)) {
      return {state:'disconnected'};
    }
    const end = Math.floor(Date.now() / 1000);
    let frame;
    try {
      frame = await this.request(socket, 'aibot_topic_get_post_list', 'topic_posts_' + crypto.randomUUID(),
        {topic_id:topicId, type:1, begin_time:end - 900, end_time:end, sort_type:1, limit:5});
    } catch {
      this.diagnostic('topic_posts', 'no_response');
      return {state:'no_response'};
    }
    if (this.socket !== socket) return {state:'disconnected'};
    if (frame.errcode !== 0) {
      this.diagnostic('topic_posts', 'rejected');
      return {state:'rejected', code:frame.errcode};
    }
    if (!Array.isArray(frame.body?.post_list)) {
      this.diagnostic('topic_posts', 'invalid_response');
      return {state:'invalid_response'};
    }
    return {state:'ok', posts:frame.body.post_list, has_more:Boolean(frame.body.has_more), botId:config.botId};
  }

  async probeTopic(agent, topicId, marker) {
    const config = await this.ctx.storage.get(configKey);
    if (config?.agent !== agent) return {state:'disconnected'};
    const result = await this.readTopicPosts(topicId, config.botId);
    if (result.state !== 'ok') return result;
    const found = result.posts.some(post => !post?.is_recalled && typeof post?.content === 'string' &&
      post.content.includes(marker));
    this.diagnostic('topic_posts', found ? 'matched' : 'not_matched');
    return {state:found ? 'matched' : 'not_matched', checked:result.posts.length, has_more:result.has_more};
  }

  async updateDelivery(socket, key, state, detail) {
    if (this.socket === socket && this.latestMessage === key) {
      await this.ctx.storage.put('wecom-delivery', {state, detail, at:new Date().toISOString()});
    }
  }

  async onMessage(socket, config, data) {
    if (this.socket !== socket) return this.diagnostic('unclassified', 'stale_socket');
    if (typeof data !== 'string') return this.diagnostic('unclassified', 'non_text_frame');
    if (data.length > 100_000) return this.diagnostic('unclassified', 'oversize');
    let frame;
    try {frame = JSON.parse(data);}
    catch {return this.diagnostic('unclassified', 'invalid_json');}
    const type = frame?.body?.msgtype;
    const event = frame?.cmd === 'aibot_msg_callback'
      ? 'message:' + (messageTypes.has(type) ? type : 'other')
      : frame?.cmd === topicEventCommand ? 'topic_event'
      : frame?.cmd === 'aibot_event_callback' ? 'event_callback' : 'other_frame';
    const request = frame?.headers?.req_id;
    if (typeof request !== 'string') return this.diagnostic(event, 'missing_request');

    if (request.startsWith('aibot_subscribe_')) {
      this.status = frame.errcode === 0 ? 'connected' : 'authentication failed';
      this.detail = frame.errcode === 0 ? undefined : 'WeCom error ' + frame.errcode;
      this.lastAck = Date.now();
      return this.diagnostic('subscription', this.status === 'connected' ? 'accepted' : 'rejected');
    }
    if (request.startsWith('ping_')) {
      if (frame.errcode === 0) this.lastAck = Date.now();
      return this.diagnostic('heartbeat', frame.errcode === 0 ? 'accepted' : 'rejected');
    }
    if (frame.cmd === topicEventCommand) return this.onTopicEvent(socket, config, frame.body);
    if (frame.cmd !== 'aibot_msg_callback') {
      const pending = this.pendingReplies.get(request);
      if (pending?.socket === socket && Number.isInteger(frame.errcode)) {
        this.pendingReplies.delete(request);
        pending.finish(frame);
        return;
      }
      return this.diagnostic(event, 'ignored');
    }
    if (this.status !== 'connected') return this.diagnostic(event, 'not_connected');
    const text = frame.body?.text?.content;
    const key = frame.body?.msgid ?? request;
    if (typeof text !== 'string' || !text.trim()) return this.diagnostic(event, 'no_supported_text');
    if (this.seen.has(key)) return this.diagnostic(event, 'duplicate');
    this.remember(key);
    const discovery = this.topicDiscovery;
    if (discovery?.expires > Date.now() && text.includes(discovery.marker)) {
      return this.diagnostic('topic_discovery', 'waiting_for_topic_event');
    }
    this.diagnostic(event, 'accepted');
    const id = crypto.randomUUID();
    this.latestMessage = key;
    const acknowledgement = this.reply(socket, request, id, '正在处理，请稍候…', false);
    try {
      await Promise.all([this.updateDelivery(socket, key, 'received'), acknowledgement]);
    } catch (error) {
      this.diagnostic(event, 'acknowledgement_failed');
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
      this.diagnostic(event, 'socket_replaced');
      if (traceId) this.recordDelivery(traceId, 'reply_failed');
      return;
    }
    try {
      await this.reply(socket, request, id, Array.from(content).slice(0, 2048).join(''), true);
    } catch (error) {
      this.diagnostic(event, 'reply_failed');
      if (traceId) this.recordDelivery(traceId, 'reply_failed');
      await this.updateDelivery(socket, key, 'reply_failed', error.message);
      return;
    }
    this.diagnostic(event, failure ? 'fallback_replied' : 'replied');
    if (traceId) this.recordDelivery(traceId, failure ? 'fallback_replied' : 'replied');
    await this.updateDelivery(socket, key, failure ? 'agent_failed' : 'replied', failure);
  }
}
