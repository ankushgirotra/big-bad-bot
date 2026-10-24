// Shared by both pages: DOM helpers, the API, storage, and the forest's fireflies.

export const $ = (id) => document.getElementById(id);

export const PAW = '<svg viewBox="0 0 16 16"><ellipse cx="8" cy="10.5" rx="3.6" ry="3.2"/><circle cx="3.4" cy="6.4" r="1.6"/><circle cx="6.3" cy="3.6" r="1.6"/><circle cx="9.7" cy="3.6" r="1.6"/><circle cx="12.6" cy="6.4" r="1.6"/></svg>';

export const STOPS = [['⌂', 'Cottage'], ['I', 'Basket'], ['II', 'Brook'], ['III', 'Thicket'], ['✦', "Grandma's"]];
export const WHERE = ['at the cottage door', 'with the basket', 'at the brook', 'deep in the thicket', "at grandma's door"];
export const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Same rules as the server: "Grandma's House!" -> "grandmas-house". */
export const slugify = (raw) =>
  String(raw ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ']/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');

export function pathHtml(stop) {
  return STOPS.map(([m, l], i) => `<div class="stop ${i < stop ? 'done' : ''} ${i === stop ? 'here' : ''}"><i>${m}</i>${l}</div>`).join('');
}

// localStorage can be missing or throw (private windows, blocked storage).
export const store = {
  get(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* the game still works, it just won't remember */ }
  },
};

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The path is blocked (${res.status}).`), { status: res.status });
  return data;
}

export function fireflies() {
  for (let i = 0; i < 9; i++) {
    const f = document.createElement('span');
    f.className = 'fly';
    f.style.left = (5 + Math.random() * 90) + '%';
    f.style.top = (55 + Math.random() * 40) + '%';
    f.style.animationDelay = (-Math.random() * 7) + 's';
    document.body.append(f);
  }
}
