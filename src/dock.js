// Glimt dock renderer: builds widgets from settings, keeps them live, opens popovers.
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const I = window.ICONS;
  const api = window.glimt;
  const dockEl = $('#dock');
  const popEl = $('#pop');
  const root = document.documentElement;
  // The same page also runs as the centered search window (Win / Win+S / Alt+Space)
  const SPOT = new URLSearchParams(location.search).has('spot');
  if (SPOT) root.classList.add('spot');

  /* ---------- State ---------- */
  let S = await api.getSettings();
  let media = null, stats = null, sys = null, battery = null;
  const hist = { cpu: [], down: [], up: [] };
  const HIST = 60;
  let artColor = null;
  let openId = null;

  /* ---------- Formatting ---------- */
  const nf1 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
  const pct = v => nf0.format(Math.round(v)) + ' %';
  const gb = b => nf1.format(b / 1073741824) + ' GB';
  function bytes(b) {
    if (b >= 1073741824) return nf1.format(b / 1073741824) + ' GB';
    if (b >= 1048576) return nf1.format(b / 1048576) + ' MB';
    return nf0.format(b / 1024) + ' kB';
  }
  function rate(b) {
    if (b >= 1048576) return nf1.format(b / 1048576) + ' MB/s';
    if (b >= 1024) return nf0.format(b / 1024) + ' kB/s';
    return nf0.format(b) + ' B/s';
  }
  const mmss = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function sourceName(id) {
    if (!id) return 'Okänd';
    const known = { 'spotify.exe': 'Spotify', 'chrome': 'Chrome', 'msedge': 'Edge', '308046b0af4a39cb': 'Firefox', 'firefox.exe': 'Firefox', 'brave': 'Brave', 'opera': 'Opera', 'vlc.exe': 'VLC', 'discord.exe': 'Discord' };
    const k = id.toLowerCase();
    if (known[k]) return known[k];
    if (/zunemusic|mediaplayer/i.test(id)) return 'Mediaspelaren';
    if (id.includes('!')) { const p = id.split('!')[0].split('_')[0].split('.'); return p[p.length - 1]; }
    return id.replace(/\.exe$/i, '');
  }
  function uptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d} d ${h} h` : `${h} h ${m} min`;
  }

  /* ---------- Theme ---------- */
  function applyLook() {
    const L = S.look;
    root.classList.toggle('light', L.theme === 'light');
    root.classList.toggle('noglass', L.glass === 'off');
    root.style.setProperty('--accent', L.accent);
    root.style.setProperty('--glass-a', L.opacity);
    root.style.setProperty('--blur', L.blur + 'px');
    root.style.setProperty('--radius', L.radius + 'px');
    root.style.setProperty('--scale', L.scale);
    root.style.setProperty('--margin', L.margin + 'px');
    root.style.setProperty('--art', L.accentFromArt && artColor ? artColor : L.accent);
    const st = $('#stage');
    st.classList.toggle('top', L.position === 'top');
    st.classList.toggle('full', L.layout === 'full');
    st.classList.toggle('nolabels', !L.labels);
  }

  /* ---------- Widgets ---------- */
  // Each widget: build() returns an element; update() refreshes it from state.
  const W = {
    start: {
      build() {
        const el = document.createElement('button');
        el.className = 'w start';
        el.title = 'Start';
        el.setAttribute('aria-label', 'Start');
        el.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g fill="var(--accent)"><rect x="2" y="2" width="9.4" height="9.4" rx="1.6"/><rect x="12.6" y="2" width="9.4" height="9.4" rx="1.6"/><rect x="2" y="12.6" width="9.4" height="9.4" rx="1.6"/><rect x="12.6" y="12.6" width="9.4" height="9.4" rx="1.6"/></g></svg>`;
        return el;
      },
      click(el) {
        if (S.general.startButton === 'windows') api.shellKeys('start');
        else api.openSpot();
      }
    },

    apps: {
      build() {
        const el = document.createElement('div');
        el.className = 'apps';
        renderApps(el);
        return el;
      },
      update(el) { renderApps(el); }
    },

    media: {
      pop: true,
      build() {
        const el = document.createElement('div');
        el.className = 'w media';
        el.innerHTML = `<span class="glow"></span>
          <span class="art empty">${I.music}</span>
          <div class="meta"><span class="t">Inget spelas</span><span class="a">Starta Spotify eller annan spelare</span><span class="mini"><i></i></span></div>
          <div class="mctl">
            <button class="mbtn" data-cmd="prev" title="Föregående" aria-label="Föregående">${I.prev}</button>
            <button class="mbtn play" data-cmd="toggle" title="Spela/pausa" aria-label="Spela eller pausa">${I.play}</button>
            <button class="mbtn" data-cmd="next" title="Nästa" aria-label="Nästa">${I.next}</button>
          </div>`;
        el.addEventListener('wheel', onVolumeWheel, { passive: true });
        return el;
      },
      update(el) {
        const m = media;
        const active = m && m.active;
        el.classList.toggle('idle', !active);
        el.querySelector('.mctl').style.display = S.media.dockControls && active ? '' : 'none';
        const artBox = el.querySelector('.art');
        if (active && m.art) {
          if (artBox.tagName !== 'IMG' || artBox.dataset.key !== m.trackKey) {
            const img = document.createElement('img');
            img.className = 'art'; img.alt = ''; img.src = m.art; img.dataset.key = m.trackKey;
            artBox.replaceWith(img);
          }
        } else if (artBox.tagName === 'IMG') {
          const span = document.createElement('span');
          span.className = 'art empty'; span.innerHTML = I.music;
          artBox.replaceWith(span);
        }
        el.querySelector('.t').textContent = active ? (m.title || 'Okänd titel') : 'Inget spelas';
        el.querySelector('.a').textContent = active ? (m.artist || sourceName(m.source)) : 'Starta Spotify eller annan spelare';
        el.title = active ? `${m.title} – ${m.artist}` : '';
        const play = el.querySelector('[data-cmd=toggle]');
        play.innerHTML = active && m.status === 'Playing' ? I.pause : I.play;
        el.querySelector('[data-cmd=prev]').disabled = !(active && m.canPrev);
        el.querySelector('[data-cmd=next]').disabled = !(active && m.canNext);
      },
      tick(el) {
        const bar = el.querySelector('.mini i');
        bar.style.width = media && media.active && media.duration ? (mediaPos() / media.duration * 100) + '%' : '0';
      }
    },

    cpu: {
      pop: true,
      build() {
        const el = document.createElement('div');
        el.className = 'w';
        el.innerHTML = `<span class="ico">${I.cpu}</span><span class="lbl"><span class="k">CPU</span><span class="v">–</span></span><canvas class="spark" width="92" height="44"></canvas>`;
        return el;
      },
      update(el) {
        if (!sys) return;
        el.querySelector('.v').textContent = pct(sys.cpu);
        drawChart(el.querySelector('canvas'), [{ data: hist.cpu, color: cssVar('--accent') }], { max: 100, mini: true });
      }
    },

    ram: {
      pop: true,
      build() {
        const el = document.createElement('div');
        el.className = 'w';
        el.innerHTML = `<span class="ico">${I.ram}</span><span class="lbl"><span class="k">RAM</span><span class="v">–</span><span class="minibar"><i></i></span></span>`;
        return el;
      },
      update(el) {
        if (!sys) return;
        const p = sys.memUsed / sys.memTotal * 100;
        el.querySelector('.v').textContent = pct(p);
        const bar = el.querySelector('.minibar i');
        bar.style.width = p + '%';
        bar.style.background = p > 90 ? 'var(--bad)' : p > 75 ? 'var(--warn)' : 'var(--good)';
      }
    },

    net: {
      pop: true,
      build() {
        const el = document.createElement('div');
        el.className = 'w net';
        el.innerHTML = `<span class="ico">${I.net}</span><span class="lbl"><span class="v d">↓ –</span><span class="v u" style="color:var(--muted)">↑ –</span></span>`;
        return el;
      },
      update(el) {
        if (!stats) return;
        el.querySelector('.d').textContent = '↓ ' + rate(stats.netDown);
        el.querySelector('.u').textContent = '↑ ' + rate(stats.netUp);
      }
    },

    disk: {
      pop: true,
      build() {
        const el = document.createElement('div');
        el.className = 'w';
        el.innerHTML = `<span class="ico">${I.disk}</span><span class="lbl"><span class="k">C: ledigt</span><span class="v">–</span><span class="minibar"><i></i></span></span>`;
        return el;
      },
      update(el) {
        const d = sys && sys.disks && sys.disks[0];
        if (!d) return;
        el.querySelector('.k').textContent = d.name + ' ledigt';
        el.querySelector('.v').textContent = gb(d.free);
        const used = (1 - d.free / d.total) * 100;
        const bar = el.querySelector('.minibar i');
        bar.style.width = used + '%';
        bar.style.background = used > 90 ? 'var(--bad)' : used > 80 ? 'var(--warn)' : 'var(--accent)';
      }
    },

    battery: {
      build() {
        const el = document.createElement('div');
        el.className = 'w';
        el.innerHTML = `<span class="ico batt">${I.battery}<span class="bolt" hidden>${I.bolt}</span></span><span class="lbl"><span class="k">Batteri</span><span class="v">–</span></span>`;
        return el;
      },
      update(el) {
        if (!battery) return;
        const desktop = battery.charging && battery.level === 1 && battery.chargingTime === 0;
        el.querySelector('.v').textContent = desktop ? 'Nätström' : pct(battery.level * 100);
        el.querySelector('.bolt').hidden = !battery.charging || desktop;
      }
    },

    // Inline volume: icon mutes, the slider sets the level directly, scrolling nudges it.
    volume: {
      build() {
        const el = document.createElement('div');
        el.className = 'w volw';
        el.innerHTML = `<button class="vbtn" aria-label="Ljud av eller på">${I.volume}</button>
          <input type="range" class="vslide" min="0" max="100" step="1" value="50" aria-label="Volym">`;
        const r = el.querySelector('.vslide');
        let last = 0, timer;
        r.addEventListener('input', () => {
          draggingVol = true;
          setFill(r);
          if (stats) { stats.volume = r.value / 100; stats.mute = false; }
          paintVolIcon(el);
          el.title = 'Volym ' + r.value + ' %';
          const send = () => { last = Date.now(); api.media({ cmd: 'volume', value: r.value / 100 }); };
          clearTimeout(timer);
          if (Date.now() - last > 40) send(); else timer = setTimeout(send, 40);
        });
        r.addEventListener('change', () => { draggingVol = false; });
        el.querySelector('.vbtn').addEventListener('click', e => { e.stopPropagation(); sendCmd('mute'); });
        el.addEventListener('wheel', onVolumeWheel, { passive: true });
        return el;
      },
      update(el) {
        if (!stats || stats.volume == null) { el.style.opacity = .5; return; }
        el.style.opacity = '';
        const r = el.querySelector('.vslide');
        if (!draggingVol) { r.value = Math.round(stats.volume * 100); setFill(r); }
        el.classList.toggle('muted', !!stats.mute);
        el.title = stats.mute ? 'Ljudet är av' : 'Volym ' + Math.round(stats.volume * 100) + ' %';
        paintVolIcon(el);
      }
    },

    search: {
      build() {
        const el = document.createElement('button');
        el.className = 'w searchpill';
        el.setAttribute('aria-label', 'Sök');
        el.title = 'Sök (Win+S)';
        el.innerHTML = `<span class="sico">${I.search}</span><span class="stxt">Sök</span>`;
        return el;
      },
      click() { api.openSpot(); }
    },

    weather: {
      build() {
        const el = document.createElement('button');
        el.className = 'w weather';
        el.innerHTML = `<span class="wico">${I.cloud}</span><span class="v">–°</span>`;
        return el;
      },
      update(el) {
        if (!weather) return;
        const info = weatherInfo(weather.code, weather.isDay);
        el.querySelector('.wico').innerHTML = I[info.icon];
        el.querySelector('.v').textContent = Math.round(weather.temp) + '°';
        el.title = `${weather.name}: ${info.text}, ${nf1.format(weather.temp)}°. Känns som ${Math.round(weather.feels)}°, vind ${Math.round(weather.wind)} m/s`;
        el.setAttribute('aria-label', el.title);
      },
      click() { api.openSettings('general'); }
    },

    control: {
      pop: true,
      build() {
        const el = document.createElement('button');
        el.className = 'w ccpill';
        el.title = 'Kontrollcenter';
        el.setAttribute('aria-label', 'Kontrollcenter');
        el.innerHTML = I.control;
        return el;
      }
    },

    clock: {
      build() {
        const el = document.createElement('div');
        el.className = 'w clock';
        el.innerHTML = `<span class="lbl"><span class="v"></span><span class="k"></span></span>`;
        return el;
      },
      update(el) {
        const d = new Date();
        el.querySelector('.v').textContent = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
        el.querySelector('.k').textContent = d.toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '');
        el.title = d.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · klicka för aviseringar';
      },
      click() { api.shellKeys('notifications'); }
    }
  };

  /* ---------- Apps and open windows ---------- */
  let windows = { active: 0, list: [] };
  let pinTargets = [];       // resolved .exe (lowercase) per pinned app
  let appItems = new Map();  // key -> item currently shown
  let popKey = null;         // which app's window list is open

  async function resolvePins() {
    pinTargets = await Promise.all((S.apps || []).map(a => api.appTarget(a.path)));
    mounted.filter(m => m.id === 'apps').forEach(m => renderApps(m.el));
  }

  // Programs whose windows belong to a different .exe than the one you start
  const ALIAS = { 'steamwebhelper.exe': 'steam.exe', 'applicationframehost.exe': null };
  function windowGroups() {
    const g = new Map();
    if (S.general.showRunning === false) return g;
    for (const w of windows.list || []) {
      if (!w.exe) continue;
      let k = w.exe.toLowerCase();
      const base = k.split('\\').pop();
      if (ALIAS[base]) {
        const pinned = pinTargets.find(t => t && t.split('\\').pop() === ALIAS[base]);
        if (pinned) k = pinned;
      }
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(w);
    }
    return g;
  }

  function prettyName(exe, wins) {
    const base = exe.split('\\').pop().replace(/\.exe$/i, '');
    const known = { applicationframehost: wins[0] && wins[0].title, steamwebhelper: 'Steam', 'fortniteclient-win64-shipping': 'Fortnite', lghub: 'Logitech G HUB', electron: 'Glimt' };
    return known[base.toLowerCase()] || base.charAt(0).toUpperCase() + base.slice(1);
  }

  function renderApps(el) {
    const groups = windowGroups();
    const items = (S.apps || []).map((a, i) => ({ key: pinTargets[i] || a.path.toLowerCase(), name: a.name, path: a.path, pinned: true }));
    const seen = new Set(items.map(i => i.key));
    for (const [k, wins] of groups) {
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ key: k, name: prettyName(wins[0].exe, wins), path: wins[0].exe, pinned: false });
    }
    const sig = items.map(i => i.key + (i.pinned ? '*' : '')).join('|');
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = '';
      appItems = new Map();
      let lastPinned = true;
      items.forEach(it => {
        if (lastPinned && !it.pinned && (S.apps || []).length) {
          const sep = document.createElement('span'); sep.className = 'appsep'; el.appendChild(sep);
        }
        lastPinned = it.pinned;
        const b = document.createElement('button');
        b.className = 'app';
        b.dataset.key = it.key;
        b.innerHTML = `<span class="letter">${esc((it.name || '?')[0])}</span>`;
        api.appIcon(it.path).then(src => { if (src) b.innerHTML = `<img src="${src}" alt="">`; });
        el.appendChild(b);
        appItems.set(it.key, it);
      });
      if (!items.length) {
        const b = document.createElement('button');
        b.className = 'app'; b.title = 'Lägg till appar'; b.dataset.add = '1';
        b.innerHTML = `<span style="font-size:18px;color:var(--muted)">${I.plus}</span>`;
        el.appendChild(b);
      }
    }
    // running / active markers
    el.querySelectorAll('.app[data-key]').forEach(b => {
      const it = appItems.get(b.dataset.key);
      const wins = groups.get(b.dataset.key) || [];
      b.classList.toggle('running', wins.length > 0);
      b.classList.toggle('multi', wins.length > 1);
      b.classList.toggle('active', wins.some(w => w.hwnd === windows.active));
      const label = wins.length === 1 ? `${it.name} – ${wins[0].title}` : wins.length > 1 ? `${it.name} – ${wins.length} fönster` : it.name;
      b.title = label; b.setAttribute('aria-label', label);
    });
  }

  function onAppClick(b, e) {
    if (b.dataset.add) return api.openSettings('apps');
    const it = appItems.get(b.dataset.key); if (!it) return;
    const wins = windowGroups().get(it.key) || [];
    if (!wins.length || e.button === 1) {
      b.classList.remove('launching'); void b.offsetWidth; b.classList.add('launching');
      api.launch(it.path);
      return;
    }
    if (wins.length === 1) { closePop(); api.winClick(wins[0].hwnd); return; }
    popKey = it.key;
    openPop('windows', b);
  }

  dockEl.addEventListener('click', e => {
    const b = e.target.closest('.app'); if (b) { e.stopPropagation(); onAppClick(b, e); }
  }, true);
  dockEl.addEventListener('auxclick', e => {
    const b = e.target.closest('.app'); if (b && e.button === 1) onAppClick(b, e);
  });
  dockEl.addEventListener('contextmenu', e => {
    const b = e.target.closest('.app[data-key]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const it = appItems.get(b.dataset.key);
    const wins = windowGroups().get(b.dataset.key) || [];
    api.appMenu({ name: it.name, path: it.path, pinned: it.pinned, windows: wins.map(w => ({ hwnd: w.hwnd, title: w.title })) });
  }, true);

  const mounted = []; // { id, el }

  function buildDock() {
    dockEl.innerHTML = '';
    mounted.length = 0;
    const items = S.widgets.filter(w => w.on && (W[w.id] || w.id === 'spacer'));
    items.forEach((w, i) => {
      if (w.id === 'spacer') {
        if (i === 0 || i === items.length - 1) return;
        const sp = document.createElement('span');
        sp.className = S.look.layout === 'full' ? 'spacer' : 'sep';
        dockEl.appendChild(sp);
        return;
      }
      const el = W[w.id].build();
      el.dataset.id = w.id;
      if (W[w.id].pop) { el.setAttribute('role', 'button'); el.tabIndex = 0; }
      dockEl.appendChild(el);
      mounted.push({ id: w.id, el });
    });
    const gear = document.createElement('button');
    gear.className = 'gear'; gear.title = 'Inställningar'; gear.setAttribute('aria-label', 'Inställningar');
    gear.innerHTML = I.gear;
    gear.addEventListener('click', () => api.openSettings());
    dockEl.appendChild(gear);
    updateAll();
    if (openId && !mounted.some(m => m.id === openId)) closePop();
  }

  function updateAll() { mounted.forEach(m => W[m.id].update && W[m.id].update(m.el)); }
  function updateWidget(id) { mounted.filter(m => m.id === id).forEach(m => W[id].update(m.el)); }

  /* ---------- Charts ---------- */
  function cssVar(n) { return getComputedStyle(root).getPropertyValue(n).trim(); }
  function drawChart(c, series, { max, mini } = {}) {
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W_ = c.clientWidth * dpr, H = c.clientHeight * dpr;
    if (!W_ || !H) return;
    if (c.width !== W_ || c.height !== H) { c.width = W_; c.height = H; }
    const x = c.getContext('2d');
    x.clearRect(0, 0, W_, H);
    const top = max || Math.max(1, ...series.flatMap(s => s.data)) * 1.15;
    const pad = mini ? 2 * dpr : 4 * dpr;
    if (!mini) {
      x.strokeStyle = cssVar('--track'); x.lineWidth = 1;
      [0.25, 0.5, 0.75].forEach(f => { x.beginPath(); x.moveTo(0, Math.round(H * f) + .5); x.lineTo(W_, Math.round(H * f) + .5); x.stroke(); });
    }
    series.forEach(s => {
      const d = s.data;
      if (d.length < 2) return;
      const px = i => (i + HIST - d.length) / (HIST - 1) * (W_ - pad * 2) + pad;
      const py = v => H - pad - Math.min(1, v / top) * (H - pad * 2);
      x.beginPath();
      d.forEach((v, i) => i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v)));
      x.strokeStyle = s.color; x.lineWidth = (mini ? 1.6 : 2) * dpr; x.lineJoin = 'round'; x.stroke();
      if (s.fill !== false) {
        x.lineTo(px(d.length - 1), H); x.lineTo(px(0), H); x.closePath();
        const g = x.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, s.color + '55'); g.addColorStop(1, s.color + '00');
        x.fillStyle = g; x.fill();
      }
      if (!mini) {
        x.beginPath(); x.arc(px(d.length - 1), py(d[d.length - 1]), 3.5 * dpr, 0, 7);
        x.fillStyle = s.color; x.fill();
      }
    });
  }

  /* ---------- Media helpers ---------- */
  function mediaPos() {
    if (!media || !media.active) return 0;
    let p = media.position || 0;
    if (media.status === 'Playing' && media.updatedAt) p += (Date.now() - media.updatedAt) / 1000;
    return Math.max(0, Math.min(p, media.duration || p));
  }

  function extractColor(src) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        const sat = mx ? (mx - mn) / mx : 0, lum = mx / 255;
        const w = sat * sat * (lum > 0.15 ? 1 : 0.1) + 0.01;
        r += R * w; g += G * w; b += B * w; wsum += w;
      }
      r /= wsum; g /= wsum; b /= wsum;
      // normalise to a readable, saturated tone
      let [h, s] = rgbToHsl(r, g, b);
      s = Math.max(s, 0.5);
      artColor = hslToHex(h, Math.min(s, 0.85), 0.64);
      applyLook();
      updatePop();
    };
    img.src = src;
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToHex(h, s, l) {
    const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
  }

  let wheelAcc = 0, wheelTimer;
  function onVolumeWheel(e) {
    if (!stats || stats.volume == null) return;
    wheelAcc += e.deltaY < 0 ? 0.02 : -0.02;
    stats.volume = Math.max(0, Math.min(1, stats.volume + (e.deltaY < 0 ? 0.02 : -0.02)));
    stats.mute = false;
    updateWidget('volume'); updatePop();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { api.media({ cmd: 'volume', value: stats.volume }); wheelAcc = 0; }, 60);
  }

  /* ---------- Popovers ---------- */
  const P = {
    media: {
      build() {
        return `<div class="player">
          <div class="bg"></div><div class="shade"></div>
          <div class="pin">
            <div class="bigart empty">${I.music}</div>
            <div><div class="ptitle">Inget spelas</div><div class="partist">Starta Spotify, en webbläsare eller annan spelare.</div></div>
            <input type="range" class="seek" id="seek" min="0" max="100" step="0.1" value="0" aria-label="Position i låten">
            <div class="times"><span class="cur">0:00</span><span class="dur">0:00</span></div>
            <div class="pctl">
              <button class="mbtn small" data-cmd="shuffle" title="Blanda" aria-label="Blanda">${I.shuffle}</button>
              <button class="mbtn" data-cmd="prev" title="Föregående" aria-label="Föregående">${I.prev}</button>
              <button class="mbtn play" data-cmd="toggle" title="Spela/pausa" aria-label="Spela eller pausa">${I.play}</button>
              <button class="mbtn" data-cmd="next" title="Nästa" aria-label="Nästa">${I.next}</button>
              <button class="mbtn small" data-cmd="repeat" title="Upprepa" aria-label="Upprepa">${I.repeat}<span class="badge"></span></button>
            </div>
            <div class="vol">
              <button class="mbtn" data-cmd="mute" title="Ljud av/på" aria-label="Ljud av eller på">${I.volume}</button>
              <input type="range" id="vol" min="0" max="100" step="1" value="50" aria-label="Volym">
              <output id="volOut">50</output>
            </div>
            <div class="sources"></div>
          </div>
        </div>`;
      },
      update() {
        const m = media, active = m && m.active;
        const art = popEl.querySelector('.bigart');
        if (active && m.art) {
          if (art.tagName !== 'IMG' || art.dataset.key !== m.trackKey) {
            const img = document.createElement('img');
            img.className = 'bigart'; img.alt = ''; img.src = m.art; img.dataset.key = m.trackKey;
            art.replaceWith(img);
          }
          popEl.querySelector('.bg').style.backgroundImage = `url("${m.art}")`;
        } else {
          if (art.tagName === 'IMG') { const d = document.createElement('div'); d.className = 'bigart empty'; d.innerHTML = I.music; art.replaceWith(d); }
          popEl.querySelector('.bg').style.backgroundImage = '';
        }
        popEl.querySelector('.ptitle').textContent = active ? (m.title || 'Okänd titel') : 'Inget spelas';
        popEl.querySelector('.partist').textContent = active
          ? [m.artist, m.album].filter(Boolean).join(' · ') || sourceName(m.source)
          : 'Starta Spotify, en webbläsare eller annan spelare.';
        popEl.querySelector('[data-cmd=toggle]').innerHTML = active && m.status === 'Playing' ? I.pause : I.play;
        const sh = popEl.querySelector('[data-cmd=shuffle]');
        sh.classList.toggle('on', !!(active && m.shuffle));
        sh.disabled = !(active && m.canShuffle);
        const rp = popEl.querySelector('[data-cmd=repeat]');
        rp.classList.toggle('on', !!(active && m.repeat && m.repeat !== 'None'));
        rp.querySelector('.badge').textContent = active && m.repeat === 'Track' ? '1' : '';
        rp.title = !active || !m.repeat || m.repeat === 'None' ? 'Upprepa: av' : m.repeat === 'Track' ? 'Upprepa: låt' : 'Upprepa: lista';
        rp.disabled = !(active && m.canRepeat);
        popEl.querySelector('[data-cmd=prev]').disabled = !(active && m.canPrev);
        popEl.querySelector('[data-cmd=next]').disabled = !(active && m.canNext);
        const seek = popEl.querySelector('#seek');
        seek.disabled = !(active && m.canSeek && m.duration);
        seek.max = active && m.duration ? m.duration : 100;
        popEl.querySelector('.dur').textContent = mmss(active ? m.duration : 0);

        const volRow = popEl.querySelector('.vol');
        volRow.style.display = S.media.showVolume && stats && stats.volume != null ? '' : 'none';
        if (stats && stats.volume != null && !draggingVol) {
          const v = popEl.querySelector('#vol');
          v.value = Math.round(stats.volume * 100);
          setFill(v);
          popEl.querySelector('#volOut').textContent = stats.mute ? 'Av' : v.value;
          popEl.querySelector('[data-cmd=mute]').innerHTML = stats.mute ? I.mute : stats.volume < 0.4 ? I.volumeLow : I.volume;
        }

        const srcs = (m && m.sources) || [];
        const box = popEl.querySelector('.sources');
        const chips = [`<button class="chip${!S.media.source ? ' on' : ''}" data-src="">Automatiskt</button>`]
          .concat(srcs.map(s => `<button class="chip${S.media.source === s ? ' on' : ''}" data-src="${esc(s)}">${esc(sourceName(s))}</button>`));
        if (active && /spotify/i.test(m.source)) chips.push(`<button class="chip" data-open-src="${esc(m.source)}">Öppna Spotify ${I.external}</button>`);
        const html = srcs.length > 1 || (active && /spotify/i.test(m.source)) ? chips.join('') : '';
        if (box.innerHTML !== html) box.innerHTML = html;
        P.media.tick();
      },
      tick() {
        if (!media || !media.active) return;
        const seek = popEl.querySelector('#seek');
        if (!seek) return;
        if (!draggingSeek) { seek.value = mediaPos(); setFill(seek); popEl.querySelector('.cur').textContent = mmss(mediaPos()); }
      }
    },

    cpu: {
      build() {
        return `<div class="pin">
          <div class="ph"><h2>Processor</h2><small class="model"></small></div>
          <div class="big"><span class="val">–</span><small class="sp"></small></div>
          <canvas class="chart"></canvas>
          <div class="sub">Kärnor</div>
          <div class="cores"></div>
          <div class="sub">Mest CPU just nu</div>
          <div class="list top"></div>
          <div class="duo"><div class="tile"><b class="up">–</b><span>Igång sedan omstart</span></div><div class="tile"><b class="nc">–</b><span>Logiska kärnor</span></div></div>
        </div>`;
      },
      update() {
        if (!sys) return;
        popEl.querySelector('.model').textContent = sys.cpuModel;
        popEl.querySelector('.val').textContent = pct(sys.cpu);
        popEl.querySelector('.sp').textContent = sys.speed ? nf1.format(sys.speed / 1000) + ' GHz' : '';
        drawChart(popEl.querySelector('canvas'), [{ data: hist.cpu, color: cssVar('--accent') }], { max: 100 });
        const cores = popEl.querySelector('.cores');
        if (cores.children.length !== sys.cores.length) cores.innerHTML = sys.cores.map(() => '<i></i>').join('');
        sys.cores.forEach((c, i) => { cores.children[i].style.height = Math.max(4, c) + '%'; });
        popEl.querySelector('.up').textContent = uptime(sys.uptime);
        popEl.querySelector('.nc').textContent = sys.cores.length;
        const top = popEl.querySelector('.top');
        top.innerHTML = stats && stats.topCpu && stats.topCpu.length
          ? stats.topCpu.map(p => `<div class="row"><span class="n">${esc(p.name)}</span><span class="m">${nf1.format(p.cpu)} %</span></div>`).join('')
          : '<div class="row"><span class="n" style="color:var(--muted)">Mäter…</span></div>';
      }
    },

    ram: {
      build() {
        return `<div class="pin">
          <div class="ph"><h2>Minne</h2><small class="tot"></small></div>
          <div class="big"><span class="val">–</span><small class="p"></small></div>
          <div class="bar"><i></i></div>
          <div class="sub">Mest minne</div>
          <div class="list top"></div>
        </div>`;
      },
      update() {
        if (!sys) return;
        const p = sys.memUsed / sys.memTotal * 100;
        popEl.querySelector('.tot').textContent = gb(sys.memTotal) + ' totalt';
        popEl.querySelector('.val').textContent = gb(sys.memUsed);
        popEl.querySelector('.p').textContent = pct(p) + ' använt';
        const bar = popEl.querySelector('.bar i');
        bar.style.width = p + '%';
        bar.style.background = p > 90 ? 'var(--bad)' : p > 75 ? 'var(--warn)' : 'var(--good)';
        const top = popEl.querySelector('.top');
        top.innerHTML = stats && stats.topMem
          ? stats.topMem.map(x => `<div class="row"><span class="n">${esc(x.name)}</span><span class="m">${bytes(x.mem)}</span></div>`).join('')
          : '';
      }
    },

    net: {
      build() {
        return `<div class="pin">
          <div class="ph"><h2>Nätverk</h2><small>senaste minuten</small></div>
          <div class="duo"><div class="tile"><b class="d">–</b><span>Ned</span></div><div class="tile"><b class="u">–</b><span>Upp</span></div></div>
          <canvas class="chart"></canvas>
          <div class="legend"><span><i style="background:var(--accent)"></i>Ned</span><span><i style="background:var(--good)"></i>Upp</span></div>
        </div>`;
      },
      update() {
        if (!stats) return;
        popEl.querySelector('.d').textContent = rate(stats.netDown);
        popEl.querySelector('.u').textContent = rate(stats.netUp);
        drawChart(popEl.querySelector('canvas'), [
          { data: hist.down, color: cssVar('--accent') },
          { data: hist.up, color: cssVar('--good'), fill: false }
        ]);
      }
    },

    disk: {
      build() { return `<div class="pin"><div class="ph"><h2>Lagring</h2></div><div class="list drives"></div></div>`; },
      update() {
        if (!sys) return;
        popEl.querySelector('.drives').innerHTML = sys.disks.map(d => {
          const used = (1 - d.free / d.total) * 100;
          return `<div style="display:grid;gap:6px"><div class="row"><span class="n"><b>${d.name}</b> ${gb(d.free)} ledigt</span><span class="m">${gb(d.total)}</span></div>
            <div class="bar"><i style="width:${used}%;background:${used > 90 ? 'var(--bad)' : used > 80 ? 'var(--warn)' : 'var(--accent)'}"></i></div></div>`;
        }).join('');
      }
    },

    volume: {
      build() {
        return `<div class="pin">
          <div class="ph"><h2>Volym</h2><small>Scrolla på widgeten för att justera</small></div>
          <div class="vol" style="display:grid">
            <button class="mbtn" data-cmd="mute" title="Ljud av/på" aria-label="Ljud av eller på">${I.volume}</button>
            <input type="range" id="vol" min="0" max="100" step="1" value="50" aria-label="Volym">
            <output id="volOut">50</output>
          </div>
        </div>`;
      },
      update() {
        if (!stats || stats.volume == null || draggingVol) return;
        const v = popEl.querySelector('#vol');
        v.value = Math.round(stats.volume * 100); setFill(v);
        popEl.querySelector('#volOut').textContent = stats.mute ? 'Av' : v.value;
        popEl.querySelector('[data-cmd=mute]').innerHTML = stats.mute ? I.mute : stats.volume < 0.4 ? I.volumeLow : I.volume;
      }
    }
  };

  P.search = {
    build() {
      L = { q: '', sel: 0, items: [], files: [], fileQ: '', searchId: L.searchId };
      return `<div class="launcher">
        <label class="lsearch"><span class="lsi">${I.search}</span>
          <input id="lq" type="text" placeholder="Sök appar, filer och inställningar" autocomplete="off" spellcheck="false" aria-label="Sök" aria-controls="lres"></label>
        <div class="lres" id="lres" role="listbox"></div>
        <div class="lfoot"><span><kbd>↑</kbd><kbd>↓</kbd> välj</span><span><kbd>Enter</kbd> öppna</span><span><kbd>Esc</kbd> stäng</span><span class="lfr">${S.general.winKey ? '<kbd>Win</kbd>' : S.general.winS ? '<kbd>Win</kbd>+<kbd>S</kbd>' : '<kbd>Alt</kbd>+<kbd>Mellanslag</kbd>'}</span></div>
      </div>`;
    },
    update() {
      renderLauncher();
      const inp = popEl.querySelector('#lq');
      if (inp && document.activeElement !== inp) setTimeout(() => inp.focus(), 20);
    }
  };

  /* ---------- Control center: quick toggles + volume mixer ---------- */
  let mixer = null;          // last 'mixer' snapshot from the helper
  let ccDrag = null;         // key of the slider being dragged ('master' or an app key)
  let ccOutOpen = false;     // output device list expanded
  let ccPoll = null;
  let ccSheet = null;        // 'power' | 'epic': the choice sheet under the tiles
  let ccEpic = null, ccEpicBusy = false, ccEpicMsg = null;
  function ccEpicActiveName() {
    if (!ccEpic) return '';
    if (ccEpicBusy) return 'Byter…';
    const a = ccEpic.accounts.find(x => x.active);
    return a ? a.name : ccEpic.accounts.length ? 'Byt konto' : 'Lägg till';
  }
  function ccEpicRefresh(p) {
    return (p || api.epic({ cmd: 'state' })).then(st => {
      ccEpic = st;
      if (st && st.error) ccEpicMsg = { text: st.error, err: true };
      if (openId === 'control') P.control.update();
    });
  }
  if (!SPOT) ccEpicRefresh();
  const ccIcons = new Map(); // exe path -> icon data URL

  function ccTile(id, icon, label, sub, on, disabled) {
    return `<button class="cct${on ? ' on' : ''}" data-cc="${id}"${disabled ? ' disabled' : ''} aria-pressed="${!!on}">
      <span class="ccti">${I[icon]}</span><span class="cctl">${esc(label)}</span><span class="ccts">${esc(sub || '')}</span></button>`;
  }
  function ccAppIcon(a) {
    if (a.key === 'system') return `<span class="ccai svg">${I.volume}</span>`;
    const src = ccIcons.get(a.path);
    if (src) return `<span class="ccai"><img src="${src}" alt=""></span>`;
    if (a.path && !ccIcons.has(a.path)) {
      ccIcons.set(a.path, null);
      api.appIcon(a.path).then(d => { ccIcons.set(a.path, d); if (openId === 'control') P.control.update(true); });
    }
    return `<span class="ccai letter">${esc((a.name || '?')[0])}</span>`;
  }
  function ccSlider(key, value, muted, label) {
    return `<input type="range" class="ccs" min="0" max="100" step="1" value="${Math.round(value * 100)}" data-key="${esc(key)}" aria-label="${esc(label)}"${muted ? ' data-muted="1"' : ''}>`;
  }

  P.control = {
    build() {
      ccOutOpen = false;
      api.mixer({ cmd: 'mixer' });
      clearInterval(ccPoll);
      let tick = 0;
      ccPoll = setInterval(() => {
        if (openId !== 'control') { clearInterval(ccPoll); return; }
        api.mixer({ cmd: 'mixer' });
        // While the Epic sheet is open, notice a sign-in in Epic within a few seconds
        if (ccSheet === 'epic' && !ccEpicBusy && ++tick % 2 === 0) ccEpicRefresh();
      }, 1200);
      ccSheet = null; ccEpicMsg = null;
      return `<div class="cc"><div class="cctiles"></div><div class="ccsheet" hidden></div><div class="ccaudio"></div></div>`;
    },
    update(force) {
      const box = popEl.querySelector('.cc'); if (!box) return;
      const m = mixer || {};
      const bt = m.bluetooth !== undefined ? m.bluetooth : stats && stats.bluetooth;
      let netTile;
      if (m.wifi) netTile = ccTile('wifi', 'wifi', 'Wi-Fi', m.wifi === 'On' ? 'På' : 'Av', m.wifi === 'On');
      else netTile = ccTile('network', m.net === 'wifi' ? 'wifi' : 'ethernet', 'Nätverk', m.net === 'ethernet' ? 'Ethernet' : m.net === 'wifi' ? 'Wi-Fi' : m.net === null ? 'Ej ansluten' : '', !!m.net);
      box.querySelector('.cctiles').innerHTML =
        ccTile('bluetooth', 'bluetooth', 'Bluetooth', !bt ? 'Saknas' : bt === 'On' ? 'På' : 'Av', bt === 'On', !bt) +
        netTile +
        ccTile('mic', m.mic ? 'micOff' : 'mic', 'Mikrofon', m.mic == null ? 'Saknas' : m.mic ? 'Avstängd' : 'På', m.mic === false, m.mic == null) +
        ccTile('display', 'display', 'Skärm', 'Inställningar', false) +
        ccTile('epic', 'gamepad', 'Epic Games', ccEpicActiveName(), ccSheet === 'epic') +
        ccTile('power', 'power', 'Ström', 'Av / omstart', ccSheet === 'power');
      // Sheet under the tiles for the power and Epic choices
      const sheet = box.querySelector('.ccsheet');
      if (ccSheet === 'power') {
        sheet.hidden = false;
        if (sheet.dataset.kind !== 'power') {
          sheet.dataset.kind = 'power';
          sheet.innerHTML = `<div class="ccsh">Vill du stänga av eller starta om datorn?</div>
            <div class="ccpow"><button class="ccbig" data-cc="restart">${I.restart}<span>Starta om</span></button>
            <button class="ccbig danger" data-cc="shutdown">${I.power}<span>Stäng av</span></button></div>`;
        }
      } else if (ccSheet === 'epic') {
        sheet.hidden = false;
        const st = ccEpic;
        const key = JSON.stringify([st, ccEpicBusy, ccEpicMsg]);
        if (sheet.dataset.kind !== 'epic' || sheet.dataset.key !== key) {
          sheet.dataset.kind = 'epic'; sheet.dataset.key = key;
          const typed = sheet.querySelector('#epicName') ? sheet.querySelector('#epicName').value : '';
          if (!st) sheet.innerHTML = `<div class="ccsh">Läser Epic-konton…</div>`;
          else if (!st.installed) sheet.innerHTML = `<div class="ccsh">Epic Games Launcher hittades inte på den här datorn.</div>`;
          else {
            sheet.innerHTML = `<div class="ccsh">Epic Games-konton</div>
              ${st.accounts.length ? `<div class="ccepics">${st.accounts.map(a => `<div class="ccepic${a.active ? ' on' : ''}">
                <button class="ccepicb" data-epic="${esc(a.id)}"${ccEpicBusy ? ' disabled' : ''}><span class="ccav">${esc((a.name || '?')[0].toUpperCase())}</span><span class="ccen">${esc(a.name)}</span>${a.active && st.signedIn ? `<span class="ccok">${I.check} Inloggad</span>` : !a.hasLogin ? `<span class="ccwarn">Logga in igen</span>` : ''}</button>
                <button class="ccx" data-epicdel="${esc(a.id)}" title="Ta bort ${esc(a.name)} från listan" aria-label="Ta bort ${esc(a.name)}">×</button></div>`).join('')}</div>` : ''}
              ${st.signedIn && !st.currentSaved
                ? `<div class="ccnote">Du är inloggad i Epic på ett konto som inte är sparat. Ge det ett namn:</div>
                   <form class="ccadd" id="epicAdd"><input id="epicName" maxlength="40" placeholder="T.ex. Huvudkonto" value="${esc(typed)}" autocomplete="off"><button type="submit">Spara</button></form>`
                : !st.signedIn
                ? `<div class="ccnote">Epic visar inloggningssidan. Logga in där (Xbox går bra). När du är inloggad dyker en ruta upp här där du ger kontot ett namn.</div>`
                : `<button class="ccaddbtn" data-epicnew="1"${ccEpicBusy ? ' disabled' : ''}>${I.plus} Lägg till konto</button>`}
              <div class="ccnote dim">Byt konto här i stället för att logga ut i Epic. Att logga ut gör den sparade inloggningen ogiltig.</div>
              ${ccEpicMsg ? `<div class="ccnote${ccEpicMsg.err ? ' err' : ''}">${esc(ccEpicMsg.text)}</div>` : ''}`;
          }
        }
      } else { sheet.hidden = true; sheet.dataset.kind = ''; sheet.innerHTML = ''; }

      // Audio: output device, master volume, then one row per app
      const audio = box.querySelector('.ccaudio');
      const outs = m.outputs || [];
      const def = outs.find(o => o.isDefault);
      const apps = m.apps || [];
      const sig = JSON.stringify([outs.map(o => o.id + o.isDefault), apps.map(a => a.key), ccOutOpen, [...ccIcons.values()].filter(Boolean).length]);
      if (force || audio.dataset.sig !== sig) {
        audio.dataset.sig = sig;
        const vol = stats && stats.volume != null ? stats.volume : 0;
        audio.innerHTML = `
          <button class="ccout" data-cc="outputs" aria-expanded="${ccOutOpen}"><span class="ccoi">${I.headphones}</span><span class="ccon">${esc(def ? def.name : 'Ljudutgång')}</span><span class="ccoc">${ccOutOpen ? I.up : I.down}</span></button>
          ${ccOutOpen ? `<div class="ccoutlist">${outs.map(o => `<button class="ccorow${o.isDefault ? ' on' : ''}" data-out="${esc(o.id)}"><span>${esc(o.name)}</span>${o.isDefault ? I.check : ''}</button>`).join('')}</div>` : ''}
          <div class="ccrow master"><button class="ccai svg ccmute" data-mute="master" title="Ljud av/på">${stats && stats.mute ? I.mute : I.volume}</button>
            <div class="ccrt"><span class="ccn">Huvudvolym</span>${ccSlider('master', vol, stats && stats.mute, 'Huvudvolym')}</div><output class="ccv">${Math.round(vol * 100)}</output></div>
          ${apps.length ? `<div class="ccsec">Appar</div>` : `<div class="ccempty">Inga appar spelar upp ljud just nu</div>`}
          ${apps.map(a => `<div class="ccrow${a.mute ? ' muted' : ''}" data-row="${esc(a.key)}"><button class="ccmute" data-mute="${esc(a.key)}" title="${a.mute ? 'Slå på ljudet' : 'Stäng av ljudet'}">${ccAppIcon(a)}</button>
            <div class="ccrt"><span class="ccn">${esc(a.name)}</span>${ccSlider(a.key, a.volume, a.mute, a.name)}</div><output class="ccv">${Math.round(a.volume * 100)}</output></div>`).join('')}
          <button class="cclink" data-cc="mixerSettings">Fler ljudinställningar</button>`;
        audio.querySelectorAll('.ccs').forEach(setFill);
      } else {
        // Same rows: refresh values in place, but never the slider being dragged
        const setRow = (key, v, muted) => {
          if (ccDrag === key) return;
          const r = audio.querySelector(`.ccs[data-key="${CSS.escape(key)}"]`); if (!r) return;
          r.value = Math.round(v * 100); setFill(r);
          r.closest('.ccrow').querySelector('.ccv').textContent = r.value;
          r.closest('.ccrow').classList.toggle('muted', !!muted);
        };
        if (stats && stats.volume != null) {
          setRow('master', stats.volume, stats.mute);
          const mb = audio.querySelector('[data-mute=master]'); if (mb) mb.innerHTML = stats.mute ? I.mute : I.volume;
        }
        apps.forEach(a => setRow(a.key, a.volume, a.mute));
      }
    }
  };

  P.windows = {
    build() {
      const it = appItems.get(popKey);
      return `<div class="pin"><div class="ph"><h2>${esc(it ? it.name : 'Fönster')}</h2><small class="cnt"></small></div><div class="list wins"></div>
        <div><button class="chip" data-newwin="1">${I.plus} Nytt fönster</button></div></div>`;
    },
    update() {
      const wins = windowGroups().get(popKey) || [];
      if (!wins.length) { closePop(); return; }
      popEl.querySelector('.cnt').textContent = wins.length + ' fönster';
      popEl.querySelector('.wins').innerHTML = wins.map(w =>
        `<button class="winrow${w.hwnd === windows.active ? ' on' : ''}" data-hwnd="${w.hwnd}"><span class="n">${esc(w.title)}</span>${w.min ? '<span class="m">minimerat</span>' : ''}</button>`).join('');
    }
  };

  function setFill(r) {
    const p = (r.value - r.min) / ((r.max - r.min) || 1) * 100;
    r.style.setProperty('--p', p + '%');
  }

  let draggingSeek = false, draggingVol = false;
  let popAnchor = null;

  function paintVolIcon(el) {
    const b = el.querySelector('.vbtn');
    if (!b || !stats) return;
    b.innerHTML = stats.mute || stats.volume === 0 ? I.mute : stats.volume < 0.4 ? I.volumeLow : I.volume;
  }

  /* ---------- Weather ---------- */
  let weather = null;
  function weatherInfo(code, day) {
    const c = Number(code);
    if (c === 0) return { icon: day ? 'sun' : 'moon', text: 'Klart' };
    if (c === 1 || c === 2) return { icon: day ? 'cloudSun' : 'cloudMoon', text: c === 1 ? 'Mestadels klart' : 'Halvklart' };
    if (c === 3) return { icon: 'cloud', text: 'Mulet' };
    if (c === 45 || c === 48) return { icon: 'fog', text: 'Dimma' };
    if (c >= 51 && c <= 57) return { icon: 'rain', text: 'Duggregn' };
    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { icon: 'rain', text: c >= 80 ? 'Regnskurar' : 'Regn' };
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { icon: 'snow', text: 'Snö' };
    if (c >= 95) return { icon: 'storm', text: 'Åska' };
    return { icon: 'cloud', text: 'Väder' };
  }

  /* ---------- Launcher (search + start) ---------- */
  let appIndex = [];
  const iconCacheR = new Map();
  const SETTINGS_ITEMS = [
    ['Bluetooth och enheter', 'ms-settings:bluetooth', 'bluetooth hörlurar mus tangentbord'],
    ['Wi-Fi', 'ms-settings:network-wifi', 'wifi trådlöst nätverk internet'],
    ['Nätverk och internet', 'ms-settings:network', 'ethernet vpn proxy'],
    ['Ljud', 'ms-settings:sound', 'högtalare mikrofon volym utgång'],
    ['Bildskärm', 'ms-settings:display', 'skärm upplösning skalning hdr ljusstyrka'],
    ['Nattläge', 'ms-settings:nightlight', 'blått ljus kväll'],
    ['Bakgrund', 'ms-settings:personalization-background', 'skrivbordsbakgrund tapet'],
    ['Färger och tema', 'ms-settings:colors', 'mörkt läge ljust läge accent'],
    ['Aktivitetsfältet', 'ms-settings:taskbar', 'taskbar dölj automatiskt'],
    ['Appar och funktioner', 'ms-settings:appsfeatures', 'avinstallera program'],
    ['Standardappar', 'ms-settings:defaultapps', 'webbläsare öppna med'],
    ['Autostart-appar', 'ms-settings:startupapps', 'starta med windows'],
    ['Windows Update', 'ms-settings:windowsupdate', 'uppdateringar'],
    ['Lagring', 'ms-settings:storagesense', 'disk utrymme rensa'],
    ['Energi och batteri', 'ms-settings:powersleep', 'ström viloläge batteri'],
    ['Mus', 'ms-settings:mousetouchpad', 'pekplatta muspekare'],
    ['Skrivare och skannrar', 'ms-settings:printers', 'skriv ut'],
    ['Glimt-inställningar', 'glimt', 'docka widgets utseende']
  ];
  let L = { q: '', sel: 0, items: [], files: [], fileQ: '', searchId: 0 };
  let fileTimer;

  function score(name, q, extra = '') {
    const n = name.toLowerCase();
    if (n === q) return 100;
    if (n.startsWith(q)) return 85;
    if (n.split(/[\s\-_.()]+/).some(w => w.startsWith(q))) return 70;
    const initials = n.split(/[\s\-_.]+/).map(w => w[0]).join('');
    if (q.length >= 2 && initials.startsWith(q)) return 60;
    if (n.includes(q)) return 50;
    if (extra && extra.split(' ').some(w => w.startsWith(q))) return 40;
    return 0;
  }

  // Small arithmetic parser for "12*3,5" style queries (no eval: the page's CSP forbids it anyway)
  function calc(input) {
    const s = input.replace(/\s+/g, '').replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
    if (!/^[\d.+\-*/()^%]+$/.test(s) || !/[+\-*/^%]/.test(s.replace(/^-/, '')) || !/\d/.test(s)) return null;
    let i = 0;
    const peek = () => s[i];
    function num() {
      if (peek() === '(') { i++; const v = add(); if (s[i++] !== ')') throw 0; return v; }
      if (peek() === '-') { i++; return -num(); }
      const m = /^\d*\.?\d+/.exec(s.slice(i)); if (!m) throw 0;
      i += m[0].length; let v = parseFloat(m[0]);
      if (peek() === '%') { i++; v /= 100; }
      return v;
    }
    function pow() { let v = num(); while (peek() === '^') { i++; v = Math.pow(v, num()); } return v; }
    function mul() { let v = pow(); while (peek() === '*' || peek() === '/') { const o = s[i++]; const r = pow(); v = o === '*' ? v * r : v / r; } return v; }
    function add() { let v = mul(); while (peek() === '+' || peek() === '-') { const o = s[i++]; const r = mul(); v = o === '+' ? v + r : v - r; } return v; }
    try { const v = add(); if (i !== s.length || !isFinite(v)) return null; return v; } catch { return null; }
  }

  function buildResults() {
    const q = L.q.trim().toLowerCase();
    const items = [];
    if (!q) {
      appIndex.forEach(a => items.push({ sec: 'Alla appar', title: a.name, kind: a.kind, path: a.path, id: a.id, app: true }));
      return items;
    }
    const c = calc(L.q);
    if (c !== null) items.push({ sec: 'Kalkylator', title: '= ' + c.toLocaleString('sv-SE', { maximumFractionDigits: 10 }), sub: 'Enter kopierar svaret', kind: 'calc', value: String(c).replace('.', ','), icon: 'calc' });
    const apps = appIndex.map(a => ({ a, s: score(a.name, q) })).filter(x => x.s > 0).sort((x, y) => y.s - x.s || x.a.name.length - y.a.name.length).slice(0, 6);
    apps.forEach(({ a }) => items.push({ sec: 'Appar', title: a.name, sub: a.kind === 'uwp' ? 'App' : 'Program', kind: a.kind, path: a.path, id: a.id, app: true }));
    const sets = SETTINGS_ITEMS.map(([t, uri, kw]) => ({ t, uri, s: score(t, q, kw) })).filter(x => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
    sets.forEach(x => items.push({ sec: 'Inställningar', title: x.t, sub: x.uri === 'glimt' ? 'Glimt' : 'Windows inställningar', kind: x.uri === 'glimt' ? 'glimt' : 'uri', uri: x.uri, icon: 'gear' }));
    if (L.fileQ === q) L.files.forEach(f => items.push({ sec: 'Filer', title: f.name, sub: f.path, kind: 'file', path: f.path, icon: f.folder ? 'folder' : 'file', fileIcon: !f.folder }));
    items.push({ sec: 'Webben', title: `Sök efter "${L.q.trim()}" på webben`, sub: 'Öppnas i din webbläsare', kind: 'uri', uri: 'https://www.google.com/search?q=' + encodeURIComponent(L.q.trim()), icon: 'globe' });
    return items;
  }

  function iconFor(it) {
    if (it.icon && !it.fileIcon) return `<span class="lico svg">${I[it.icon]}</span>`;
    const key = it.path || it.id;
    const src = key && iconCacheR.get(key);
    if (src) return `<span class="lico"><img src="${src}" alt=""></span>`;
    if (key && it.path && !iconCacheR.has(key)) {
      iconCacheR.set(key, null);
      api.appIcon(it.path).then(d => { iconCacheR.set(key, d); if (d) popEl.querySelectorAll(`[data-ikey="${CSS.escape(key)}"]`).forEach(n => { n.innerHTML = `<img src="${d}" alt="">`; n.classList.remove('letter'); }); });
    }
    if (it.icon) return `<span class="lico svg" data-ikey="${esc(key)}">${I[it.icon]}</span>`;
    return `<span class="lico letter" data-ikey="${esc(key || '')}">${esc((it.title || '?')[0])}</span>`;
  }

  function renderLauncher() {
    const box = popEl.querySelector('#lres');
    if (!box) return;
    L.items = buildResults();
    if (L.sel >= L.items.length) L.sel = Math.max(0, L.items.length - 1);
    let html = '';
    if (!L.q.trim() && (S.apps || []).length) {
      html += `<div class="lsec">Fästa</div><div class="lgrid">${S.apps.map((a, i) =>
        `<button class="lpin" data-pin="${i}" title="${esc(a.name)}">${iconFor({ title: a.name, path: a.path })}<span>${esc(a.name)}</span></button>`).join('')}</div>`;
    }
    let sec = null;
    L.items.forEach((it, i) => {
      if (it.sec !== sec) { sec = it.sec; html += `<div class="lsec">${sec}</div>`; }
      html += `<button class="lrow${i === L.sel ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${i === L.sel}">
        ${iconFor(it)}<span class="ltxt"><span class="lt">${esc(it.title)}</span>${it.sub ? `<span class="ls">${esc(it.sub)}</span>` : ''}</span>
        ${i === L.sel ? `<span class="lkey">${I.enter}</span>` : ''}</button>`;
    });
    if (!L.items.length) html += `<div class="lempty">Laddar appar…</div>`;
    box.innerHTML = html;
    const selEl = box.querySelector('.lrow.sel');
    if (selEl && L.q.trim()) selEl.scrollIntoView({ block: 'nearest' });
  }

  function activate(it) {
    if (!it) return;
    if (it.kind === 'calc') { try { navigator.clipboard.writeText(it.value); } catch {} }
    else if (it.kind === 'glimt') api.openItem({ kind: 'glimt' });
    else api.openItem({ kind: it.kind, path: it.path, id: it.id, uri: it.uri });
    closePop(it.kind === 'calc'); setIgnore(true);
  }

  function onLauncherInput(v) {
    L.q = v; L.sel = 0;
    renderLauncher();
    clearTimeout(fileTimer);
    const q = v.trim().toLowerCase();
    if (q.length >= 2) {
      fileTimer = setTimeout(() => { L.searchId++; api.searchFiles(q, L.searchId); L.pendingQ = q; }, 180);
    }
  }

  function openPop(id, anchor) {
    if (openId === id) return closePop();
    openId = id;
    popAnchor = anchor;
    popEl.innerHTML = P[id].build();
    popEl.style.width = id === 'media' ? '340px' : id === 'control' ? '360px' :id === 'search' ? (SPOT ? '600px' : '560px') : '320px';
    popEl.classList.toggle('launcher-pop', id === 'search');
    popEl.classList.add('show');
    placePop(anchor);
    mounted.forEach(m => m.el.classList.toggle('open', m.id === id));
    setIgnore(false);
    if (!SPOT) api.focusDock();
    P[id].update();
    soonRegion();
  }
  function placePop(anchor) {
    if (SPOT || !anchor) {
      popEl.style.left = '0px'; popEl.style.top = '0px'; popEl.style.bottom = '';
      return;
    }
    const r = anchor.getBoundingClientRect();
    const w = popEl.offsetWidth || 340;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    popEl.style.left = left + 'px';
    if (S.look.position === 'top') { popEl.style.top = (r.bottom + 12) + 'px'; popEl.style.bottom = ''; }
    else { popEl.style.bottom = (window.innerHeight - r.top + 12) + 'px'; popEl.style.top = ''; }
  }
  function closePop(restore = true) {
    openId = null;
    popAnchor = null;
    popEl.classList.remove('show');
    popEl.innerHTML = '';
    mounted.forEach(m => m.el.classList.remove('open'));
    if (SPOT) api.hideSpot(restore); else soonRegion();
  }
  function updatePop() { if (openId && P[openId]) P[openId].update(); }

  // Tell main where the visible glass is (dock bar + open popover) so Windows blurs exactly that
  let lastRegion = '';
  function reportRegion() {
    if (SPOT) return;
    const rects = [];
    const d = dockEl.getBoundingClientRect();
    if (d.width && d.height) rects.push([d.left, d.top, d.width, d.height, S.look.layout === 'full' ? 0 : S.look.radius * S.look.scale]);
    if (openId && popEl.classList.contains('show') && popEl.offsetWidth) {
      rects.push([popEl.offsetLeft, popEl.offsetTop, popEl.offsetWidth, popEl.offsetHeight, S.look.radius]);
    }
    const key = JSON.stringify(rects.map(r => r.map(n => Math.round(n))));
    if (key === lastRegion) return;
    lastRegion = key;
    api.setRegion(rects);
  }
  function soonRegion() { requestAnimationFrame(() => requestAnimationFrame(reportRegion)); }
  if (!SPOT) {
    setInterval(reportRegion, 300);
    new ResizeObserver(soonRegion).observe(dockEl);
    new ResizeObserver(soonRegion).observe(popEl);
    window.addEventListener('resize', soonRegion);
  }

  /* ---------- Input ---------- */
  let ignoring = true;
  function setIgnore(v) { if (SPOT) return; if (v !== ignoring) { ignoring = v; api.setIgnore(v); } }
  document.addEventListener('mousemove', e => {
    setIgnore(!(openId || e.target.closest('.dock, .pop')));
  });
  document.addEventListener('mouseleave', () => { if (!openId) setIgnore(true); });

  dockEl.addEventListener('click', e => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) { e.stopPropagation(); sendCmd(cmd.dataset.cmd); return; }
    const w = e.target.closest('.w');
    const def = w && W[w.dataset.id];
    if (!def) return;
    if (def.click) {
      const wasOpen = openId === 'search' && popAnchor === w;
      closePop();
      if (!wasOpen) def.click(w);
    }
    else if (def.pop) openPop(w.dataset.id, w);
  });
  dockEl.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('w')) { e.preventDefault(); e.target.click(); }
  });
  dockEl.addEventListener('contextmenu', e => { e.preventDefault(); api.dockMenu(); });

  $('#stage').addEventListener('mousedown', e => {
    if (openId && !e.target.closest('.dock, .pop')) { closePop(); setIgnore(true); }
  });
  window.addEventListener('blur', () => { if (openId) { closePop(false); setIgnore(true); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openId) { closePop(); setIgnore(true); } });

  popEl.addEventListener('keydown', e => {
    if (openId !== 'search' || e.target.id !== 'lq') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = L.items.length; if (!n) return;
      L.sel = (L.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderLauncher();
      popEl.querySelector('.lrow.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(L.items[L.sel]);
    }
  });

  popEl.addEventListener('click', e => {
    if (openId === 'control') return onControlClick(e);
    const row = e.target.closest('.lrow');
    if (row) { activate(L.items[+row.dataset.i]); return; }
    const pin = e.target.closest('.lpin');
    if (pin) { const a = S.apps[+pin.dataset.pin]; if (a) activate({ kind: 'lnk', path: a.path }); return; }
    const wr = e.target.closest('[data-hwnd]');
    if (wr) { api.winFocus(Number(wr.dataset.hwnd)); closePop(); setIgnore(true); return; }
    if (e.target.closest('[data-newwin]')) { const it = appItems.get(popKey); if (it) api.launch(it.path); closePop(); setIgnore(true); return; }
    const cmd = e.target.closest('[data-cmd]');
    if (cmd && !cmd.disabled) return sendCmd(cmd.dataset.cmd);
    const src = e.target.closest('[data-src]');
    if (src) {
      const id = src.dataset.src || null;
      S.media.source = id;
      api.setSettings({ media: { source: id } });
      updatePop();
      return;
    }
    const os = e.target.closest('[data-open-src]');
    if (os) api.openSourceApp(os.dataset.openSrc);
  });
  function onControlClick(e) {
    const m = mixer || {};
    const del = e.target.closest('[data-epicdel]');
    if (del) { ccEpicMsg = null; ccEpicRefresh(api.epic({ cmd: 'remove', id: del.dataset.epicdel })); return; }
    if (e.target.closest('[data-epicnew]')) {
      ccEpicBusy = true; ccEpicMsg = { text: 'Epic startas om på inloggningssidan…' }; P.control.update();
      ccEpicRefresh(api.epic({ cmd: 'addnew' })).then(() => {
        ccEpicBusy = false;
        if (!(ccEpicMsg && ccEpicMsg.err)) ccEpicMsg = null;
        if (openId === 'control') P.control.update();
      });
      return;
    }
    const ep = e.target.closest('[data-epic]');
    if (ep && !ep.disabled) {
      const acc = ccEpic && ccEpic.accounts.find(a => a.id === ep.dataset.epic);
      if (!acc || (acc.active && ccEpic.signedIn)) return;
      ccEpicBusy = true; ccEpicMsg = { text: `Byter till ${acc.name}. Epic startas om…` }; P.control.update();
      ccEpicRefresh(api.epic({ cmd: 'switch', id: acc.id })).then(() => {
        ccEpicBusy = false;
        if (!(ccEpicMsg && ccEpicMsg.err)) ccEpicMsg = { text: acc.hasLogin
          ? `Epic öppnas med ${acc.name}. Om Epic ändå ber dig logga in: logga in på ${acc.name}, så sparas det automatiskt.`
          : `Logga in på ${acc.name} i Epic, så sparas inloggningen automatiskt.` };
        if (openId === 'control') P.control.update();
      });
      return;
    }
    const out = e.target.closest('[data-out]');
    if (out) { ccOutOpen = false; m.outputs && m.outputs.forEach(o => { o.isDefault = o.id === out.dataset.out; }); api.mixer({ cmd: 'output', id: out.dataset.out }); P.control.update(true); return; }
    const mu = e.target.closest('[data-mute]');
    if (mu) {
      const key = mu.dataset.mute;
      if (key === 'master') { sendCmd('mute'); P.control.update(true); return; }
      const a = (m.apps || []).find(x => x.key === key);
      if (a) { a.mute = !a.mute; api.mixer({ cmd: 'appmute', key, on: a.mute }); P.control.update(true); }
      return;
    }
    const t = e.target.closest('[data-cc]');
    if (!t || t.disabled) return;
    const id = t.dataset.cc;
    if (id === 'bluetooth') {
      const on = (m.bluetooth || (stats && stats.bluetooth)) !== 'On';
      m.bluetooth = on ? 'On' : 'Off'; if (stats) stats.bluetooth = m.bluetooth;   // optimistic; the helper confirms
      api.setBluetooth(on); P.control.update();
    } else if (id === 'wifi') {
      const on = m.wifi !== 'On'; m.wifi = on ? 'On' : 'Off';
      api.mixer({ cmd: 'wifi', on }); P.control.update();
    } else if (id === 'mic') {
      m.mic = !m.mic; api.mixer({ cmd: 'micmute', on: m.mic }); P.control.update();
    } else if (id === 'outputs') {
      ccOutOpen = !ccOutOpen; P.control.update(true);
    } else if (id === 'power' || id === 'epic') {
      ccSheet = ccSheet === id ? null : id; ccEpicMsg = null;
      if (id === 'epic' && ccSheet) ccEpicRefresh();
      P.control.update();
    } else if (id === 'restart' || id === 'shutdown') {
      // Chosen in the power sheet, which is the confirmation step
      closePop(); setIgnore(true); api.ccAction(id);
    } else if (['display', 'network', 'mixerSettings'].includes(id)) {
      closePop(); setIgnore(true); api.ccAction(id);
    }
  }
  let ccSendTimer, ccLastSend = 0;
  function onControlSlider(r) {
    const key = r.dataset.key, v = r.value / 100;
    ccDrag = key; setFill(r);
    r.closest('.ccrow').querySelector('.ccv').textContent = r.value;
    const send = () => {
      ccLastSend = Date.now();
      if (key === 'master') { if (stats) { stats.volume = v; stats.mute = false; } api.media({ cmd: 'volume', value: v }); updateWidget('volume'); }
      else { const a = mixer && (mixer.apps || []).find(x => x.key === key); if (a) a.volume = v; api.mixer({ cmd: 'appvol', key, value: v }); }
    };
    clearTimeout(ccSendTimer);
    if (Date.now() - ccLastSend > 50) send(); else ccSendTimer = setTimeout(send, 50);
  }

  popEl.addEventListener('submit', e => {
    if (e.target.id !== 'epicAdd') return;
    e.preventDefault();
    const name = (popEl.querySelector('#epicName') || {}).value || '';
    ccEpicMsg = null;
    ccEpicRefresh(api.epic({ cmd: 'save', name })).then(() => { if (!(ccEpicMsg && ccEpicMsg.err)) { ccEpicMsg = { text: 'Kontot är sparat.' }; if (openId === 'control') P.control.update(); } });
  });
  popEl.addEventListener('contextmenu', e => {
    if (openId === 'control' && e.target.closest('[data-cc=bluetooth]')) { e.preventDefault(); closePop(); setIgnore(true); api.ccAction('bluetoothSettings'); }
  });
  popEl.addEventListener('input', e => {
    if (e.target.classList.contains('ccs')) { onControlSlider(e.target); return; }
    if (e.target.id === 'lq') { onLauncherInput(e.target.value); return; }
    if (e.target.id === 'seek') {
      draggingSeek = true; setFill(e.target);
      popEl.querySelector('.cur').textContent = mmss(+e.target.value);
    }
    if (e.target.id === 'vol') {
      draggingVol = true; setFill(e.target);
      popEl.querySelector('#volOut').textContent = e.target.value;
      if (stats) { stats.volume = e.target.value / 100; stats.mute = false; }
      api.media({ cmd: 'volume', value: e.target.value / 100 });
      updateWidget('volume');
    }
  });
  popEl.addEventListener('change', e => {
    if (e.target.classList.contains('ccs')) { setTimeout(() => { ccDrag = null; }, 600); return; }
    if (e.target.id === 'seek') {
      const v = +e.target.value;
      api.media({ cmd: 'seek', value: v });
      if (media) { media.position = v; media.updatedAt = Date.now(); }
      draggingSeek = false;
    }
    if (e.target.id === 'vol') draggingVol = false;
  });

  function sendCmd(cmd) {
    if (cmd === 'mute') {
      if (stats) stats.mute = !stats.mute;
      updateWidget('volume'); updatePop();
    }
    if (cmd === 'toggle' && media && media.active) {
      // optimistic: flip the icon now, the helper confirms within a second
      media.position = mediaPos(); media.updatedAt = Date.now();
      media.status = media.status === 'Playing' ? 'Paused' : 'Playing';
      updateWidget('media'); updatePop();
    }
    api.media({ cmd });
  }

  /* ---------- Data feeds ---------- */
  api.onAppsIndex(list => { appIndex = list || []; if (openId === 'search') renderLauncher(); });
  api.onSearchResults(msg => {
    if (msg.id !== L.searchId || openId !== 'search') return;
    L.files = msg.results || []; L.fileQ = L.pendingQ;
    if (L.q.trim().toLowerCase() === L.fileQ) renderLauncher();
  });
  api.onOpenSearch(() => {
    if (openId === 'search') { popEl.querySelector('#lq')?.focus(); return; }
    if (SPOT) { openPop('search', null); return; }
    const a = mounted.find(m => m.id === 'search') || mounted.find(m => m.id === 'start');
    closePop();
    openPop('search', a ? a.el : dockEl);
  });
  api.onWeather(w => { weather = w; updateWidget('weather'); });
  api.onBluetooth(st => { if (stats) stats.bluetooth = st; if (mixer) mixer.bluetooth = st; if (openId === 'control') P.control.update(); });
  api.onEpicChanged(() => { if (!SPOT) ccEpicRefresh(); });
  api.onMixer(m => { mixer = m; if (openId === 'control') P.control.update(); });
  window.addEventListener('focus', () => { if (openId === 'search') popEl.querySelector('#lq')?.focus(); });

  api.onWindows(w => {
    windows = w;
    updateWidget('apps');
    if (openId === 'windows') updatePop();
  });

  api.onSettings(s => {
    const rebuild = JSON.stringify([s.widgets, s.apps, s.look.layout, s.general.showRunning]) !== JSON.stringify([S.widgets, S.apps, S.look.layout, S.general.showRunning]);
    const appsChanged = JSON.stringify(s.apps) !== JSON.stringify(S.apps);
    S = s;
    if (appsChanged) resolvePins();
    applyLook();
    if (SPOT) { /* no dock in the search window */ }
    else if (rebuild) buildDock(); else updateAll();
    if (openId) { const a = mounted.find(m => m.id === openId); if (a) placePop(a.el); updatePop(); }
  });

  api.onMedia(m => {
    const prevKey = media && media.trackKey;
    media = m;
    if (m.active && m.art && m.trackKey !== prevKey) extractColor(m.art);
    if (!m.active) { artColor = null; applyLook(); }
    updateWidget('media');
    if (openId === 'media') updatePop();
  });

  api.onStats(s => {
    stats = s;
    hist.down.push(s.netDown); hist.up.push(s.netUp);
    if (hist.down.length > HIST) { hist.down.shift(); hist.up.shift(); }
    if (!draggingVol) updateWidget('volume');
    updateWidget('net');
    updateWidget('bluetooth');
    if (openId && !['media', 'search', 'windows'].includes(openId)) updatePop();
    if (openId === 'media' && !draggingVol) updatePop();
  });

  api.onSys(s => {
    sys = s;
    hist.cpu.push(s.cpu);
    if (hist.cpu.length > HIST) hist.cpu.shift();
    ['cpu', 'ram', 'disk'].forEach(updateWidget);
    if (openId && !['media', 'volume', 'search', 'windows'].includes(openId)) updatePop();
  });

  if (navigator.getBattery) {
    try {
      battery = await navigator.getBattery();
      ['levelchange', 'chargingchange'].forEach(ev => battery.addEventListener(ev, () => updateWidget('battery')));
    } catch {}
  }

  // Smooth progress + clock
  setInterval(() => {
    mounted.filter(m => m.id === 'media').forEach(m => W.media.tick(m.el));
    if (openId === 'media') P.media.tick();
  }, 250);
  setInterval(() => updateWidget('clock'), 1000);

  const st = await api.getState();
  if (st.sys) sys = st.sys;
  if (st.stats) stats = st.stats;
  if (st.media) { media = st.media; if (media.art) extractColor(media.art); }
  if (st.windows) windows = st.windows;
  if (st.weather) weather = st.weather;
  if (st.apps && st.apps.length) appIndex = st.apps;

  applyLook();
  if (SPOT) {
    // Size the window to the panel so the empty part doesn't block clicks
    new ResizeObserver(() => { if (openId) api.spotSize(popEl.offsetHeight); }).observe(popEl);
    api.onSpotHidden(() => {
      if (!openId) return;
      openId = null; popEl.classList.remove('show'); popEl.innerHTML = '';
    });
  } else buildDock();
  resolvePins();
})();
