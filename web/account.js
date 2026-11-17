let accountStatus;

async function authRequest(action, data) {
  const response = await fetch('/api/auth/' + action, data === undefined ? {cache:'no-store'} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
  });
  if (response.status === 404 && action === 'status') return null;
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '账号请求失败。');
  return value;
}

const accountButton = byId('account');

function accountForm() {
  if (!accountStatus.email_configured && !accountStatus.sms_configured) {
    return [element('p', '邮箱和短信登录入口已就绪，发信服务配置完成后可获取验证码。')];
  }
  const form = element('form', undefined, 'module-form');
  const channels = [];
  if (accountStatus.email_configured) channels.push(['email', '邮箱']);
  if (accountStatus.sms_configured) channels.push(['phone', '手机号']);
  const method = field('method', '登录方式', channels);
  const methodInput = method.querySelector('select');
  methodInput.value = channels[0][0];
  method.hidden = channels.length === 1;
  const address = field('address', '邮箱地址', 'email');
  const addressInput = address.querySelector('input');
  const setAddressType = () => {
    const email = methodInput.value === 'email';
    address.firstChild.textContent = email ? '邮箱地址' : '中国大陆手机号';
    addressInput.type = email ? 'email' : 'tel';
    addressInput.autocomplete = email ? 'email' : 'tel-national';
    addressInput.placeholder = email ? 'name@example.com' : '例如 13800000000';
  };
  setAddressType();
  const code = field('code', '验证码');
  const codeInput = code.querySelector('input');
  codeInput.inputMode = 'numeric';
  codeInput.autocomplete = 'one-time-code';
  codeInput.maxLength = 6;
  const password = field('password', '账号密码（已设置密码时填写）', 'password');
  const passwordInput = password.querySelector('input');
  passwordInput.required = false;
  passwordInput.autocomplete = 'current-password';
  const reset = field('reset_password', '新密码（至少 12 个字符）', 'password');
  const resetInput = reset.querySelector('input');
  resetInput.autocomplete = 'new-password';
  resetInput.required = false;
  resetInput.minLength = 12;
  resetInput.maxLength = 128;
  reset.hidden = true;
  const send = element('button', '获取验证码', 'button');
  send.type = 'button';
  const toggle = element('button', '忘记密码', 'button');
  toggle.type = 'button';
  const submit = element('button', '登录或注册', 'button primary');
  submit.disabled = true;
  const message = element('p');
  message.setAttribute('role', 'status');
  let challenge;
  let requestedAddress;
  let requestedMethod;
  let countdown;
  let recovering = false;

  toggle.addEventListener('click', () => {
    recovering = !recovering;
    reset.hidden = !recovering;
    resetInput.required = recovering;
    password.hidden = recovering;
    toggle.textContent = recovering ? '返回登录' : '忘记密码';
    submit.textContent = recovering ? '重置密码并登录' : '登录或注册';
  });
  const matchesRequest = () => addressInput.value.trim() === requestedAddress &&
    methodInput.value === requestedMethod;
  addressInput.addEventListener('input', () => { submit.disabled = !matchesRequest(); });
  methodInput.addEventListener('change', () => {
    setAddressType();
    addressInput.value = '';
    codeInput.value = '';
    message.textContent = '';
    submit.disabled = true;
    clearInterval(countdown);
    send.disabled = false;
    send.textContent = '获取验证码';
  });

  send.addEventListener('click', async () => {
    if (!addressInput.reportValidity()) return;
    send.disabled = true;
    methodInput.disabled = true;
    message.textContent = '';
    const entered = addressInput.value.trim();
    const channel = methodInput.value;
    try {
      const result = await authRequest('send', {[channel]:entered});
      challenge = result.challenge;
      requestedAddress = entered;
      requestedMethod = channel;
      submit.disabled = !matchesRequest();
      message.textContent = '验证码已发送，5 分钟内有效。';
      let seconds = result.retry_after;
      send.textContent = '重新发送（' + seconds + ' 秒）';
      countdown = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
          clearInterval(countdown);
          send.textContent = '重新发送';
          send.disabled = false;
        } else send.textContent = '重新发送（' + seconds + ' 秒）';
      }, 1000);
    } catch (error) {
      message.textContent = error.message;
      send.disabled = false;
    } finally {
      methodInput.disabled = false;
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!challenge || !matchesRequest()) return;
    submit.disabled = true;
    try {
      const data = {[requestedMethod]:requestedAddress, challenge, code:codeInput.value.trim()};
      if (recovering) data.reset_password = resetInput.value;
      else if (passwordInput.value) data.password = passwordInput.value;
      await authRequest('verify', data);
      location.reload();
    } catch (error) {
      message.textContent = error.message;
      submit.disabled = false;
    }
  });
  byId('modal').addEventListener('close', () => clearInterval(countdown), {once:true});
  form.append(method, address, send, code, password, reset, toggle, submit, message);
  return [form];
}

function accountSettings() {
  const user = accountStatus.user;
  const password = field('password', '新密码（至少 12 个字符）', 'password');
  const input = password.querySelector('input');
  input.autocomplete = 'new-password';
  input.minLength = 12;
  input.maxLength = 128;
  const form = formPanel(user.has_password ? '修改密码' : '设置密码', [password], '保存密码', async () => {
    await authRequest('password', {password:input.value});
    input.value = '';
    form.querySelector('[role=status]').textContent = '密码已保存。下次登录请同时输入密码和验证码。';
  });
  const logout = element('button', '退出登录', 'button');
  const status = element('p');
  status.setAttribute('role', 'status');
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await authRequest('logout', {});
      location.reload();
    } catch (error) {
      status.textContent = error.message;
      logout.disabled = false;
    }
  });
  return [element('p', user.email ?? user.phone), form, logout, status];
}

accountButton.addEventListener('click', () => {
  if (!accountStatus) return;
  openModal(accountStatus.user ? '账号设置' : '登录或注册', accountStatus.user ? accountSettings() : accountForm());
});

(async () => {
  try {
    accountStatus = await authRequest('status');
    if (!accountStatus) return;
    accountButton.hidden = false;
    accountButton.textContent = accountStatus.user?.email ?? accountStatus.user?.phone ?? '登录或注册';
    document.querySelectorAll('[data-cloud]').forEach(item => { item.hidden = false; });
    if (accountStatus.required && !accountStatus.user) {
      activeModule = null;
      document.querySelector('.sidebar nav').hidden = true;
      byId('connect').hidden = true;
      byId('tracing-content').hidden = true;
      byId('platform-content').hidden = false;
      byId('platform-content').replaceChildren(element('h1', '登录 Agent Deck'),
        element('p', '获取验证码后打开你的工作区。'));
      accountButton.click();
    }
  } catch {
    // The Python preview does not serve Cloudflare account APIs.
  }
})();
