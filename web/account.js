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

const accountFlows = {
  login: {title:'登录 Agent Deck', description:'使用账号和密码登录。', submit:'登录'},
  register: {title:'创建 Agent Deck 账号', description:'验证你的邮箱或手机号，创建个人工作区。', submit:'创建账号'},
  reset: {title:'找回密码', description:'验证你的账号后设置新密码。', submit:'重置密码并登录'}
};

function accountForm(purpose, inline = false) {
  const login = purpose === 'login';
  if (!login && !accountStatus.email_configured && !accountStatus.sms_configured) {
    return [element('p', '邮箱和短信登录入口已就绪，发信服务配置完成后可获取验证码。')];
  }
  const form = element('form', undefined, 'module-form auth-form');
  const channels = [];
  if (login || accountStatus.email_configured) channels.push(['email', '邮箱']);
  if (accountStatus.sms_configured) channels.push(['phone', '手机号']);
  const method = element('fieldset', undefined, 'auth-method');
  const methods = element('div', undefined, 'auth-method-options');
  method.append(element('legend', login ? '登录方式' : '验证方式'), methods);
  method.hidden = channels.length === 1;
  for (const [value, name] of channels) {
    const option = element('label');
    const radio = element('input', undefined, 'sr');
    radio.type = 'radio';
    radio.name = 'method';
    radio.value = value;
    radio.checked = value === channels[0][0];
    option.append(radio, element('span', name));
    methods.append(option);
  }
  const selectedMethod = () => method.querySelector('input:checked').value;
  const address = field('address', '邮箱地址', 'email');
  const addressInput = address.querySelector('input');
  const setAddressType = () => {
    const email = selectedMethod() === 'email';
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
  const password = field('password', login ? '密码' :
    (purpose === 'register' ? '设置密码（至少 12 个字符）' : '新密码（至少 12 个字符）'), 'password');
  const passwordInput = password.querySelector('input');
  passwordInput.autocomplete = login ? 'current-password' : 'new-password';
  if (!login) passwordInput.minLength = 12;
  passwordInput.maxLength = 128;
  const send = element('button', '获取验证码', 'button');
  send.type = 'button';
  const submit = element('button', accountFlows[purpose].submit, 'button primary auth-submit');
  submit.disabled = !login;
  const message = element('p');
  message.setAttribute('role', 'status');
  let challenge;
  let requestedAddress;
  let requestedMethod;
  let countdown;
  const matchesRequest = () => addressInput.value.trim() === requestedAddress &&
    selectedMethod() === requestedMethod;
  addressInput.addEventListener('input', () => { if (!login) submit.disabled = !matchesRequest(); });
  method.addEventListener('change', () => {
    setAddressType();
    challenge = undefined;
    addressInput.value = '';
    codeInput.value = '';
    message.textContent = '';
    submit.disabled = !login;
    clearInterval(countdown);
    send.disabled = false;
    send.textContent = '获取验证码';
  });

  send.addEventListener('click', async () => {
    if (!addressInput.reportValidity()) return;
    send.disabled = true;
    method.disabled = true;
    submit.disabled = true;
    challenge = undefined;
    codeInput.value = '';
    message.textContent = '';
    const entered = addressInput.value.trim();
    const channel = selectedMethod();
    try {
      const result = await authRequest('send', {[channel]:entered, purpose});
      challenge = result.challenge;
      requestedAddress = entered;
      requestedMethod = channel;
      submit.disabled = !matchesRequest();
      message.textContent = '验证码已发送，5 分钟内有效。';
      codeInput.focus();
      let seconds = result.retry_after;
      send.textContent = '重新发送（' + seconds + ' 秒）';
      countdown = setInterval(() => {
        seconds--;
        if (!form.isConnected) {
          clearInterval(countdown);
          return;
        }
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
      method.disabled = false;
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || (!login && (!challenge || !matchesRequest()))) return;
    submit.disabled = true;
    method.disabled = true;
    message.textContent = '';
    try {
      if (login) {
        await authRequest('login', {[selectedMethod()]:addressInput.value.trim(), password:passwordInput.value});
      } else {
        const passwordField = purpose === 'reset' ? 'reset_password' : 'password';
        await authRequest('verify', {[requestedMethod]:requestedAddress, challenge, code:codeInput.value.trim(),
          purpose, [passwordField]:passwordInput.value});
      }
      const url = new URL(location.href);
      url.searchParams.delete('auth');
      location.replace(url.href);
    } catch (error) {
      message.textContent = error.message;
      submit.disabled = false;
    } finally {
      method.disabled = false;
    }
  });
  const row = element('div', undefined, 'auth-send-row');
  row.append(address, send);
  form.append(method);
  if (login) form.append(address);
  else form.append(row, code);
  form.append(password);
  form.append(submit, message);

  const actions = element('div', undefined, 'auth-actions');
  const destinations = purpose === 'login' ? [['register','创建账号'], ['reset','忘记密码']] : [['login','返回登录']];
  for (const [destination, label] of destinations) {
    const link = element(inline ? 'a' : 'button', label, 'auth-link');
    if (inline) {
      const url = new URL(location.href);
      if (destination === 'login') url.searchParams.delete('auth');
      else url.searchParams.set('auth', destination);
      link.href = url.href;
    } else {
      link.type = 'button';
      link.addEventListener('click', () => showAccountFlow(destination));
    }
    actions.append(link);
  }
  return [form, actions];
}

function showAccountFlow(purpose, inline = false) {
  const flow = accountFlows[purpose];
  const content = accountForm(purpose, inline);
  if (inline) {
    byId('sign-in-title').textContent = flow.title;
    byId('sign-in-description').textContent = flow.description;
    byId('sign-in-form').replaceChildren(...content);
  } else {
    openModal(flow.title, [element('p', flow.description), ...content]);
  }
}

const accountControl = accountButton.parentElement;
const accountPopover = byId('account-popover');

function setAccountPopover(open, restoreFocus = false) {
  accountPopover.hidden = !open;
  accountButton.setAttribute('aria-expanded', String(open));
  if (restoreFocus) accountButton.focus();
}

function showPasswordDialog() {
  const title = accountStatus.user.has_password ? 'Change password' : 'Set password';
  const root = element('div', undefined, 'account-password');
  const password = field('password', 'New password', 'password');
  const input = password.querySelector('input');
  input.autocomplete = 'new-password';
  input.minLength = 12;
  input.maxLength = 128;
  input.setAttribute('aria-describedby', 'account-password-hint');
  const hint = element('small', 'Use at least 12 characters.');
  hint.id = 'account-password-hint';
  password.append(hint);

  const form = element('form', undefined, 'module-form');
  const actions = element('div', undefined, 'account-password-actions');
  const cancel = element('button', 'Cancel', 'button');
  cancel.type = 'button';
  cancel.addEventListener('click', () => byId('modal').close());
  const save = element('button', 'Save password', 'button primary');
  save.type = 'submit';
  const notice = element('p', undefined, 'account-notice');
  notice.setAttribute('role', 'status');
  actions.append(cancel, save);
  form.append(password, notice, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    notice.textContent = '';
    delete notice.dataset.error;
    try {
      await authRequest('password', {password:input.value});
      accountStatus.user.has_password = true;
      byId('account-password-action').querySelector('span').textContent = 'Change password';
      input.value = '';
      notice.textContent = 'Password saved.';
    } catch (error) {
      notice.dataset.error = 'true';
      notice.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  root.append(form);
  setAccountPopover(false, true);
  openModal(title, [root]);
  input.focus();
}

function renderAccountControl() {
  const user = accountStatus.user;
  accountControl.hidden = false;
  if (!user) return;

  const address = user.email ?? user.phone ?? '';
  const avatar = () => {
    const badge = element('span', user.email ? Array.from(user.email)[0]?.toUpperCase() : undefined, 'account-avatar');
    badge.setAttribute('aria-hidden', 'true');
    if (!badge.textContent) badge.append(icon('user'));
    return badge;
  };
  accountButton.setAttribute('aria-label', 'Account');
  accountButton.setAttribute('aria-controls', accountPopover.id);
  accountButton.replaceChildren(avatar(), icon('chevron-down'));

  const identity = element('div', undefined, 'account-identity');
  const details = element('div', undefined, 'account-identity-details');
  details.append(element('strong', 'Signed in'), element('span', address));
  identity.append(avatar(), details);
  const password = iconButton('key', user.has_password ? 'Change password' : 'Set password', 'account-action');
  password.id = 'account-password-action';
  password.addEventListener('click', showPasswordDialog);
  const logout = iconButton('logout', 'Sign out', 'account-action account-sign-out');
  logout.querySelector('use').setAttribute('href', 'icons.svg?v=account-popover#logout');
  const notice = element('p', undefined, 'account-notice');
  notice.dataset.error = 'true';
  notice.setAttribute('role', 'status');
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    notice.textContent = '';
    try {
      await authRequest('logout', {});
      location.reload();
    } catch (error) {
      notice.textContent = error.message;
      logout.disabled = false;
    }
  });
  accountPopover.replaceChildren(identity, password, logout, notice);
  setAccountPopover(false);
}

accountButton.addEventListener('click', () => {
  if (!accountStatus) return;
  if (accountStatus.user) setAccountPopover(accountPopover.hidden);
  else showAccountFlow('login');
});

document.addEventListener('click', event => {
  if (!accountPopover.hidden && !accountControl.contains(event.target)) setAccountPopover(false);
});
accountControl.addEventListener('focusout', event => {
  if (!accountPopover.hidden && !accountControl.contains(event.relatedTarget)) setAccountPopover(false);
});
accountControl.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !accountPopover.hidden) {
    event.preventDefault();
    setAccountPopover(false, true);
  }
});

async function boot() {
  try {
    accountStatus = await authRequest('status');
    if (accountStatus) {
      renderAccountControl();
      document.querySelectorAll('[data-cloud]').forEach(item => { item.hidden = false; });
      if (accountStatus.required && !accountStatus.user) {
        const requested = new URL(location.href).searchParams.get('auth');
        showAccountFlow(['register','reset'].includes(requested) ? requested : 'login', true);
        byId('sign-in').hidden = false;
        return;
      }
    }
    byId('workspace-shell').hidden = false;
    byId('boot-screen').hidden = true;
    startTraceMonitoring();
    if (new URL(location.href).searchParams.has('checkout')) await loadModule('billing');
    else if (accountStatus?.user) await openCurrentAgent();
    else await loadModule('studio');
  } catch (error) {
    const retry = element('button', 'Retry', 'button primary');
    retry.addEventListener('click', boot, {once:true});
    byId('boot-screen').replaceChildren(element('p', error.message), retry);
    return;
  } finally {
    byId('boot-screen').hidden = !byId('workspace-shell').hidden || !byId('sign-in').hidden;
  }
}

boot();
