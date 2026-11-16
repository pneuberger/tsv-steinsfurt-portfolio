/**
 * Committee form for invite links (/admin/, staging only).
 * Talks to /api/invites (Lambda behind CloudFront). The password is kept in
 * sessionStorage only (gone when the tab is closed) and sent as x-admin-password.
 * All user-provided values are rendered with textContent – never as HTML.
 */
const PW_KEY = 'tsv-admin-pw';
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

const loginForm = $<HTMLFormElement>('#login');
const app = $('#app');
const createForm = $<HTMLFormElement>('#create');
const result = $('#result');
const tbody = $('#invites');

type Invite = {
  id: string; name: string; createdBy?: string; createdAt: number; expiresAt: number;
  revoked: boolean; revokedAt?: number; effectiveAt?: number;
};
type Check = { id: string; effective: boolean; revokedAt?: number; effectiveAt?: number };

// A revocation needs ~20–60 s to reach all CloudFront edge locations. While it is on its way
// the list shows "Sperre wird aktiv …" and asks the API every few seconds whether the link is
// already rejected. Revocations older than this (or from before the check existed) count as done.
const CHECK_EVERY_MS = 5000;
const GIVE_UP_AFTER_S = 5 * 60;
const nowS = () => Math.floor(Date.now() / 1000);
const pending = (inv: Invite) =>
  inv.revoked && !inv.effectiveAt && !!inv.revokedAt && nowS() - inv.revokedAt < GIVE_UP_AFTER_S;
let pollTimer: number | undefined;

