// Page 2: the tale itself. The server streams this player's view over SSE; every
// button here is one POST to /api/act, and the next view shows what happened.
import { $, api, esc, fireflies, NUM, PAW, pathHtml, slugify, store, WHERE } from './common.js';

const server = slugify(new URLSearchParams(location.search).get('server'));
const token = store.get(`bbb:${server}`)?.token;
if (!server || !token) location.replace(`/?server=${encodeURIComponent(server)}`);

const PALETTE = ['#9c3d6e', '#3b5f8f', '#3d6b4f', '#5d4a8a', '#a2621f', '#2f6f73', '#7a3b2e', '#6b6a2a'];
const CLOCK_NOTE = { warmup: 'to chat with the wolf', answer: 'to answer', discuss: 'to talk it over', vote: 'to choose' };

let V = null; // the latest view
let skew = 0; // server clock minus ours
let es = null;
let barSig = ''; // what the bar shows right now
let endShown = 0; // game whose ending is on the page
let pick = null; // a vote picked but not yet locked in
let tickedFor = null; // deadline we've already nudged
let flash = null; // a short-lived error under the chat
let flashTimer = 0;
let offline = false;
let lastTyping = 0;
let taleHtml = '';

const ini = (s) => s[0].toUpperCase();
const mySeat = () => V?.you.seat ?? -1;
const others = () => V.seats.filter((s) => s.seat !== mySeat());

// ---- the log (same shapes as the design) ----------------------------------------

function scroll() {
  const l = $('log');
  l.scrollTop = l.scrollHeight;
}
function sys(t) {
  const d = document.createElement('div');
  d.className = 'sys';
  d.textContent = t;
  $('log').append(d);
}
function chapter(label, q) {
  const d = document.createElement('div');
  d.className = 'chap';
  d.innerHTML = '<small></small><q></q>';
  d.querySelector('small').textContent = label;
  d.querySelector('q').textContent = q;
  $('log').append(d);
}
function say(m) {
  const d = document.createElement('div');
  d.dataset.seat = m.seat;
  if (m.seat === mySeat()) {
    d.className = 'msg me';
    d.innerHTML = '<span class="seal">R</span><div class="b"></div>';
    d.querySelector('.b').textContent = m.text;
  } else {
    const p = V.seats[m.seat];
    d.className = 'msg';
    d.innerHTML = `<span class="seal" style="background:${p.color}">${esc(ini(p.name))}</span><div class="b"><span class="who"></span><span class="tx"></span></div>`;
    d.querySelector('.who').textContent = `${p.name}, ${p.role}`;
    d.querySelector('.tx').textContent = m.text;
  }
  $('log').append(d);
}
function addMsg(m) {
  if (m.kind === 'sys') sys(m.text);
  else if (m.kind === 'chap') chapter(m.label, m.text);
  else say(m);
}

// ---- the warm-up chat: a private conversation with the wolf ----------------------

function renderWarm() {
  const log = $('log');
  let box = $('warm');
  if (V.phase !== 'warmup') return void box?.remove();
  if (!box) {
    box = document.createElement('div');
    box.id = 'warm';
    box.className = 'warm';
    log.append(box);
  }
  const lines = V.warm.lines;
  const sig = JSON.stringify(lines);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  box.innerHTML = `<div class="chap"><small>A quiet word</small><q>chat with the wolf like you would with a friend. it's learning how you text.</q></div>`
    + lines.map((l) => l.from === 'you'
      ? `<div class="msg me"><span class="seal">R</span><div class="b">${esc(l.text)}</div></div>`
      : `<div class="msg"><span class="seal wolfseal">W</span><div class="b"><span class="who">the wolf</span><span class="tx">${esc(l.text)}</span></div></div>`).join('');
  if (pinned) scroll();
}

// ---- the left page --------------------------------------------------------------

