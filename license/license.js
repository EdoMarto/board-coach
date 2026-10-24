// Board Coach licensing. Runs in the service worker; also loaded by the Node tests.
(function (root) {
  const GRACE_SEC = 2 * 86400; // keep working this long past expiry if the license server can't be reached

  const fromB64u = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  };

  async function importKey(spkiB64) {
    return crypto.subtle.importKey('spki', Uint8Array.from(atob(spkiB64), (c) => c.charCodeAt(0)),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }

  // A token is base64url(payload) + "." + base64url(signature), signed by the seller's private key.
  async function verifyToken(token, publicKey, device) {
    try {
      const [p, s] = String(token).split('.');
      if (!p || !s) return { ok: false, reason: 'format' };
      const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(publicKey), fromB64u(s), new TextEncoder().encode(p));
      if (!good) return { ok: false, reason: 'signature' };
      const payload = JSON.parse(new TextDecoder().decode(fromB64u(p)));
      if (payload.dev !== device) return { ok: false, reason: 'device' };
      return { ok: true, payload };
    } catch (_) { return { ok: false, reason: 'invalid' }; }
  }

  function create({ config, storage, fetchFn, now, version }) {
    const dev = !config.server || !config.publicKey;
    let cache = null;

    async function deviceId() {
      const s = await storage.get('cpaDevice');
      if (s.cpaDevice) return s.cpaDevice;
      const id = crypto.randomUUID();
      await storage.set({ cpaDevice: id });
      return id;
    }

    async function call(path, body) {
      const r = await fetchFn(config.server.replace(/\/$/, '') + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      let json = {};
      try { json = await r.json(); } catch (_) {}
      return { status: r.status, body: json };
    }

    const stored = async () => (await storage.get('cpaLicense')).cpaLicense || null;
    const save = async (lic) => { await storage.set({ cpaLicense: lic }); cache = null; };

    // Asks the server for a fresh token. Returns 'ok', 'network' (can't tell) or an error code (denied).
    async function fetchToken(key, device) {
      let res;
      try { res = await call('/activate', { key, device, version }); } catch (_) { return { result: 'network' }; }
      if (res.status >= 500 || res.status === 429) return { result: 'network' };
      if (res.status !== 200 || !res.body.token) return { result: res.body.error || 'server' };
      const v = await verifyToken(res.body.token, config.publicKey, device);
      if (!v.ok) return { result: 'bad_token' };
      return { result: 'ok', token: res.body.token, name: v.payload.name, latest: res.body.latest || null, updateUrl: res.body.updateUrl || null };
    }

    async function activate(key) {
      if (dev) return { ok: true, state: 'dev' };
      key = String(key || '').trim().toUpperCase();
      if (!key) return { ok: false, error: 'empty' };
      const r = await fetchToken(key, await deviceId());
      if (r.result !== 'ok') return { ok: false, error: r.result };
      await save({ key, token: r.token, name: r.name, latest: r.latest, updateUrl: r.updateUrl });
      return { ok: true, state: 'ok', name: r.name };
    }

    // Is the extension allowed to work right now? Refreshes the token in the background when it gets old.
    async function ensure() {
      if (dev) return true;
      if (cache && cache.until > now()) return cache.ok;
      const lic = await stored();
      const device = await deviceId();
      let ok = false;
      if (lic && lic.token) {
        const v = await verifyToken(lic.token, config.publicKey, device);
        if (v.ok) {
          const { iat, exp } = v.payload, t = now();
          if (t < exp && t < iat + (exp - iat) / 3) ok = true; // still fresh
          else {
            const r = await fetchToken(lic.key, device);
            if (r.result === 'ok') {
              await save({ key: lic.key, token: r.token, name: r.name, latest: r.latest, updateUrl: r.updateUrl });
              ok = true;
            } else if (r.result === 'network') ok = t < exp + GRACE_SEC;
            else { await save({ key: lic.key, token: null, name: lic.name, denied: r.result }); ok = false; }
          }
        }
      }
      cache = { ok, until: now() + 60 };
      return ok;
    }

    async function status() {
      if (dev) return { devMode: true, ok: true };
      const ok = await ensure();
      const lic = await stored();
      return { ok, name: lic && lic.name, latest: lic && lic.latest, updateUrl: lic && lic.updateUrl, denied: lic && lic.denied };
    }

    async function remove() {
      if (dev) return { ok: true };
      const lic = await stored();
      if (lic && lic.key) { try { await call('/deactivate', { key: lic.key, device: await deviceId() }); } catch (_) {} }
      await storage.remove('cpaLicense');
      cache = null;
      return { ok: true };
    }

    return { activate, ensure, status, remove, deviceId };
  }

  root.CPA_LICENSE = { create, verifyToken };
  if (typeof module !== 'undefined') module.exports = root.CPA_LICENSE;
})(typeof self !== 'undefined' ? self : globalThis);
