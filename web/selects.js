const selectControls = new WeakMap();
let openSelect;
let nextSelectId = 0;

function enhanceSelect(select) {
  if (selectControls.has(select) || select.multiple || select.size > 1) return;
  const fieldLabel = select.labels?.[0];
  const label = select.getAttribute('aria-label') ||
    Array.from(fieldLabel?.childNodes ?? []).filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent).join('').trim() || select.name;
  const container = element('span', undefined, 'select-control');
  select.before(container);
  container.append(select);
  select.classList.add('sr');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const trigger = iconButton('chevron-down', '', 'select-trigger');
  trigger.type = 'button';
  const caption = trigger.querySelector('span');
  const menu = element('div', undefined, 'select-menu');
  menu.id = 'select-menu-' + ++nextSelectId;
  menu.hidden = true;
  menu.tabIndex = -1;
  menu.setAttribute('role', 'listbox');
  if (label) menu.setAttribute('aria-label', label);
  const topLayer = typeof menu.showPopover === 'function';
  if (topLayer) menu.setAttribute('popover', 'manual');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menu.id);
  container.append(trigger, menu);

  let candidates = [];
  let active = -1;
  let typed = '';
  let lastType = 0;

  function sync() {
    const value = select.selectedOptions[0]?.textContent ?? 'Select…';
    caption.textContent = value;
    trigger.setAttribute('aria-label', label ? label + ': ' + value : value);
    trigger.disabled = select.matches(':disabled') || !Array.from(select.options).some(option =>
      !option.disabled && !option.hidden && (!select.required || option.value !== ''));
    if (select.validity.valid) trigger.removeAttribute('aria-invalid');
    if (trigger.disabled && openSelect?.menu === menu) close();
  }

  function position() {
    const bounds = trigger.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const down = window.innerHeight - bounds.bottom - 10;
    const up = bounds.top - 10;
    const openUp = down < 180 && up > down;
    const width = Math.min(viewport - 16, Math.max(168, bounds.width, menu.scrollWidth));
    const left = Math.max(8, Math.min(bounds.left, viewport - width - 8));
    menu.style.width = width + 'px';
    menu.style.maxHeight = Math.max(40, Math.min(290, openUp ? up : down)) + 'px';
    menu.style.left = left + 'px';
    menu.style.top = openUp ? Math.max(8, bounds.top - menu.offsetHeight - 5) + 'px' : bounds.bottom + 5 + 'px';
  }

  function highlight(index, scroll = true) {
    active = index;
    for (const [i, row] of Array.from(menu.children).entries()) row.classList.toggle('is-active', i === index);
    const row = menu.children[index];
    if (!row) return;
    menu.setAttribute('aria-activedescendant', row.id);
    if (scroll) row.scrollIntoView({block:'nearest'});
  }

  function close(restoreFocus = false) {
    if (openSelect?.menu !== menu) return;
    openSelect = undefined;
    if (topLayer) menu.hidePopover();
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  function choose(index) {
    const item = candidates[index];
    if (!item) return;
    close(true);
    if (select.selectedIndex !== item.index) {
      select.selectedIndex = item.index;
      select.dispatchEvent(new Event('input', {bubbles:true}));
      select.dispatchEvent(new Event('change', {bubbles:true}));
    }
    sync();
  }

  function open(direction) {
    if (trigger.disabled) return;
    openSelect?.close();
    candidates = Array.from(select.options, (option, index) => ({option, index})).filter(({option}) =>
      !option.hidden && !option.disabled && (!select.required || option.value !== ''));
    menu.replaceChildren(...candidates.map(({option, index}, visibleIndex) => {
      const row = element('div', undefined, 'select-option');
      row.id = menu.id + '-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected));
      row.append(element('span', option.textContent), icon('check'));
      row.addEventListener('pointermove', event => { if (event.pointerType === 'mouse') highlight(visibleIndex, false); });
      row.addEventListener('click', () => choose(visibleIndex));
      return row;
    }));
    openSelect = {menu, trigger, close};
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (topLayer) {
      menu.showPopover();
      menu.style.width = 'max-content';
      position();
    }
    typed = '';
    const selected = candidates.findIndex(({index}) => index === select.selectedIndex);
    menu.focus({preventScroll:true});
    highlight(selected >= 0 ? selected : direction < 0 ? candidates.length - 1 : 0);
  }

  trigger.addEventListener('click', () => openSelect?.menu === menu ? close(true) : open());
  trigger.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    open(event.key === 'ArrowUp' ? -1 : 1);
  });
  menu.addEventListener('keydown', event => {
    switch (event.key) {
      case 'Escape': event.stopPropagation(); close(true); break;
      case 'Tab': close(true); return;
      case 'ArrowDown': highlight(Math.min(active + 1, candidates.length - 1)); break;
      case 'ArrowUp': highlight(Math.max(active - 1, 0)); break;
      case 'Home': highlight(0); break;
      case 'End': highlight(candidates.length - 1); break;
      case 'Enter':
      case ' ': choose(active); break;
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
        const now = Date.now();
        typed = (now - lastType < 700 ? typed : '') + event.key.toLocaleLowerCase();
        lastType = now;
        const index = candidates.findIndex(({option}) => option.textContent.toLocaleLowerCase().startsWith(typed));
        if (index >= 0) highlight(index);
      }
    }
    event.preventDefault();
  });
  select.addEventListener('input', sync);
  select.addEventListener('change', sync);
  select.addEventListener('focus', () => trigger.focus());
  select.addEventListener('invalid', () => trigger.setAttribute('aria-invalid', 'true'));
  fieldLabel?.addEventListener('click', event => {
    if (event.target.closest('button')) return;
    event.preventDefault();
    if (!menu.contains(event.target)) trigger.focus();
  });
  selectControls.set(select, sync);
  sync();
}

function syncSelect(select) {
  selectControls.get(select)?.();
}

document.querySelectorAll('select').forEach(enhanceSelect);
new MutationObserver(records => {
  if (openSelect && (!openSelect.menu.isConnected || !openSelect.trigger.getClientRects().length)) openSelect.close();
  for (const record of records) {
    const select = record.target.closest?.('select');
    if (select) syncSelect(select);
    for (const node of record.addedNodes) {
      if (node.matches?.('select')) enhanceSelect(node);
      else node.querySelectorAll?.('select').forEach(enhanceSelect);
    }
  }
}).observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['disabled','selected']});

document.addEventListener('pointerdown', event => {
  if (openSelect && !openSelect.menu.contains(event.target) && !openSelect.trigger.contains(event.target)) openSelect.close();
});
window.addEventListener('resize', () => openSelect?.close());