function renderTale() {
  const wolf = V.ai === 'muse' ? 'a <b>Muse Spark</b> agent' : 'a <b>scripted</b> wolf (this server has no Muse key)';
  let html;
  if (mySeat() < 0) {
    html = `Once upon a time, a few friends shared a group chat. Each of you is <b>Red</b>, and when the tale begins each of you hides behind a storybook name. But the wolf slips in first: ${wolf} that reads every message and wears a friend's voice like a borrowed nightgown. Answer three questions on the path, question anyone who seems off, then name the wolf.`;
  } else {
    const me = V.seats[mySeat()];
    html = `Once upon a time, ${NUM[V.seats.length - 1]} friends shared a group chat. You are <b>Red</b>, though the others know you as <b>${esc(me.name)}, ${esc(me.role)}</b>, who writes in ${esc(me.voice)}. But the wolf reached grandma's house first: ${wolf} that read every message and now wears one friend's name like a borrowed nightgown. Answer three questions on the path, question anyone who seems off, then name the wolf.`;
  }
  if (html !== taleHtml) $('tale').innerHTML = taleHtml = html;
}

function stopIndex() {
  if (V.phase === 'lobby' || V.phase === 'warmup') return 0;
  if (V.phase === 'vote' || V.phase === 'reveal') return 4;
  return V.chapter + 1;
}
function renderPath() {
  const stop = stopIndex();
  $('path').innerHTML = pathHtml(stop);
  $('where').textContent = WHERE[stop];
}

const susKey = () => `bbb:sus:${server}:${V.game}`;
function renderCast() {
  if (V.phase === 'lobby') {
    $('castTitle').textContent = 'The gathering';
    $('castNote').textContent = `${NUM[V.players.length] ?? V.players.length} at the cottage door`;
    $('cast').innerHTML = V.players.map((p, i) => `<div class="c ${p.online ? '' : 'out'}" aria-disabled="true">
      <span class="seal" style="background:${PALETTE[i % PALETTE.length]}">${esc(ini(p.name))}</span>
      <span class="nm">${esc(p.name)}<span class="rl">${p.host ? 'leads the way' : p.online ? 'at the door' : 'wandered off'}${p.name === V.you.name ? ' · you' : ''}</span></span><span></span></div>`).join('');
    return;
  }
  const reveal = V.phase === 'reveal';
  const sus = store.get(susKey()) || {};
  $('castTitle').textContent = 'The cast';
  $('castNote').textContent = reveal ? 'unmasked at last' : 'tap to mark your suspicion';
  const r = V.result;
  $('cast').innerHTML = others().map((s) => {
    const n = sus[s.seat] || 0;
    const out = reveal && r.accused === s.seat && !s.wolf;
    const line = reveal ? (s.wolf ? `${s.role} · the wolf` : `${s.role} · was ${s.player}`) : `${s.role} · ${s.voice}`;
    return `<button class="c ${out ? 'out' : ''}" data-id="${s.seat}" aria-label="Mark suspicion of ${esc(s.name)}, ${n} of 3">
      <span class="seal" style="background:${s.color}">${esc(ini(s.name))}</span>
      <span class="nm">${esc(s.name)}<span class="rl">${esc(line)}</span></span>
      <span class="paws">${[1, 2, 3].map((k) => PAW.replace('<svg', `<svg class="${n >= k ? 'on' : ''}"`)).join('')}</span></button>`;
  }).join('');
  $('cast').querySelectorAll('.c').forEach((b) => b.onclick = () => {
    const s = store.get(susKey()) || {};
    s[b.dataset.id] = ((s[b.dataset.id] || 0) + 1) % 4;
    store.set(susKey(), s);
    renderCast();
  });
}

// ---- the right page -------------------------------------------------------------

function renderHeader() {
  $('members').textContent = V.phase === 'lobby'
    ? `gathering at ${server}`
    : `${NUM[V.seats.length - 1]} friends & Red · ${server}`;
  $('clock').hidden = V.deadline === null;
  $('clockNote').textContent = CLOCK_NOTE[V.phase] ?? '';
  updateClock();
}

