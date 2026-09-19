// Display client for the Keymeleon backend.
//
// It owns no state of its own. The backend resolves which layer is active and which page it is on;
// this file re-runs the same `liveLayout` over the published context so the caps it draws are exactly
// the ones `POST /api/key` will dispatch. Anything it cannot derive from the snapshot, it does not show.

import { liveLayout, resolveLayer, LiveClient } from './live.js';

const SHORTCUTS = ['u', 'i', 'o', 'j', 'k', 'l'];
const params = new URLSearchParams(location.search);
// The native host loads ?popup=1&native=1. Only a real browser window should claim popup focus —
// the native panel is an accessory window and never becomes the foreground application.
const isBrowserPopup = params.get('popup') === '1' && params.get('native') !== '1';

const $ = selector => document.querySelector(selector);
const grid = $('#keys');
const statusLine = $('#status');

let context = null;
let statusTimer;
let focusReported = false;

function status(message, kind = '') {
  clearTimeout(statusTimer);
  statusLine.textContent = message || '';
  statusLine.className = `status ${kind}`.trim();
  if (message) statusTimer = setTimeout(() => { statusLine.textContent = ''; statusLine.className = 'status'; }, 4000);
}

const buttons = SHORTCUTS.map((letter, slot) => {
  const button = document.createElement('button');
  button.className = 'key';
  button.type = 'button';
  button.setAttribute('aria-keyshortcuts', letter);
  button.innerHTML = '<span class="cap"></span><span class="icon"></span><span class="label"></span>';
  button.querySelector('.cap').textContent = letter.toUpperCase();
  button.addEventListener('click', () => press(slot));
  grid.append(button);
  return button;
});

function render(snapshot) {
  context = snapshot.context;
  const layout = liveLayout(context, context.keyboard.page);

  layout.forEach((action, slot) => {
    const button = buttons[slot];
    const empty = !action;
    button.classList.toggle('empty', empty);
    button.disabled = empty || action.disabled;
    button.querySelector('.icon').textContent = empty ? '' : action.icon || '';
    button.querySelector('.label').textContent = empty ? '' : action.label || action.id;
    // A key that cannot fire keeps its place and carries the reason, rather than disappearing.
    button.title = empty ? '' : action.description || '';
    button.setAttribute('aria-label', empty
      ? `${SHORTCUTS[slot].toUpperCase()}: unused`
      : `${SHORTCUTS[slot].toUpperCase()}: ${action.label}${action.disabled ? ` — unavailable: ${action.description}` : ''}`);
  });

  $('#app-name').textContent = context.active_app || '';
  $('#reason').textContent = resolveReason();
  const pages = context.keyboard.mode === 'project' ? 3 : 2;
  $('#page').textContent = `${String(context.keyboard.page + 1).padStart(2, '0')}/${String(pages).padStart(2, '0')}`;

  if (snapshot.message) status(snapshot.message);
}

// Every layer carries the reason it won. Showing it is the point: the developer should be able to see
// why these six keys and not six others, and a watcher fault must not masquerade as a quiet layer.
function resolveReason() {
  if (context.watcher_error) return context.watcher_error;
  return resolveLayer(context, context.keyboard.page).reason || '';
}

async function press(slot) {
  if (!context) return;
  const action = liveLayout(context, context.keyboard.page)[slot];
  if (!action || action.disabled) {
    if (action?.description) status(action.description, 'err');
    return;
  }
  const button = buttons[slot];
  button.classList.add('hit');
  setTimeout(() => button.classList.remove('hit'), 150);
  try {
    // The press is bound to the layout it was drawn from. If the context moved in between, the backend
    // rejects it with 409 rather than firing the action that has since replaced it.
    const result = await client.press(slot, context.keyboard.layout_revision);
    status(result.message || action.label, 'ok');
  } catch (error) {
    status(error.message, 'err');
  }
}

document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.isComposing) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  const slot = SHORTCUTS.indexOf(event.key.toLowerCase());
  if (slot === -1) return;
  event.preventDefault();
  press(slot);
});

const client = new LiveClient(render, (connected, message) => {
  $('#dot').classList.toggle('on', connected);
  $('#conn-text').textContent = message;
  if (connected) syncPopupFocus();
});

// A browser-hosted display reads to the OS as "Chrome focused", which would otherwise drop the keys
// back to app-launch mode the moment you click one. Telling the backend it has focus keeps the
// developer layer up. The native panel does not report, because it never takes foreground.
function syncPopupFocus() {
  if (!isBrowserPopup || !client.token || !document.hasFocus() || focusReported) return;
  focusReported = true;
  client.popupFocus(true).catch(() => { focusReported = false; });
}

if (isBrowserPopup) {
  window.addEventListener('focus', () => { focusReported = false; syncPopupFocus(); });
  window.addEventListener('blur', () => { if (client.token) client.popupFocus(false).catch(() => {}); focusReported = false; });
  window.addEventListener('pagehide', () => { if (client.token) client.popupFocus(false).catch(() => {}); });
}

client.connect();