const fmtDate = (s: number) =>
  new Date(s * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function showMsg(el: HTMLElement, text: string, ok = false) {
  el.textContent = text;
  el.classList.toggle('ok', ok);
  el.hidden = !text;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'x-admin-password': sessionStorage.getItem(PW_KEY) ?? '',
    // CloudFront Origin Access Control signs requests to the Lambda URL and needs the body hash.
    'x-amz-content-sha256': await sha256Hex(payload),
  };
  if (payload) headers['content-type'] = 'application/json';
  const unreachable = 'Der Dienst ist gerade nicht erreichbar. Bitte später noch einmal versuchen.';
  const res = await fetch(path, { method, headers, body: payload || undefined, cache: 'no-store' }).catch(() => {
    throw new Error(unreachable);
  });
  const data = await res.json().catch(() => null);
  if (data === null) throw new Error(unreachable); // no JSON → API not reached (e.g. local preview)
  if (res.status === 401) {
    sessionStorage.removeItem(PW_KEY);
    throw Object.assign(new Error('Falsches Passwort'), { status: 401 });
  }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Fehler ${res.status}`);
  return data as T;
}

function statusOf(inv: Invite): ['active' | 'expired' | 'revoked' | 'pending', string] {
  if (pending(inv)) return ['pending', 'Sperre wird aktiv …'];
  if (inv.revoked) {
    const took = inv.effectiveAt && inv.revokedAt ? ` (nach ${Math.max(1, inv.effectiveAt - inv.revokedAt)} s)` : '';
    return ['revoked', `gesperrt ✓${took}`];
  }
  if (inv.expiresAt * 1000 < Date.now()) return ['expired', 'abgelaufen'];
  return ['active', 'aktiv'];
}

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function loadList() {
  const msg = $('#list-msg');
  showMsg(msg, '');
  try {
    const invites = await api<Invite[]>('GET', '/api/invites');
    tbody.replaceChildren(
      ...invites.map((inv) => {
        const tr = document.createElement('tr');
        const [key, label] = statusOf(inv);
        const status = document.createElement('span');
        status.className = `status status-${key}`;
        status.textContent = label;
        if (key === 'pending') status.title = 'Die Sperre wird gerade an alle CloudFront-Standorte verteilt (meist unter einer Minute).';
        const statusTd = document.createElement('td');
        statusTd.append(status);
        const actionTd = document.createElement('td');
        if (key === 'active') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'revoke';
          btn.textContent = 'Sperren';
          btn.addEventListener('click', () => revoke(inv));
          actionTd.append(btn);
        }
        tr.append(cell(inv.name), cell(inv.createdBy || '–'), cell(fmtDate(inv.createdAt)), cell(fmtDate(inv.expiresAt)), statusTd, actionTd);
        return tr;
      }),
    );
    $('#empty').hidden = invites.length > 0;
    schedulePoll(invites);
  } catch (e) {
    if ((e as { status?: number }).status === 401) return logout('Bitte erneut anmelden.');
    showMsg(msg, (e as Error).message);
  }
}

/** While a revocation is on its way: check it every few seconds, then refresh the list. */
function schedulePoll(invites: Invite[]) {
  window.clearTimeout(pollTimer);
  const waiting = invites.filter(pending);
  if (!waiting.length || app.hidden) return;
  pollTimer = window.setTimeout(async () => {
    try {
      const results = await Promise.all(waiting.map((inv) => api<Check>('GET', `/api/invites/${encodeURIComponent(inv.id)}/check`)));
      if (results.some((r) => r.effective)) return loadList();
    } catch {
      /* temporary error: just try again */
    }
    schedulePoll(invites.filter(pending)); // re-filter: entries older than GIVE_UP_AFTER_S drop out
  }, CHECK_EVERY_MS);
}

async function revoke(inv: Invite) {
  if (!confirm(`Link für „${inv.name}“ wirklich sperren? Das lässt sich nicht rückgängig machen.`)) return;
  try {
    await api('POST', `/api/invites/${encodeURIComponent(inv.id)}/revoke`);
    await loadList();
  } catch (e) {
    showMsg($('#list-msg'), (e as Error).message);
  }
}

function showResult(name: string, link: string, expiresAt: number) {
  $('[data-name]', result).textContent = name;
  $('[data-expires]', result).textContent = fmtDate(expiresAt);
  const input = $<HTMLInputElement>('[data-link]', result);
  input.value = link;
  const text = `Hallo ${name}, hier ist dein persönlicher Link zum TSV Phönix Steinsfurt – schau mal rein: ${link} (gültig bis ${fmtDate(expiresAt)})`;
  $<HTMLAnchorElement>('[data-whatsapp]', result).href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function logout(message = '') {
  window.clearTimeout(pollTimer);
  sessionStorage.removeItem(PW_KEY);
  app.hidden = true;
  result.hidden = true;
  loginForm.hidden = false;
  showMsg($('.msg', loginForm), message);
}

loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('.msg', loginForm);
  const pw = (new FormData(loginForm).get('password') as string) ?? '';
  sessionStorage.setItem(PW_KEY, pw);
  showMsg(msg, 'Prüfe …', true);
  try {
    await api('GET', '/api/invites');
    loginForm.reset();
    loginForm.hidden = true;
    app.hidden = false;
    showMsg(msg, '');
    await loadList();
  } catch (e) {
    showMsg(msg, (e as Error).message);
  }
});

createForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('.msg', createForm);
  const fd = new FormData(createForm);
  showMsg(msg, 'Erstelle Link …', true);
  try {
    const res = await api<{ token: string; expiresAt: number }>('POST', '/api/invites', {
      name: fd.get('name'),
      days: Number(fd.get('days')),
      createdBy: fd.get('createdBy'),
    });
    const name = String(fd.get('name')).trim();
    showResult(name, `${location.origin}/?t=${res.token}`, res.expiresAt);
    $<HTMLInputElement>('input[name="name"]', createForm).value = '';
    showMsg(msg, '');
    await loadList();
  } catch (e) {
    if ((e as { status?: number }).status === 401) return logout('Bitte erneut anmelden.');
    showMsg(msg, (e as Error).message);
  }
});

$('[data-copy]', result).addEventListener('click', async (ev) => {
  const btn = ev.currentTarget as HTMLButtonElement;
  const input = $<HTMLInputElement>('[data-link]', result);
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select(); // fallback: let the user copy manually
  }
  btn.textContent = 'Kopiert ✓';
  setTimeout(() => (btn.textContent = 'Link kopieren'), 2000);
});

$('#reload').addEventListener('click', () => loadList());
$('#logout').addEventListener('click', () => logout());

// Still logged in from earlier in this tab?
if (sessionStorage.getItem(PW_KEY)) {
  loginForm.hidden = true;
  app.hidden = false;
  loadList();
}