function updateClock() {
  if (!V || V.deadline === null) return;
  const left = Math.max(0, V.deadline - (Date.now() + skew));
  const s = Math.ceil(left / 1000);
  $('clockTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('clock').classList.toggle('low', s <= 10);
  // The candle is out: nudge the server along (any player may; it's idempotent).
  if (left <= 0 && tickedFor !== V.deadline) {
    tickedFor = V.deadline;
    setTimeout(() => act('tick'), 400);
  }
}
setInterval(updateClock, 250);

function renderTyping() {
  const t = $('typing');
  t.classList.toggle('err', !!flash);
  if (flash) return void (t.textContent = flash);
  if (offline) return void (t.textContent = 'the path went dark… finding it again');
  if (V?.phase === 'warmup' && V.warm.lines.at(-1)?.from === 'you') return void (t.textContent = 'the wolf is writing…');
  const names = V ? V.seats.filter((s) => s.typing && s.seat !== mySeat()).map((s) => s.name) : [];
  t.textContent = names.length === 0 ? ''
    : names.length === 1 ? `${names[0]} is writing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are writing…`
    : 'several friends are writing…';
}

function showError(message) {
  flash = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = null;
    renderTyping();
  }, 4500);
  renderTyping();
}

async function act(type, extra = {}) {
  try {
    await api('/api/act', { server, token, type, ...extra });
    return true;
  } catch (err) {
    if (err.status === 401) leaveTo(err.message);
    else if (type !== 'typing' && type !== 'tick') showError(err.message);
    return false;
  }
}

function leaveTo(reason) {
  es?.close();
  location.replace(`/?server=${encodeURIComponent(server)}${reason ? `&error=${encodeURIComponent(reason)}` : ''}`);
}

const form = (placeholder) =>
  `<form class="row" id="f"><input id="say" placeholder="${esc(placeholder)}" maxlength="280" autocomplete="off" aria-label="Message"><button class="btn ghost" type="submit">Send</button></form>`;
const tally = (n, need) => ` · ${n}/${need}`;

