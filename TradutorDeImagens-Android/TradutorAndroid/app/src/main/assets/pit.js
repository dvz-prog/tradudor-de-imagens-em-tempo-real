// Tradutor de Imagens ao Vivo (Android) — script injetado no WebView.
// Mesma lógica da extensão: baixa a imagem (via app) -> fatia -> OCR -> agrupa em balões
// -> cor de fundo -> traduz -> desenha por cima da imagem, na própria página.
(() => {
  if (window.__pitLoaded || typeof PitNative === 'undefined') return;
  window.__pitLoaded = true;

  const MAX_W = 1400, SLICE_H = 2000, MAX_BYTES = 950 * 1024;
  const MIN_W = 150, MIN_H = 80, MAX_PARALLEL = 2;

  // ---------- ajustes ----------
  let S = { target: 'pt', source: 'auto', apiKey: '', autoHosts: {} };
  function loadSettings() {
    try { S = Object.assign(S, JSON.parse(PitNative.settings())); } catch (_) {}
  }
  loadSettings();
  const host = location.hostname;
  const autoOn = () => !!(S.autoHosts && S.autoHosts[host]);

  // ---------- ponte com o app ----------
  const pend = new Map();
  let seq = 1;
  window.__pitRes = (id, ok, payload) => {
    const f = pend.get(id);
    if (!f) return;
    pend.delete(id);
    ok ? f.ok(payload) : f.no(new Error(payload));
  };
  const native = (method, a, b, c) => new Promise((ok, no) => {
    const id = seq++;
    pend.set(id, { ok, no });
    PitNative.call(id, method, a || '', b || '', c || '');
  });

  // ---------- utilidades ----------
  const memCache = new Map();
  const inflight = new Map();

  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const canvasBlob = (c, q) => new Promise((ok, no) =>
    c.toBlob((b) => (b ? ok(b) : no(new Error('Falha ao preparar a imagem'))), 'image/jpeg', q));
  const blobToDataUrl = (blob) => new Promise((ok, no) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = () => no(fr.error);
    fr.readAsDataURL(blob);
  });
  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  // ---------- pipeline de tradução ----------
  async function translateImage(src) {
    const key = `${S.target}|${S.source}|${hash(src)}`;
    if (memCache.has(key)) return memCache.get(key);
    const disk = PitNative.cacheGet('c' + hash(key));
    if (disk) { try { const v = JSON.parse(disk); memCache.set(key, v); return v; } catch (_) {} }
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      let blob;
      if (/^(blob:|data:)/.test(src)) {
        blob = await (await fetch(src)).blob();
      } else {
        const res = await native('image', src, location.href);
        const i = res.indexOf('|');
        blob = b64ToBlob(res.slice(i + 1), res.slice(0, i));
      }
      const bmp = await createImageBitmap(blob);
      const raw = await ocrBitmap(bmp);
      bmp.close && bmp.close();
      const blocks = await translateBlocks(raw, S.target);
      memCache.set(key, blocks);
      try { PitNative.cacheSet('c' + hash(key), JSON.stringify(blocks)); } catch (_) {}
      return blocks;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  async function ocrBitmap(bmp) {
    const scale = Math.min(1, MAX_W / bmp.width);
    const W = Math.max(1, Math.round(bmp.width * scale));
    const H = Math.max(1, Math.round(bmp.height * scale));
    const out = [];
    let top = 0;
    while (top < H) {
      let end = Math.min(H, top + SLICE_H);
      if (end < H) end = findCut(bmp, scale, top, end);
      const h = end - top;

      const canvas = mkCanvas(W, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, h);
      ctx.drawImage(bmp, 0, top / scale, bmp.width, h / scale, 0, 0, W, h);

      const lines = await ocrSlice(canvas);
      for (const b of clusterLines(lines)) {
        const pad = 3;
        b.l = Math.max(0, b.l - pad); b.t = Math.max(0, b.t - pad);
        b.r = Math.min(W, b.r + pad); b.b = Math.min(h, b.b + pad);
        const bg = sampleBg(ctx, b, W, h);
        const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
        out.push({
          x: b.l / W, y: (b.t + top) / H, w: (b.r - b.l) / W, h: (b.b - b.t) / H,
          text: b.text, vertical: b.vertical,
          bg: `rgb(${bg[0]},${bg[1]},${bg[2]})`, fg: lum > 140 ? '#111' : '#fff'
        });
      }
      top = end;
    }
    return out;
  }

  // Procura a linha mais "vazia" perto do corte para não partir um balão ao meio.
  function findCut(bmp, scale, top, nominalEnd) {
    const bandTop = Math.max(top + 600, nominalEnd - 350);
    const bandH = nominalEnd - bandTop;
    if (bandH < 20) return nominalEnd;
    const cw = 200;
    const c = mkCanvas(cw, bandH);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, bandTop / scale, bmp.width, bandH / scale, 0, 0, cw, bandH);
    const d = ctx.getImageData(0, 0, cw, bandH).data;
    let bestRow = bandH - 1, bestVar = Infinity;
    for (let y = 0; y < bandH; y++) {
      let sum = 0, sum2 = 0;
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += l; sum2 += l * l;
      }
      const mean = sum / cw;
      const v = sum2 / cw - mean * mean;
      if (v <= bestVar) { bestVar = v; bestRow = y; }
    }
    return bandTop + bestRow + 1;
  }

  async function ocrSlice(canvas) {
    let blob = null;
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      blob = await canvasBlob(canvas, q);
      if (blob.size < MAX_BYTES) break;
    }
    const dataUrl = await blobToDataUrl(blob);
    const cjk = ['jpn', 'kor', 'chs', 'cht'].includes(S.source);
    const engines = S.source === 'auto' ? [2] : cjk ? [1, 2] : [2, 1];
    let lastErr = null;
    for (const eng of engines) {
      try {
        const txt = await native('ocr', dataUrl, S.apiKey || 'helloworld', S.source + '|' + eng);
        const data = JSON.parse(txt);
        if (data.IsErroredOnProcessing) {
          const m = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(' ') : data.ErrorMessage;
          throw new Error(m || 'Erro no OCR');
        }
        const lines = [];
        for (const pr of data.ParsedResults || []) {
          for (const ln of (pr.TextOverlay && pr.TextOverlay.Lines) || []) {
            const words = ln.Words || [];
            if (!words.length) continue;
            let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
            for (const w of words) {
              l = Math.min(l, w.Left); t = Math.min(t, w.Top);
              r = Math.max(r, w.Left + w.Width); b = Math.max(b, w.Top + w.Height);
            }
            const text = (ln.LineText || '').trim();
            if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
            if (r - l < 6 || b - t < 6) continue;
            lines.push({ l, t, r, b, text });
          }
        }
        return lines;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Falha no OCR');
  }

  function clusterLines(lines) {
    const n = lines.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const thick = (a) => Math.min(a.r - a.l, a.b - a.t);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = lines[i], b = lines[j];
        const ta = thick(a), tb = thick(b);
        const ratio = ta / tb;
        if (ratio < 0.5 || ratio > 2) continue;
        const pad = 0.7 * Math.min(ta, tb);
        const overlap = a.l - pad < b.r && b.l - pad < a.r && a.t - pad < b.b && b.t - pad < a.b;
        if (overlap) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    lines.forEach((ln, i) => {
      const g = find(i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ln);
    });
    const blocks = [];
    for (const g of groups.values()) {
      const vert = g.filter((x) => x.b - x.t > 2 * (x.r - x.l)).length > g.length / 2;
      g.sort(vert
        ? (a, b) => (b.l + b.r) / 2 - (a.l + a.r) / 2 || a.t - b.t
        : (a, b) => (a.t + a.b) / 2 - (b.t + b.b) / 2 || a.l - b.l);
      const raw = g.map((x) => x.text);
      const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(raw.join(''));
      const text = raw.join(vert || cjk ? '' : ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 2) continue;
      blocks.push({
        l: Math.min(...g.map((x) => x.l)), t: Math.min(...g.map((x) => x.t)),
        r: Math.max(...g.map((x) => x.r)), b: Math.max(...g.map((x) => x.b)),
        text, vertical: vert
      });
    }
    return blocks;
  }

  function sampleBg(ctx, b, W, H) {
    const x0 = Math.max(0, Math.floor(b.l)), y0 = Math.max(0, Math.floor(b.t));
    const x1 = Math.min(W, Math.ceil(b.r)), y1 = Math.min(H, Math.ceil(b.b));
    const w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return [255, 255, 255];
    const d = ctx.getImageData(x0, y0, w, h).data;
    const buckets = new Map();
    const add = (x, y) => {
      const i = (y * w + x) * 4;
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (bl >> 5);
      let e = buckets.get(k);
      if (!e) { e = [0, 0, 0, 0]; buckets.set(k, e); }
      e[0] += r; e[1] += g; e[2] += bl; e[3]++;
    };
    for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
    let best = null;
    for (const e of buckets.values()) if (!best || e[3] > best[3]) best = e;
    return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])];
  }

  async function translateBlocks(blocks, target) {
    const res = await pool(blocks, 4, async (b) => {
      const t = await translateText(b.text, target);
      if (!t || t.trim().toLowerCase() === b.text.trim().toLowerCase()) return null;
      return { ...b, text: t };
    });
    return res.filter(Boolean);
  }

  async function translateText(text, tl) {
    const d = JSON.parse(await native('translate', text, tl));
    return (d[0] || []).map((x) => x[0]).join('');
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
          const k = i++;
          out[k] = await fn(items[k]).catch(() => null);
        }
      })
    );
    return out;
  }

  // ---------- detecção de imagens ----------
  const recs = new WeakMap();
  const active = new Set();
  const observed = new WeakSet();
  const suppressed = new WeakSet();
  const queue = [];
  let running = 0;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && autoOn()) request(e.target);
  }, { rootMargin: '400px 0px' });

  function observe(img) {
    if (observed.has(img)) return;
    observed.add(img);
    io.observe(img);
    img.addEventListener('load', () => { if (autoOn() && nearViewport(img, 400)) request(img); });
  }
  function scan() { document.querySelectorAll('img').forEach(observe); }
  scan();

  let scanTimer = null;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  function nearViewport(img, margin) {
    const r = img.getBoundingClientRect();
    return r.bottom > -margin && r.top < innerHeight + margin && r.right > 0 && r.left < innerWidth;
  }
  function eligible(img) {
    if (!img.complete || !img.naturalWidth) return false;
    const r = img.getBoundingClientRect();
    return r.width >= MIN_W && r.height >= MIN_H;
  }

  // ---------- fila ----------
  function request(img, force = false, manual = false) {
    const src = img.currentSrc || img.src;
    if (!src) return;
    if (!force && suppressed.has(img)) return;
    if (force) suppressed.delete(img);
    let r = recs.get(img);
    if (r && r.src === src && !force) return;
    if (!force && !eligible(img)) return;
    if (r) destroy(r);
    r = { img, src, state: 'queued', manual: manual || force, blocks: [], hidden: false, dead: false, w: 0, h: 0 };
    recs.set(img, r);
    active.add(r);
    makeRoot(r);
    setBadge(r, '⏳ Na fila…');
    position(r);
    queue.push(r);
    pump();
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const r = queue.shift();
      if (r.dead) continue;
      running++;
      run(r).finally(() => { running--; pump(); });
    }
  }

  async function run(r) {
    r.state = 'loading';
    setBadge(r, '🌐 Traduzindo…');
    try {
      const blocks = await translateImage(r.src);
      if (r.dead) return;
      r.blocks = blocks || [];
      r.state = 'done';
      render(r);
      if (r.blocks.length) setBadge(r, '✓ ' + r.blocks.length + ' trecho(s)', 1800);
      else setBadge(r, 'Nenhum texto encontrado', 2500);
    } catch (e) {
      if (r.dead) return;
      r.state = 'error';
      setBadge(r, '⚠ ' + shortErr(e) + ' — toque para tentar de novo', 0, true);
    }
  }
  const shortErr = (e) => String((e && e.message) || e).slice(0, 90);

  // ---------- overlay ----------
  function makeRoot(r) {
    const root = document.createElement('div');
    root.className = 'pit-root';
    const layer = document.createElement('div');
    layer.className = 'pit-layer';
    const badge = document.createElement('div');
    badge.className = 'pit-badge';
    badge.style.display = 'none';
    const toggle = document.createElement('button');
    toggle.className = 'pit-toggle';
    toggle.type = 'button';
    toggle.textContent = 'T';
    toggle.title = 'Mostrar/ocultar a tradução';
    toggle.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      r.hidden = !r.hidden;
      layer.style.visibility = r.hidden ? 'hidden' : 'visible';
    });
    badge.addEventListener('click', (ev) => {
      if (r.state === 'error') { ev.preventDefault(); ev.stopPropagation(); request(r.img, true, true); }
    });
    root.append(layer, badge, toggle);
    document.documentElement.appendChild(root);
    r.root = root; r.layer = layer; r.badge = badge; r.toggle = toggle;
    toggle.style.display = 'none';
  }

  function setBadge(r, text, hideAfter = 0, clickable = false) {
    const b = r.badge;
    if (!b) return;
    clearTimeout(r.badgeTimer);
    b.textContent = text;
    b.style.display = 'block';
    b.style.opacity = '1';
    b.classList.toggle('pit-click', clickable);
    if (hideAfter) {
      r.badgeTimer = setTimeout(() => {
        b.style.opacity = '0';
        setTimeout(() => { if (b.style.opacity === '0') b.style.display = 'none'; }, 450);
      }, hideAfter);
    }
  }

  function render(r) {
    r.layer.textContent = '';
    r.els = [];
    for (const b of r.blocks) {
      const el = document.createElement('div');
      el.className = 'pit-block';
      el.style.background = b.bg;
      el.style.color = b.fg;
      el.style.boxShadow = `0 0 4px 2px ${b.bg}`;
      const sp = document.createElement('span');
      sp.textContent = b.text;
      el.appendChild(sp);
      r.layer.appendChild(el);
      r.els.push({ el, sp, b });
    }
    r.toggle.style.display = r.blocks.length ? 'block' : 'none';
    r.w = r.h = 0;
    position(r);
  }

  function position(r) {
    const img = r.img;
    if (!img.isConnected) return;
    const rect = img.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) { r.root.style.display = 'none'; return; }
    r.root.style.display = 'block';
    const left = rect.left + scrollX, top = rect.top + scrollY;
    const s = r.root.style;
    s.left = left + 'px'; s.top = top + 'px';
    s.width = rect.width + 'px'; s.height = rect.height + 'px';
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if ((w !== r.w || h !== r.h) && r.els) {
      r.w = w; r.h = h;
      fitAll(r, w, h);
    }
  }

  function fitAll(r, LW, LH) {
    for (const { el, sp, b } of r.els) {
      let scale = 1;
      for (let k = 0; k < 4; k++) {
        const w = Math.min(LW, b.w * LW * scale);
        const h = Math.min(LH, b.h * LH * scale);
        const cx = (b.x + b.w / 2) * LW, cy = (b.y + b.h / 2) * LH;
        const left = Math.min(Math.max(0, cx - w / 2), LW - w);
        const top = Math.min(Math.max(0, cy - h / 2), LH - h);
        el.style.left = left + 'px'; el.style.top = top + 'px';
        el.style.width = w + 'px'; el.style.height = h + 'px';
        const fs = fitFont(el, sp);
        if (fs >= 12) break;
        scale *= 1.3;
      }
    }
  }

  function fitFont(el, sp) {
    let lo = 6, hi = Math.min(44, Math.max(8, el.clientHeight));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      sp.style.fontSize = mid + 'px';
      if (sp.offsetHeight <= el.clientHeight) lo = mid; else hi = mid - 1;
    }
    sp.style.fontSize = lo + 'px';
    return lo;
  }

  function destroy(r) {
    r.dead = true;
    clearTimeout(r.badgeTimer);
    if (r.root) r.root.remove();
    active.delete(r);
    if (recs.get(r.img) === r) recs.delete(r.img);
  }

  // ---------- manter o overlay colado na imagem ----------
  let raf = 0;
  const positionAll = () => { raf = 0; for (const r of active) position(r); };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(positionAll); };
  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', schedule, { passive: true });

  setInterval(() => {
    for (const r of [...active]) {
      if (!r.img.isConnected) { destroy(r); continue; }
      const cur = r.img.currentSrc || r.img.src;
      if (cur && cur !== r.src && r.img.complete) {
        const manual = r.manual, img = r.img;
        destroy(r);
        if (autoOn() || manual) request(img, false, manual);
        continue;
      }
      position(r);
    }
  }, 400);

  // ---------- comandos vindos do app ----------
  window.__pitCmd = (type, arg) => {
    if (type === 'translateAll') {
      document.querySelectorAll('img').forEach((img) => {
        suppressed.delete(img);
        if (nearViewport(img, 1500)) request(img, false, true);
      });
    } else if (type === 'translateSrc') {
      document.querySelectorAll('img').forEach((img) => {
        if ((img.currentSrc || img.src) === arg) request(img, true, true);
      });
    } else if (type === 'clear') {
      for (const r of [...active]) { suppressed.add(r.img); destroy(r); }
      queue.length = 0;
    } else if (type === 'toggleAll') {
      for (const r of active) {
        r.hidden = !r.hidden;
        if (r.layer) r.layer.style.visibility = r.hidden ? 'hidden' : 'visible';
      }
    } else if (type === 'settings') {
      const was = autoOn();
      loadSettings();
      if (!was && autoOn()) scan();
      if (was && !autoOn()) {
        for (const r of [...active]) if (r.state === 'queued' && !r.manual) destroy(r);
      }
    }
  };

  // se a auto-tradução já está ligada neste site, começa pelas imagens visíveis
  if (autoOn()) document.querySelectorAll('img').forEach((img) => { if (nearViewport(img, 400)) request(img); });
})();
