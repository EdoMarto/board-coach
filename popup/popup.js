const defaults = { suggest: 'engine', topN: 3, humanElo: 1200, verdicts: true, oppTurn: false, style: 'arrows', coach: true };
const $ = (s) => document.querySelector(s);
let S = { ...defaults };

function save(k, v) { S[k] = v; const o = { [k]: v }; if (k === 'suggest') o.coach = true; chrome.storage.sync.set(o); render(); }

function render() {
  for (const el of document.querySelectorAll('input[type=checkbox][data-set]')) el.checked = !!S[el.dataset.set];
  for (const el of document.querySelectorAll('input[type=range][data-set]')) el.value = S[el.dataset.set];
  for (const seg of document.querySelectorAll('[data-seg]')) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(String(S[seg.dataset.seg]) === b.dataset.v));
  }
  $('#humanEloOut').textContent = String(S.humanElo);
  const sug = S.suggest;
  for (const f of document.querySelectorAll('[data-show]')) {
    const w = f.dataset.show;
    f.hidden = sug === 'off' || (w === 'human' && sug !== 'human');
  }
}

chrome.storage.sync.get(defaults, (v) => {
  S = { ...defaults, ...v };
  if (v.coach === false && v.suggest === 'engine') S.suggest = 'off'; // older versions
  if (S.suggest === 'both') S.suggest = 'engine';
  render();
});

for (const el of document.querySelectorAll('input[type=checkbox][data-set]')) {
  el.addEventListener('change', () => save(el.dataset.set, el.checked));
}
for (const el of document.querySelectorAll('input[type=range][data-set]')) {
  el.addEventListener('input', () => { S[el.dataset.set] = +el.value; render(); });
  el.addEventListener('change', () => save(el.dataset.set, +el.value));
}
for (const seg of document.querySelectorAll('[data-seg]')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = seg.dataset.seg;
    save(k, k === 'topN' ? +b.dataset.v : b.dataset.v);
  });
}


// ---- License ----
const LIC_ERRORS = {
  empty: 'Enter your license key.',
  unknown_key: 'That key is not valid.',
  revoked: 'This license has been revoked.',
  device_limit: 'This key is already active on the maximum number of devices. Remove it from one of them first.',
  network: 'Could not reach the license server. Check your connection and try again.',
  too_many_attempts: 'Too many attempts. Try again later.',
  bad_token: 'The license server sent an invalid answer.'
};
const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
};
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (res) => r(res || { ok: false, error: 'network' })));

async function renderLicense() {
  const st = await send({ cmd: 'license-status' });
  const sec = $('#license');
  if (st.devMode) { sec.hidden = true; return; }
  sec.hidden = false;
  $('#licOk').hidden = !st.ok;
  $('#licNone').hidden = !!st.ok;
  if (st.ok) $('#licName').textContent = st.name || '';
  const msg = $('#licMsg');
  msg.hidden = true;
  if (!st.ok && st.denied) { msg.textContent = LIC_ERRORS[st.denied] || 'This license is no longer valid.'; msg.className = 'hint err'; msg.hidden = false; }
  const upd = $('#upd');
  const cur = chrome.runtime.getManifest().version;
  if (st.latest && newer(st.latest, cur)) {
    upd.textContent = 'Version ' + st.latest + ' is available' + (st.updateUrl ? ', tap to get it' : '');
    if (st.updateUrl) upd.href = st.updateUrl; else upd.removeAttribute('href');
    upd.hidden = false;
  }
}
$('#licGo').addEventListener('click', async () => {
  const btn = $('#licGo'), msg = $('#licMsg');
  btn.textContent = '…';
  const res = await send({ cmd: 'license-activate', key: $('#licKey').value });
  btn.textContent = 'Activate';
  if (res.ok) return renderLicense();
  msg.textContent = LIC_ERRORS[res.error] || 'Could not activate this license.';
  msg.className = 'hint err';
  msg.hidden = false;
});
$('#licKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#licGo').click(); });
$('#licRemove').addEventListener('click', async () => { await send({ cmd: 'license-remove' }); renderLicense(); });
renderLicense();