/** What the bar should show for this view, and how to wire it up. */
function barFor(v) {
  const y = v.you;
  const me = v.seats[y.seat];
  switch (v.phase) {
    case 'lobby': {
      const enough = v.players.length >= 2;
      const note = y.host
        ? enough ? 'everyone here? lead the way when you’re ready.' : 'waiting for at least one more friend to find the cottage…'
        : `waiting for ${esc(v.hostName)} to lead the way into the woods…`;
      return {
        sig: `lobby|${y.host}|${enough}|${v.hostName}`,
        html: `<div class="sys">${note}</div><div class="row">${y.host ? `<button class="btn" id="go" ${enough ? '' : 'disabled'}>Into the woods</button>` : ''}<button class="btn ghost" id="leave">Leave the cottage</button></div>`,
        bind() {
          $('go') && ($('go').onclick = () => act('start'));
          $('leave').onclick = async () => {
            await act('leave');
            location.href = '/';
          };
        },
      };
    }
    case 'warmup': {
      const w = v.warm;
      const sent = w.lines.filter((l) => l.from === 'you').length;
      const waiting = w.lines.at(-1)?.from === 'you';
      if (w.ready || (sent >= w.turns && !waiting)) {
        return {
          sig: `warm|done|${v.counts.warmed}`,
          html: `<div class="sys">the wolf has what it needs. waiting for the others… ${v.counts.warmed} of ${v.counts.players} done</div>`,
          bind() {},
        };
      }
      return {
        sig: `warm|${sent}|${waiting}|${sent >= w.min}`,
        html: `<form class="row" id="f"><input id="say" placeholder="${waiting ? 'the wolf is writing…' : 'say something to the wolf…'}" maxlength="280" autocomplete="off" aria-label="Message" ${waiting ? 'disabled' : ''}><button class="btn ghost" type="submit" ${waiting ? 'disabled' : ''}>Send</button></form>
          <div class="row"><span class="sys">${sent} of ${w.turns} messages</span>${sent >= w.min ? '<button class="btn" id="rdy" type="button">I’m ready</button>' : ''}</div>`,
        bind() {
          bindForm('warm');
          $('rdy') && ($('rdy').onclick = () => act('ready'));
        },
      };
    }
    case 'answer':
      if (!y.answered) {
        return {
          sig: `answer|${v.chapter}|open`,
          html: form(`answer as ${me.name} (${me.voice})…`),
          bind: bindForm,
        };
      }
      return {
        sig: `answer|${v.chapter}|done|${v.counts.answered}`,
        html: `<div class="sys">the others are answering… ${v.counts.answered} of ${v.seats.length} have answered</div>`,
        bind() {},
      };
    case 'discuss': {
      const last = v.chapter >= 2;
      const c = v.counts;
      const onward = y.host ? 'Onward' : `Onward${tally(c.onward, c.need)}`;
      const early = (last ? "Knock on grandma's door" : 'Name the wolf early') + (y.host ? '' : tally(c.early, c.need));
      return {
        sig: `discuss|${v.chapter}|${y.host}|${onward}|${early}|${y.onward}|${y.early}`,
        html: [
          `<div class="chips" role="group" aria-label="Question a friend">${others().map((s) => `<button class="chip" data-g="${s.seat}">question ${esc(s.name)}</button>`).join('')}</div>`,
          form(`write to the group as ${me.name}…`),
          `<div class="row">${last ? '' : `<button class="btn" id="nx" ${y.onward ? 'disabled' : ''}>${onward}</button>`}<button class="btn wolf" id="vt" ${y.early ? 'disabled' : ''}>${early}</button></div>`,
        ].join(''),
        bind() {
          bindForm();
          $('bar').querySelectorAll('[data-g]').forEach((b) => b.onclick = () => {
            const s = v.seats[Number(b.dataset.g)];
            const input = $('say');
            const at = `@${s.name} `;
            input.value = input.value.startsWith('@') ? at + input.value.replace(/^@\S+\s*/, '') : at + input.value;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          });
          $('nx') && ($('nx').onclick = () => act('onward'));
          $('vt').onclick = () => act('early');
        },
      };
    }
    case 'vote':
      if (y.vote === null) {
        return {
          sig: `vote|open|${pick}`,
          html: `<div class="chips" role="group" aria-label="Name the wolf">${others().map((s) => `<button class="chip ${pick === s.seat ? 'sel' : ''}" data-v="${s.seat}">${esc(s.name)}</button>`).join('')}</div>
            <div class="row"><button class="btn wolf" id="lk" ${pick === null ? 'disabled' : ''}>Pull back the covers</button></div>`,
          bind() {
            $('bar').querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
              pick = Number(b.dataset.v);
              renderBar();
            });
            $('lk').onclick = () => act('vote', { target: pick });
          },
        };
      }
      return {
        sig: `vote|done|${v.counts.voted}`,
        html: `<div class="sys">you named ${esc(v.seats[y.vote].name)}. ${v.counts.voted} of ${v.seats.length} have chosen…</div>`,
        bind() {},
      };
    case 'reveal':
      return {
        sig: `reveal|${v.game}`,
        html: `<div class="row"><button class="btn" id="again">Read it again (new wolf)</button><button class="btn ghost" id="leave">Leave the cottage</button></div>`,
        bind() {
          $('again').onclick = () => act('again');
          $('leave').onclick = async () => {
            await act('leave');
            location.href = '/';
          };
        },
      };
  }
}

function bindForm(type = 'say') {
  $('f').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('say');
    const text = input.value.trim();
    if (!text) return;
    if (await act(type, { text })) input.value = '';
  };
  $('say').oninput = () => {
    if (type === 'say' && Date.now() - lastTyping > 2500) {
      lastTyping = Date.now();
      act('typing');
    }
  };
}

