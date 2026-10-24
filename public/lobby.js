// Page 1: pick a server and a name, then head into the woods.
import { $, api, esc, fireflies, NUM, pathHtml, slugify, store } from './common.js';

const params = new URLSearchParams(location.search);
$('server').value = params.get('server') || store.get('bbb:lastServer') || '';
$('name').value = store.get('bbb:name') || '';
if (params.get('error')) $('err').textContent = params.get('error');
$('path').innerHTML = pathHtml(0);

function hint() {
  const slug = slugify($('server').value);
  $('serverHint').textContent = slug
    ? `you'll join "${slug}". friends who type the same name land in the same tale`
    : 'friends who type the same name land in the same tale';
}
$('server').addEventListener('input', hint);
hint();

let castShown = false;
async function refresh() {
  try {
    const { servers, cast, wolf } = await api('/api/servers');
    if (!castShown) {
      castShown = true;
      $('cast').innerHTML = cast.map((c) => `<div class="c" aria-disabled="true">
        <span class="seal" style="background:${c.color}">${esc(c.name[0].toUpperCase())}</span>
        <span class="nm">${esc(c.name)}<span class="rl">${esc(c.role)} · ${esc(c.voice)}</span></span><span></span></div>`).join('');
      if (wolf !== 'muse') $('wolfKind').textContent = 'a scripted wolf (no Muse key on this server)';
    }
    $('serversNote').textContent = servers.length
      ? 'lit windows in the woods. tap one to join it, or name a new one below.'
      : 'no tales are being told yet. name a server below to start one.';
    $('servers').innerHTML = servers.map((s) => {
      const midTale = s.phase !== 'lobby';
      return `<button type="button" class="chip" data-s="${esc(s.slug)}" ${midTale ? 'disabled' : ''}>${esc(s.slug)}<small>${
        midTale ? 'mid-tale' : `${NUM[s.players] ?? s.players} at the door`}</small></button>`;
    }).join('');
    $('servers').querySelectorAll('[data-s]').forEach((b) => b.onclick = () => {
      $('server').value = b.dataset.s;
      hint();
      $('name').focus();
    });
  } catch {
    $('serversNote').textContent = 'the woods are dark right now. you can still name a server below.';
  }
}
refresh();
setInterval(refresh, 4000);

$('join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const server = slugify($('server').value);
  const name = $('name').value.trim();
  if (server.length < 2) return void ($('err').textContent = 'Give the server a name: at least two letters or numbers.');
  if (!name) return void ($('err').textContent = 'Tell us your name first.');
  $('err').textContent = '';
  $('go').disabled = true;
  try {
    const res = await api('/api/join', { server, name, token: store.get(`bbb:${server}`)?.token });
    store.set(`bbb:${res.slug}`, { token: res.token, name: res.name });
    store.set('bbb:name', res.name);
    store.set('bbb:lastServer', res.slug);
    location.href = `/game?server=${encodeURIComponent(res.slug)}`;
  } catch (err) {
    $('err').textContent = err.message;
    $('go').disabled = false;
  }
});

fireflies();
