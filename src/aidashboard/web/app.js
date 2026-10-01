(() => {
  'use strict';

  // ---------------------------------------------------------------- utilidades

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const decimal = (n, d) => n.toFixed(d).replace('.', ',');
  const fmtNum = n => n >= 1e6 ? decimal(n / 1e6, 1) + 'M' : n >= 1e3 ? decimal(n / 1e3, 1) + 'k' : String(Math.round(n));

  function fmtReset(epoch) {
    if (!epoch) return '';
    const s = epoch - Date.now() / 1000;
    if (s <= 0) return 'reiniciando';
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d > 0) return `↻ ${d}d ${h}h`;
    if (h > 0) return `↻ ${h}h${String(m).padStart(2, '0')}`;
    return `↻ ${m}min`;
  }

  // Peso visual: cache lido é barato e enorme, então conta pouco.
  const weighted = u => (u.output || 0) + (u.input || 0) + (u.cache_write || 0) + 0.1 * (u.cache_read || 0);

  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function fitText(c, s, maxW) {
    if (!s || maxW <= 0) return '';
    if (c.measureText(s).width <= maxW) return s;
    while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  const STATES = {
    working: { label: 'trabalhando', color: '#4fb3ff' },
    waiting: { label: 'aguardando você', color: '#f0a63a' },
    done: { label: 'finalizado', color: '#5ad17a' },
    compacting: { label: 'compactando contexto', color: '#b48cff' },
    error: { label: 'erro', color: '#ff5d5d' },
    idle: { label: 'pronto', color: '#8a94a6' },
  };
  const HUES = [205, 28, 150, 280, 52, 330, 180, 95];
  const TOKENS_PER_PEBBLE = 400;
  const MAX_PEBBLES = 450;

  // ---------------------------------------------------------------- estado

  const S = {
    sessions: new Map(),   // id -> sessão vinda do servidor
    anim: new Map(),       // id -> estado da animação da máquina
    limits: {},
    conn: 'off',           // off | live | demo | badtoken | notoken
    tokenLog: [],          // [segundos, peso] dos últimos 60s
    queue: [],             // pedras esperando para sair do bico
    pebbles: [],
    beltSpeed: 0,
    beltOffset: 0,
    releaseAcc: 0,
    level5: 0,
    level7: 0,
    started: false,
    dirty: true,
  };
  let hueIndex = 0;

  function animFor(id) {
    let a = S.anim.get(id);
    if (!a) {
      a = { hue: HUES[hueIndex++ % HUES.length], gear: 0, shake: 0, flash: 0, puffs: [], puffT: 0 };
      S.anim.set(id, a);
    }
    return a;
  }

  // ---------------------------------------------------------------- sons

  const Sound = {
    ctx: null,
    enabled: (() => { try { return localStorage.getItem('aid_mute') !== '1'; } catch { return true; } })(),
    unlock() {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback'; // ignora a chave de silencioso do iPhone
      } catch {}
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, t0, dur, type = 'sine', gain = 0.18) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    },
    play(kind) {
      if (!this.enabled || !this.ctx) return;
      const t = this.ctx.currentTime + 0.02;
      if (kind === 'waiting') {
        [0, 0.45].forEach(o => { this.tone(880, t + o, 0.16, 'triangle'); this.tone(660, t + o + 0.18, 0.24, 'triangle'); });
      } else if (kind === 'done') {
        [1046.5, 1318.5, 1568].forEach((f, i) => this.tone(f, t + i * 0.11, 0.7, 'sine', 0.14));
      } else if (kind === 'error') {
        this.tone(196, t, 0.35, 'sawtooth', 0.08);
        this.tone(147, t + 0.3, 0.45, 'sawtooth', 0.08);
      } else if (kind === 'start') {
        this.tone(523, t, 0.12, 'sine', 0.1);
        this.tone(784, t + 0.1, 0.18, 'sine', 0.1);
      }
    },
  };

  // ---------------------------------------------------------------- tela ligada

  const noSleep = window.NoSleep ? new window.NoSleep() : null;
  function keepAwake() {
    if (!noSleep) return;
    try { Promise.resolve(noSleep.enable()).catch(() => {}); } catch {}
  }

  // ---------------------------------------------------------------- mensagens

  function onTransition(prev, next) {
    if (!S.started || prev === next) return;
    if (next === 'waiting') {
      Sound.play('waiting');
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
    } else if (next === 'done' && (prev === 'working' || prev === 'compacting')) {
      Sound.play('done');
    } else if (next === 'error') {
      Sound.play('error');
    }
  }

  function handle(msg) {
    switch (msg.type) {
      case 'snapshot':
        S.sessions = new Map(msg.sessions.map(s => [s.id, s]));
        S.limits = msg.limits || {};
        S.dirty = true;
        break;
      case 'session': {
        const s = msg.session, prev = S.sessions.get(s.id);
        if (!prev) {
          S.dirty = true;
          if (S.started) Sound.play('start');
        }
        S.sessions.set(s.id, s);
        onTransition(prev && prev.state, s.state);
        break;
      }
      case 'session_removed':
        S.sessions.delete(msg.id);
        S.dirty = true;
        break;
      case 'limits':
        S.limits = msg.limits || {};
        break;
      case 'tokens': {
        const w = weighted(msg);
        S.tokenLog.push([performance.now() / 1000, w]);
        const n = clamp(Math.ceil(w / TOKENS_PER_PEBBLE), 1, 24);
        for (let i = 0; i < n && S.queue.length < 300; i++) S.queue.push(msg.session_id);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- conexão

  function getToken() {
    const m = location.hash.match(/t=([\w-]+)/);
    if (m) {
      try { localStorage.setItem('aid_token', m[1]); } catch {}
      history.replaceState(null, '', location.pathname + location.search);
      return m[1];
    }
    try { return localStorage.getItem('aid_token'); } catch { return null; }
  }

  let ws = null, retry = 0, retryTimer = null;
  const token = getToken();

  function connect() {
    if (!token) { S.conn = 'notoken'; return; }
    if (ws && ws.readyState <= 1) return;
    clearTimeout(retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { S.conn = 'live'; retry = 0; };
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = e => {
      if (e.code === 4401) { S.conn = 'badtoken'; return; }
      S.conn = 'off';
      retryTimer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
  }
  setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 20000);

  // ---------------------------------------------------------------- modo demo (?demo)

  function startDemo() {
    S.conn = 'demo';
    const now = Date.now() / 1000;
    const projects = [['api-gateway', 'Refatorar autenticação JWT'], ['site-loja', 'Ajustar layout mobile'], ['etl-jobs', 'Corrigir importação de CSV']];
    handle({
      type: 'snapshot',
      sessions: projects.map(([project, title], i) => ({
        id: 'demo' + i, project, title, state: i === 1 ? 'waiting' : 'working', tool: 'Edit',
        message: '', model: 'Opus', context_pct: 18 + i * 21, cost_usd: 0.4 + i * 0.7, tokens: 0, started: i,
      })),
      limits: { five_hour: { pct: 34, resets_at: now + 8300 }, seven_day: { pct: 57, resets_at: now + 280000 } },
    });
    const tools = ['Bash', 'Edit', 'Read', 'Grep', 'Write', 'WebFetch'];
    setInterval(() => {
      for (const s of S.sessions.values()) {
        if (s.state === 'working' && Math.random() < 0.6) {
          const u = { input: rand(0, 30), output: rand(100, 2500), cache_read: rand(0, 40000), cache_write: rand(0, 3000) };
          s.tokens += Math.round(u.input + u.output + u.cache_read + u.cache_write);
          handle({ type: 'tokens', session_id: s.id, ...u });
        }
      }
      const l = S.limits.five_hour;
      if (l) l.pct = Math.min(100, l.pct + 0.05);
    }, 600);
    setInterval(() => {
      const list = [...S.sessions.values()];
      const s = list[Math.floor(Math.random() * list.length)];
      const r = Math.random();
      const next = { ...s, state: r < 0.6 ? 'working' : r < 0.8 ? 'waiting' : 'done', tool: tools[Math.floor(Math.random() * tools.length)] };
      next.context_pct = Math.min(95, (s.context_pct || 0) + rand(0, 3));
      handle({ type: 'session', session: next });
    }, 3500);
  }

  // ---------------------------------------------------------------- layout

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const L = { paths: new Map(), machines: [] };

  function cssPx(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return parseFloat(v) || 0;
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    S.dirty = true;
  }

  function sortedSessions() {
    return [...S.sessions.values()].sort((a, b) => a.started - b.started || a.id.localeCompare(b.id));
  }

  function layout() {
    const top = 10 + cssPx('--sat');
    const bottom = H - 62 - cssPx('--sab');
    const tubeW = clamp(W * 0.14, 44, 72);
    const tubeH = clamp(H * 0.19, 100, 190);
    L.spineX = Math.max(tubeW / 2 + 16, W * 0.15);
    L.t5 = { x: L.spineX - tubeW / 2, y: top + 54, w: tubeW, h: tubeH };
    L.t7 = { x: L.t5.x + tubeW + 30, y: L.t5.y, w: tubeW * 1.15, h: tubeH };
    L.nozzleY = L.t5.y + tubeH + 26;
    L.dropY = L.nozzleY + 40;
    L.info = { x: L.t7.x + L.t7.w + 20, y: top + 6 };

    const list = sortedSessions();
    const mx = L.spineX + 36, mw = W - mx - 12, mTop = L.dropY + 24, gap = 12;
    const n = list.length;
    const mh = n ? clamp((bottom - mTop - gap * (n - 1)) / n, 58, 140) : 0;
    L.machines = [];
    L.paths = new Map();
    list.forEach((s, i) => {
      const y = mTop + i * (mh + gap), by = y + mh / 2;
      L.machines.push({ id: s.id, x: mx, y, w: mw, h: mh, by });
      const pts = [[L.spineX, L.dropY], [L.spineX, by], [mx + 12, by]];
      const segs = [];
      let total = 0;
      for (let k = 1; k < pts.length; k++) {
        const len = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        segs.push(len);
        total += len;
      }
      L.paths.set(s.id, { pts, segs, total });
    });
    L.spineEnd = n ? L.machines[n - 1].by : L.dropY + 60;
    S.dirty = false;
  }

  function pointAt(path, s) {
    let { pts, segs } = path;
    for (let k = 0; k < segs.length; k++) {
      if (s <= segs[k] || k === segs.length - 1) {
        const t = segs[k] ? clamp(s / segs[k], 0, 1) : 0;
        const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
        return { x: lerp(x0, x1, t), y: lerp(y0, y1, t), dx: (x1 - x0) / (segs[k] || 1), dy: (y1 - y0) / (segs[k] || 1) };
      }
      s -= segs[k];
    }
    return { x: pts[0][0], y: pts[0][1], dx: 0, dy: 1 };
  }

  // ---------------------------------------------------------------- simulação

  function update(dt, t) {
    if (S.dirty) layout();

    // tokens por minuto -> velocidade da esteira
    const now = performance.now() / 1000;
    while (S.tokenLog.length && now - S.tokenLog[0][0] > 60) S.tokenLog.shift();
    const tpm = S.tokenLog.reduce((sum, e) => sum + e[1], 0);
    S.tpm = tpm;
    const busy = S.pebbles.length || S.queue.length;
    const target = tpm > 0 ? 45 + 190 * (1 - Math.exp(-tpm / 40000)) : busy ? 45 : 0;
    S.beltSpeed = lerp(S.beltSpeed, target, Math.min(1, dt * 1.5));
    S.beltOffset += S.beltSpeed * dt;

    // tubos animam até o valor real
    S.level5 = lerp(S.level5, ((S.limits.five_hour || {}).pct || 0) / 100, Math.min(1, dt * 2));
    S.level7 = lerp(S.level7, ((S.limits.seven_day || {}).pct || 0) / 100, Math.min(1, dt * 2));

    // bico solta pedras, mais rápido quando a fila cresce
    const rate = clamp(3 + S.queue.length * 0.8, 3, 30);
    S.releaseAcc += dt * rate;
    while (S.releaseAcc >= 1 && S.queue.length) {
      S.releaseAcc -= 1;
      const sid = S.queue.shift();
      if (S.pebbles.length >= MAX_PEBBLES) continue;
      const a = animFor(sid);
      S.pebbles.push({
        sid, phase: 'fall', x: L.spineX + rand(-2.5, 2.5), y: L.nozzleY, vy: rand(10, 40), s: 0,
        r: rand(2.6, 5), hue: a.hue + rand(-12, 12), light: rand(48, 68), off: rand(-3.5, 3.5), alpha: 1,
      });
    }
    if (!S.queue.length) S.releaseAcc = Math.min(S.releaseAcc, 1);

    const speed = Math.max(S.beltSpeed, 30);
    for (const p of S.pebbles) {
      const path = L.paths.get(p.sid);
      if (!path) { p.alpha -= dt * 2; continue; }
      if (p.phase === 'fall') {
        p.vy += 900 * dt;
        p.y += p.vy * dt;
        if (p.y >= L.dropY) { p.phase = 'belt'; p.s = 0; }
      } else {
        p.s += speed * dt;
        if (p.s >= path.total - 2) {
          p.alpha = 0;
          const a = animFor(p.sid);
          a.shake = Math.min(1, a.shake + 0.35);
          a.flash = 1;
        } else {
          const q = pointAt(path, p.s);
          p.x = q.x - q.dy * p.off;
          p.y = q.y + q.dx * p.off;
        }
      }
    }
    S.pebbles = S.pebbles.filter(p => p.alpha > 0);

    // máquinas
    for (const m of L.machines) {
      const s = S.sessions.get(m.id), a = animFor(m.id);
      if (!s) continue;
      const spin = s.state === 'working' ? 3 : s.state === 'compacting' ? -6 : 0;
      a.gear += spin * dt;
      a.shake = Math.max(0, a.shake - dt * 3);
      a.flash = Math.max(0, a.flash - dt * 4);
      a.puffT -= dt;
      if ((s.state === 'working' || s.state === 'compacting') && a.puffT <= 0) {
        a.puffT = 0.35;
        a.puffs.push({ x: m.x + m.w - 41 + rand(-2, 2), y: m.y - 8, r: rand(3, 5), life: 1 });
      }
      for (const p of a.puffs) { p.y -= 18 * dt; p.x += 6 * dt; p.r += 4 * dt; p.life -= dt * 0.9; }
      a.puffs = a.puffs.filter(p => p.life > 0);
    }
  }

  // ---------------------------------------------------------------- desenho

  const STONES = Array.from({ length: 70 }, () => ({ u: Math.random(), v: Math.random(), r: rand(0.07, 0.14), l: rand(-10, 10) }));

  function levelHue(level) {
    return level < 0.7 ? lerp(140, 35, level / 0.7) : lerp(35, 0, (level - 0.7) / 0.3);
  }

  function drawTube(r, level, label, limit) {
    const c = ctx, cx = r.x + r.w / 2;
    const pct = limit && limit.pct != null ? Math.round(limit.pct) + '%' : '—';
    c.textAlign = 'center';
    c.fillStyle = '#8a94a6';
    c.font = '600 10px system-ui, sans-serif';
    c.fillText(label, cx, r.y - 40);
    c.fillStyle = '#e6e9ef';
    c.font = '700 15px system-ui, sans-serif';
    c.fillText(pct, cx, r.y - 22);
    if (limit && limit.resets_at) {
      c.fillStyle = '#8a94a6';
      c.font = '500 10px system-ui, sans-serif';
      c.fillText(fmtReset(limit.resets_at), cx, r.y - 8);
    }

    rr(c, r.x, r.y, r.w, r.h, 12);
    c.fillStyle = 'rgba(255,255,255,0.035)';
    c.fill();

    c.save();
    rr(c, r.x + 3, r.y + 3, r.w - 6, r.h - 6, 9);
    c.clip();
    const hue = levelHue(level);
    const top = r.y + r.h - level * r.h;
    const g = c.createLinearGradient(0, top, 0, r.y + r.h);
    g.addColorStop(0, `hsl(${hue},55%,50%)`);
    g.addColorStop(1, `hsl(${hue},45%,30%)`);
    c.fillStyle = g;
    c.fillRect(r.x, top, r.w, r.h);
    for (const st of STONES) {
      const y = r.y + st.v * r.h;
      if (y < top + 3) continue;
      c.beginPath();
      c.arc(r.x + st.u * r.w, y, st.r * r.w * 0.5, 0, Math.PI * 2);
      c.fillStyle = `hsla(${hue},40%,${55 + st.l}%,0.55)`;
      c.fill();
    }
    c.fillStyle = 'rgba(255,255,255,0.25)';
    c.fillRect(r.x, top, r.w, 1.5);
    c.restore();

    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = r.y + r.h * (1 - f);
      c.beginPath(); c.moveTo(r.x + r.w - 9, y); c.lineTo(r.x + r.w - 3, y); c.stroke();
    }
    rr(c, r.x, r.y, r.w, r.h, 12);
    c.strokeStyle = 'rgba(200,215,230,0.5)';
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(r.x + 6, r.y + 10, 3, r.h - 20);

  }

  function drawTubes(t) {
    const c = ctx, t5 = L.t5, t7 = L.t7;
    // cano semanal -> 5h
    const py = t5.y + t5.h - 18;
    c.fillStyle = '#2a303b';
    c.fillRect(t5.x + t5.w - 2, py - 6, t7.x - t5.x - t5.w + 4, 12);
    c.strokeStyle = 'rgba(200,215,230,0.35)';
    c.lineWidth = 1.5;
    c.strokeRect(t5.x + t5.w - 2, py - 6, t7.x - t5.x - t5.w + 4, 12);
    if (S.beltSpeed > 1) {
      c.fillStyle = 'rgba(230,233,239,0.5)';
      const span = t7.x - t5.x - t5.w;
      for (let k = 0; k < 3; k++) {
        const x = t7.x - ((S.beltOffset * 0.3 + k * span / 3) % span);
        c.beginPath(); c.arc(x, py, 2, 0, Math.PI * 2); c.fill();
      }
    }

    drawTube(t7, S.level7, 'SEMANA', S.limits.seven_day);
    drawTube(t5, S.level5, '5 HORAS', S.limits.five_hour);

    // funil e bico
    const fy = t5.y + t5.h;
    c.beginPath();
    c.moveTo(t5.x + 4, fy - 2);
    c.lineTo(t5.x + t5.w - 4, fy - 2);
    c.lineTo(L.spineX + 6, L.nozzleY);
    c.lineTo(L.spineX - 6, L.nozzleY);
    c.closePath();
    c.fillStyle = '#39404d';
    c.fill();
    c.strokeStyle = 'rgba(200,215,230,0.35)';
    c.lineWidth = 1.5;
    c.stroke();
    // válvula girando enquanto solta pedras
    const vx = L.spineX + t5.w / 2 + 6, vy = fy + 10, ang = S.queue.length ? t * 6 : 0;
    c.strokeStyle = '#c9d3e0';
    c.lineWidth = 2;
    c.beginPath(); c.arc(vx, vy, 6, 0, Math.PI * 2); c.stroke();
    for (let k = 0; k < 3; k++) {
      const a = ang + k * Math.PI * 2 / 3;
      c.beginPath(); c.moveTo(vx, vy); c.lineTo(vx + Math.cos(a) * 6, vy + Math.sin(a) * 6); c.stroke();
    }
  }

  function beltLine(x0, y0, x1, y1) {
    const c = ctx;
    c.lineCap = 'round';
    c.strokeStyle = '#1c2029';
    c.lineWidth = 16;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.strokeStyle = '#3a414e';
    c.lineWidth = 11;
    c.setLineDash([5, 7]);
    c.lineDashOffset = -S.beltOffset;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.setLineDash([]);
  }

  function drawBelts() {
    const c = ctx;
    beltLine(L.spineX, L.dropY - 8, L.spineX, L.spineEnd);
    for (const m of L.machines) {
      beltLine(L.spineX, m.by, m.x + 12, m.by);
      c.beginPath();
      c.arc(L.spineX, m.by, 6, 0, Math.PI * 2);
      c.fillStyle = '#5a6375';
      c.fill();
    }
  }

  function drawPebbles() {
    const c = ctx;
    for (const p of S.pebbles) {
      c.globalAlpha = clamp(p.alpha, 0, 1);
      c.beginPath();
      c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      c.fillStyle = `hsl(${p.hue},32%,${p.light}%)`;
      c.fill();
      c.beginPath();
      c.arc(p.x - p.r * 0.35, p.y - p.r * 0.35, p.r * 0.35, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.fill();
    }
    c.globalAlpha = 1;
  }

  function drawGear(x, y, r, angle, color) {
    const c = ctx, teeth = 8;
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a0 = (i / (teeth * 2)) * Math.PI * 2, a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
      const rad = i % 2 ? r * 0.78 : r;
      c.arc(0, 0, rad, a0, a1);
    }
    c.closePath();
    c.fillStyle = color;
    c.fill();
    c.beginPath();
    c.arc(0, 0, r * 0.32, 0, Math.PI * 2);
    c.fillStyle = '#232833';
    c.fill();
    c.restore();
  }

  function drawMachine(m, t) {
    const c = ctx, s = S.sessions.get(m.id);
    if (!s) return;
    const a = animFor(m.id), st = STATES[s.state] || STATES.idle;
    const dx = Math.sin(t * 60) * a.shake * 1.6;
    const x = m.x + dx, y = m.y, w = m.w, h = m.h;
    const waiting = s.state === 'waiting';
    const pulse = waiting ? 0.5 + 0.5 * Math.sin(t * 6) : 0;

    // fumaça
    for (const p of a.puffs) {
      c.beginPath();
      c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      c.fillStyle = `rgba(200,210,225,${0.25 * p.life})`;
      c.fill();
    }
    // chaminé
    c.fillStyle = '#2b313c';
    c.fillRect(x + w - 46, y - 8, 10, 10);

    // corpo
    c.save();
    if (waiting) { c.shadowColor = st.color; c.shadowBlur = 10 + 14 * pulse; }
    rr(c, x, y, w, h, 12);
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#3b4250');
    g.addColorStop(1, '#2a2f3a');
    c.fillStyle = g;
    c.fill();
    c.restore();
    rr(c, x, y, w, h, 12);
    c.strokeStyle = waiting ? `rgba(240,166,58,${0.5 + 0.5 * pulse})` : st.color + '66';
    c.lineWidth = waiting ? 2.5 : 1.5;
    c.stroke();

    // entrada
    c.fillStyle = a.flash ? `hsla(${a.hue},60%,60%,${0.3 + 0.5 * a.flash})` : '#1c2029';
    rr(c, x + 2, m.by - 11, 14, 22, 4);
    c.fill();

    // engrenagem
    const gr = clamp(h * 0.27, 12, 24), gx = x + 22 + gr, gy = y + h / 2;
    drawGear(gx, gy, gr, a.gear, s.state === 'working' || s.state === 'compacting' ? st.color : '#5a6375');

    // lâmpada
    const lx = x + w - 16, ly = y + 16;
    const on = waiting ? pulse > 0.3 : true;
    c.beginPath();
    c.arc(lx, ly, 6, 0, Math.PI * 2);
    c.fillStyle = on ? st.color : '#2a2f3a';
    if (on) { c.shadowColor = st.color; c.shadowBlur = 12; }
    c.fill();
    c.shadowBlur = 0;

    // textos
    const tx = gx + gr + 12, tw = x + w - 30 - tx;
    let ty = y + 20;
    c.textAlign = 'left';
    c.fillStyle = '#e6e9ef';
    c.font = '700 14px system-ui, sans-serif';
    c.fillText(fitText(c, s.project || 'sessão', tw), tx, ty);
    if (h >= 84 && s.title) {
      ty += 16;
      c.fillStyle = '#8a94a6';
      c.font = '500 12px system-ui, sans-serif';
      c.fillText(fitText(c, s.title, tw + 14), tx, ty);
    }
    ty += 17;
    c.fillStyle = st.color;
    c.font = '600 12px system-ui, sans-serif';
    const detail = s.state === 'working' && s.tool ? `${st.label} · ${s.tool}` : st.label;
    c.fillText(fitText(c, detail, tw + 14), tx, ty);

    // rodapé: contexto, tokens e custo
    if (h >= 70) {
      const fy = y + h - 12, bw = Math.min(tw * 0.3, 80);
      let leftEnd = tx;
      c.font = '500 10px system-ui, sans-serif';
      if (s.context_pct != null) {
        rr(c, tx, fy - 4, bw, 6, 3);
        c.fillStyle = '#1c2029';
        c.fill();
        rr(c, tx, fy - 4, Math.max(6, bw * clamp(s.context_pct / 100, 0, 1)), 6, 3);
        c.fillStyle = s.context_pct > 80 ? '#ff5d5d' : '#9fb3c8';
        c.fill();
        c.fillStyle = '#8a94a6';
        const label = `ctx ${Math.round(s.context_pct)}%`;
        c.fillText(label, tx + bw + 6, fy + 2);
        leftEnd = tx + bw + 6 + c.measureText(label).width;
      }
      // Tokens e custo à direita; em telas estreitas, mostra só o que couber.
      const tok = s.tokens ? fmtNum(s.tokens) + ' tok' : '';
      const cost = s.cost_usd != null ? '$' + s.cost_usd.toFixed(2) : '';
      const room = x + w - 10 - leftEnd - 10;
      const right = [[tok, cost].filter(Boolean).join(' · '), cost, tok].find(txt => c.measureText(txt).width <= room) || '';
      c.textAlign = 'right';
      c.fillStyle = '#8a94a6';
      c.fillText(right, x + w - 10, fy + 2);
    }
  }

  function drawInfo(t) {
    const c = ctx, x = L.info.x, maxW = W - x - 12;
    if (maxW < 70) return;
    let y = L.info.y + 10;
    c.textAlign = 'left';
    c.fillStyle = '#8a94a6';
    c.font = '600 10px system-ui, sans-serif';
    c.fillText('TOKENS / MIN', x, y);
    y += 24;
    c.fillStyle = '#e6e9ef';
    c.font = '700 24px system-ui, sans-serif';
    c.fillText(fmtNum(S.tpm || 0), x, y);

    y += 26;
    const list = [...S.sessions.values()];
    const waiting = list.filter(s => s.state === 'waiting').length;
    const working = list.filter(s => s.state === 'working' || s.state === 'compacting').length;
    c.fillStyle = '#8a94a6';
    c.font = '600 10px system-ui, sans-serif';
    c.fillText('SESSÕES', x, y);
    y += 17;
    c.font = '600 13px system-ui, sans-serif';
    c.fillStyle = '#e6e9ef';
    c.fillText(fitText(c, `${list.length} ativas`, maxW), x, y);
    if (working) { y += 16; c.fillStyle = STATES.working.color; c.fillText(`${working} trabalhando`, x, y); }
    if (waiting) { y += 16; c.fillStyle = STATES.waiting.color; c.fillText(`${waiting} aguardando`, x, y); }

    y += 24;
    const conn = {
      live: ['#5ad17a', 'ao vivo'], demo: ['#b48cff', 'demonstração'], off: ['#ff5d5d', 'reconectando…'],
      badtoken: ['#ff5d5d', 'token inválido'], notoken: ['#ff5d5d', 'sem pareamento'],
    }[S.conn];
    c.beginPath();
    c.arc(x + 4, y - 4, 4, 0, Math.PI * 2);
    c.fillStyle = conn[0];
    c.fill();
    c.fillStyle = '#8a94a6';
    c.font = '500 11px system-ui, sans-serif';
    c.fillText(fitText(c, conn[1], maxW - 14), x + 14, y);
  }

  function drawEmpty() {
    const c = ctx, x = L.spineX + 36, y = L.dropY + 70;
    c.textAlign = 'left';
    c.fillStyle = '#8a94a6';
    c.font = '600 14px system-ui, sans-serif';
    c.fillText('Nenhuma sessão ativa', x, y);
    c.font = '400 12px system-ui, sans-serif';
    const hint = S.conn === 'notoken' ? 'Abra o link ou QR code mostrado no PC' :
      S.conn === 'badtoken' ? 'Escaneie o QR code novamente' : 'Abra o Claude Code para começar';
    c.fillText(fitText(c, hint, W - x - 12), x, y + 20);
  }

  function draw(t) {
    const c = ctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#131823');
    bg.addColorStop(1, '#0c0f14');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    drawBelts();
    for (const m of L.machines) drawMachine(m, t);
    drawTubes(t);
    drawPebbles();
    drawInfo(t);
    if (!L.machines.length) drawEmpty();

    // borda pulsando quando alguma sessão espera por você
    if ([...S.sessions.values()].some(s => s.state === 'waiting')) {
      c.strokeStyle = `rgba(240,166,58,${0.25 + 0.25 * Math.sin(t * 6)})`;
      c.lineWidth = 6;
      c.strokeRect(3, 3, W - 6, H - 6);
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt, now / 1000);
    draw(now / 1000);
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- início

  const overlay = document.getElementById('start');
  const muteBtn = document.getElementById('mute');
  const renderMute = () => { muteBtn.textContent = Sound.enabled ? '🔊' : '🔇'; };
  renderMute();

  muteBtn.addEventListener('click', () => {
    Sound.enabled = !Sound.enabled;
    try { localStorage.setItem('aid_mute', Sound.enabled ? '0' : '1'); } catch {}
    Sound.unlock();
    renderMute();
  });

  document.getElementById('go').addEventListener('click', () => {
    Sound.unlock();
    Sound.play('start');
    keepAwake();
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    S.started = true;
    overlay.classList.add('hidden');
  });

  // Ao voltar para o app: reconecta e reativa a tela ligada.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (S.conn !== 'demo') connect();
    if (S.started) keepAwake();
  });
  document.addEventListener('touchend', () => { if (S.started) Sound.unlock(); }, { passive: true });

  if (!token && !new URLSearchParams(location.search).has('demo')) {
    document.getElementById('start-msg').textContent = 'Abra o link ou QR code mostrado pelo aidashboard no PC.';
  }

  // ?auto pula a tela inicial (sem som nem tela ligada), útil em telas fixas e em screenshots.
  if (new URLSearchParams(location.search).has('auto')) overlay.classList.add('hidden');

  window.addEventListener('resize', resize);
  resize();
  if (new URLSearchParams(location.search).has('demo')) startDemo();
  else connect();
  requestAnimationFrame(frame);
})();