function renderBar() {
  const { sig, html, bind } = barFor(V);
  if (sig === barSig) return;
  barSig = sig;
  // Keep whatever the player was in the middle of typing.
  const old = $('say');
  const draft = old?.value ?? '';
  const focused = old && document.activeElement === old;
  $('bar').innerHTML = html;
  bind();
  const input = $('say');
  if (input) {
    input.value = draft;
    if (focused || V.phase === 'answer' || (V.phase === 'warmup' && !input.disabled)) input.focus();
  }
}

function renderEnd() {
  if (V.phase !== 'reveal' || endShown === V.game) return;
  endShown = V.game;
  const r = V.result;
  const w = V.seats[r.wolfSeat];
  const accused = r.accused === null ? null : V.seats[r.accused];
  const unmasked = accused && (accused.seat === mySeat() ? 'you' : esc(accused.player));
  const title = r.humansWin
    ? `The woodcutter's axe was not needed. ${esc(w.name)} was the wolf.`
    : accused
    ? `Poor ${esc(accused.name)} was only ${unmasked}. The wolf was ${esc(w.name)}.`
    : `The village couldn't agree, and the wolf slipped away. It was ${esc(w.name)}.`;
  const votes = r.votes.map(([from, to]) => `${from === mySeat() ? 'you' : esc(V.seats[from].name)} → ${esc(V.seats[to].name)}`).join(', ');
  document.querySelectorAll(`#log .msg[data-seat="${r.wolfSeat}"]`).forEach((m) => m.classList.add('tell'));
  const d = document.createElement('div');
  d.className = 'end';
  d.innerHTML = `${$('howl').outerHTML.replace('id="howl"', '').replace(/class="howl[^"]*"/, '')}
    <h3>${title}</h3>
    <p>${V.ai === 'muse' ? 'Muse Spark' : 'The scripted wolf'} wore ${esc(w.name)}'s voice (${esc(w.voice)}). Its messages now glow gold above.</p>
    <ul>${r.tells.map((t) => `<li>${esc(t)}</li>`).join('')}${votes ? `<li>The votes: ${votes}.</li>` : '<li>Nobody voted before the candle went out.</li>'}</ul>
    <span class="fin">${r.humansWin ? 'Happily Ever After' : 'The End'}</span>`;
  $('log').append(d);
  scroll();
}

function render() {
  renderTale();
  renderPath();
  renderCast();
  renderHeader();
  renderTyping();
  renderBar();
  renderWarm();
  renderEnd();
  $('howl').classList.toggle('hunt', V.phase === 'vote' || V.phase === 'reveal');
}

function apply({ view, msgs, reset }) {
  skew = view.now - Date.now();
  V = view;
  const log = $('log');
  // Stay pinned to the newest message unless the player scrolled up to reread.
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  if (reset) {
    log.innerHTML = '';
    endShown = 0;
    barSig = '';
    pick = null;
  }
  if (view.phase !== 'vote') pick = null;
  for (const m of msgs) addMsg(m);
  render();
  // After render: the bar may have grown and pushed the log's bottom out of view.
  if (pinned || reset || msgs.some((m) => m.seat === mySeat())) scroll();
}

// ---- the stream -----------------------------------------------------------------

function connect() {
  es = new EventSource(`/api/events?server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}`);
  es.addEventListener('view', (e) => {
    offline = false;
    apply(JSON.parse(e.data));
  });
  es.addEventListener('gone', (e) => leaveTo(JSON.parse(e.data).reason));
  es.onerror = async () => {
    offline = true;
    renderTyping();
    if (es.readyState !== EventSource.CLOSED) return; // the browser retries by itself
    // The server turned the stream down. Find out whether we still belong here.
    const ok = await act('typing');
    if (ok) setTimeout(connect, 2000);
  };
}

if (server && token) {
  sys('finding the path to grandma’s house…');
  connect();
}
fireflies();
