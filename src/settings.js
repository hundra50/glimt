// Glimt settings window. Every change applies immediately; there is no Save button.
(async () => {
  const api = window.glimt;
  const I = window.ICONS;
  const main = document.getElementById('main');
  const root = document.documentElement;
  let S = await api.getSettings();
  let state = await api.getState();
  let tab = (location.hash || '').slice(1) || 'widgets';

  const WIDGETS = {
    start:   { name: 'Start', desc: 'Öppnar Glimts startmeny (eller Windows, se Allmänt)', icon: 'apps' },
    search:  { name: 'Sök', desc: 'Sökfält i pillerform; söker appar, filer, inställningar och räknar', icon: 'search' },
    weather: { name: 'Väder', desc: 'Temperatur och en ikon för din ort', icon: 'cloudSun' },
    control: { name: 'Kontrollcenter', desc: 'Bluetooth, nätverk, mikrofon och volymmixer per app', icon: 'control' },
    apps:    { name: 'Appar och fönster', desc: 'Fästa program och allt som är öppet; klicka för att växla eller minimera', icon: 'apps' },
    media:   { name: 'Spelas nu', desc: 'Spotify, webbläsare och andra spelare via Windows', icon: 'music' },
    cpu:     { name: 'CPU', desc: 'Belastning med minigraf, kärnor och tyngsta processer', icon: 'cpu' },
    ram:     { name: 'RAM', desc: 'Använt minne och vilka appar som tar mest', icon: 'ram' },
    net:     { name: 'Nätverk', desc: 'Hastighet ned och upp just nu', icon: 'net' },
    disk:    { name: 'Lagring', desc: 'Ledigt utrymme på dina enheter', icon: 'disk' },
    battery: { name: 'Batteri', desc: 'Laddning för bärbara datorer', icon: 'battery' },
    volume:  { name: 'Volym', desc: 'Reglage direkt i dockan; klicka på högtalaren för att stänga av ljudet', icon: 'volume' },
    clock:   { name: 'Klocka', desc: 'Tid och datum', icon: 'clock' },
    spacer:  { name: 'Mellanrum', desc: 'Delar upp dockan; i hel bredd skjuter den isär grupperna', icon: 'spacer' }
  };
  const SWATCHES = ['#7cc4ff', '#5fd39a', '#f2c14e', '#ff8a5c', '#ff6b9a', '#b38cff', '#e8edf2'];

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function set(patch) { S = await api.setSettings(patch); }
  function theme() {
    root.classList.toggle('light', S.look.theme === 'light');
    root.style.setProperty('--accent', S.look.accent);
  }

  /* ---------- Building blocks ---------- */
  const toggle = (id, checked, label) =>
    `<label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} aria-label="${esc(label)}"><i></i></label>`;
  const card = (title, desc, control, icon) =>
    `<div class="card">${icon ? `<span class="ic">${I[icon] || ''}</span>` : ''}<div class="txt"><span>${title}</span>${desc ? `<small>${desc}</small>` : ''}</div>${control}</div>`;
  const range = (id, min, max, step, value, fmt) =>
    `<div class="rng"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><output for="${id}">${fmt(value)}</output></div>`;
  const seg = (id, options, value) =>
    `<div class="seg" id="${id}" role="radiogroup">${options.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === value}" data-v="${v}" class="${v === value ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  /* ---------- Pages ---------- */
  const pages = {
    welcome() {
      return `<div class="page">
        <h1>Välkommen till Glimt</h1>
        <div class="welcome">
          <b>Dockan ligger nu längst ned på skärmen.</b>
          <p>Klicka på låten för att öppna spelaren, på CPU eller RAM för detaljer, och scrolla på volymen för att ändra den. Högerklicka på dockan eller ikonen i systemfältet för fler val.</p>
          <p>Spelaren läser av Windows egna mediakontroller, så Spotify, YouTube i webbläsaren och andra spelare fungerar utan inloggning.</p>
          <div class="actions" style="margin-top:6px"><button class="btn primary" data-goto="widgets">Välj widgets</button><button class="btn" data-goto="look">Ändra utseendet</button></div>
        </div>
      </div>`;
    },

    widgets() {
      const list = S.widgets.map((w, i) => {
        const meta = WIDGETS[w.id] || { name: w.id, desc: '', icon: 'widgets' };
        const isSpacer = w.id === 'spacer';
        return `<div class="card${w.on ? '' : ' off'}" draggable="true" data-i="${i}">
          <span class="grip" title="Dra för att flytta">${I.grip}</span>
          <span class="ic">${I[meta.icon]}</span>
          <div class="txt"><span>${meta.name}</span><small>${meta.desc}</small></div>
          <button class="icon-btn" data-move="-1" data-i="${i}" title="Flytta vänster" aria-label="Flytta ${meta.name} vänster" ${i === 0 ? 'disabled' : ''}>${I.up}</button>
          <button class="icon-btn" data-move="1" data-i="${i}" title="Flytta höger" aria-label="Flytta ${meta.name} höger" ${i === S.widgets.length - 1 ? 'disabled' : ''}>${I.down}</button>
          ${isSpacer ? `<button class="icon-btn" data-del="${i}" title="Ta bort" aria-label="Ta bort mellanrum">${I.trash}</button>` : ''}
          ${toggle('w-' + i, w.on, 'Visa ' + meta.name)}
        </div>`;
      }).join('');
      return `<div class="page">
        <h1>Widgets</h1>
        <p class="lead">Slå på det du vill se i dockan. Ordningen här är ordningen från vänster till höger; dra korten eller använd pilarna.</p>
        <div class="group" id="wlist">${list}</div>
        <div class="actions"><button class="btn" id="addSpacer">${I.plus} Lägg till mellanrum</button></div>
      </div>`;
    },

    look() {
      const L = S.look;
      return `<div class="page">
        <h1>Utseende</h1>
        <div class="preview" id="preview"><div class="pv-dock" id="pvDock"><span class="a"></span><span class="a"></span><span class="m"></span><span class="s"></span><span class="s"></span></div></div>
        <div>
          <h2>Färger</h2>
          <div class="group">
            ${card('Tema', 'Ljust eller mörkt glas', seg('theme', [['dark', 'Mörkt'], ['light', 'Ljust']], L.theme), 'palette')}
            ${card('Accentfärg', 'Används för grafer, reglage och markeringar',
              `<div class="swatches">${SWATCHES.map(c => `<button class="sw${c === L.accent ? ' on' : ''}" data-sw="${c}" style="background:${c}" aria-label="Accentfärg ${c}"></button>`).join('')}<input type="color" id="accent" value="${L.accent}" aria-label="Egen accentfärg"></div>`)}
            ${card('Färga spelaren efter omslaget', 'Mediawidgeten tar färg från albumomslaget som spelas', toggle('accentFromArt', L.accentFromArt, 'Färga efter omslaget'))}
          </div>
        </div>
        <div>
          <h2>Glas och form</h2>
          <div class="group">
            ${card('Täckning', 'Hur mycket av bakgrunden som syns igenom', range('opacity', 0.2, 1, 0.01, L.opacity, v => Math.round(v * 100) + ' %'))}
            ${card('Oskärpa', 'Hur mycket det som ligger bakom dockan och panelerna suddas ut', seg('glass', [['off', 'Av'], ['light', 'Lätt'], ['strong', 'Stark']], L.glass || 'strong'))}
            ${card('Hörnradie', 'Från kantig till helt rund', range('radius', 4, 30, 1, L.radius, v => v + ' px'))}
            ${card('Storlek', 'Skalar hela dockan', range('scale', 0.8, 1.3, 0.05, L.scale, v => Math.round(v * 100) + ' %'))}
          </div>
        </div>
        <div>
          <h2>Placering</h2>
          <div class="group">
            ${card('Position', 'Var på skärmen dockan ligger', seg('position', [['bottom', 'Nederkant'], ['top', 'Överkant']], L.position))}
            ${card('Layout', 'Flytande i mitten eller över hela bredden', seg('layout', [['floating', 'Flytande'], ['full', 'Hel bredd']], L.layout))}
            ${card('Avstånd från kanten', '', range('margin', 0, 40, 1, L.margin, v => v + ' px'))}
            ${card('Visa etiketter', 'Små rubriker som "CPU" och "Volym" ovanför värdena', toggle('labels', L.labels, 'Visa etiketter'))}
          </div>
        </div>
        <div class="actions"><button class="btn" id="resetLook">Återställ utseendet</button></div>
      </div>`;
    },

    apps() {
      const list = (S.apps || []).map((a, i) => `<div class="card" data-i="${i}">
        <span class="ic" data-appicon="${i}">${I.apps}</span>
        <div class="txt"><span>${esc(a.name)}</span><small title="${esc(a.path)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.path)}</small></div>
        <button class="icon-btn" data-amove="-1" data-i="${i}" aria-label="Flytta upp" ${i === 0 ? 'disabled' : ''}>${I.up}</button>
        <button class="icon-btn" data-amove="1" data-i="${i}" aria-label="Flytta ned" ${i === S.apps.length - 1 ? 'disabled' : ''}>${I.down}</button>
        <button class="icon-btn" data-adel="${i}" title="Ta bort" aria-label="Ta bort ${esc(a.name)}">${I.trash}</button>
      </div>`).join('');
      return `<div class="page">
        <h1>Appar</h1>
        <p class="lead">Program som fästs i dockan. Välj en .exe-fil eller en genväg från Start-menyn.</p>
        <div class="group">${list || '<div class="empty">Inga appar fästa än.</div>'}</div>
        <div class="actions"><button class="btn primary" id="addApp">${I.plus} Lägg till app</button></div>
      </div>`;
    },

    media() {
      const m = state.media;
      const srcs = (m && m.sources) || [];
      const opts = [['', 'Automatiskt (det som spelas)']].concat(srcs.map(s => [s, s.replace(/\.exe$/i, '')]));
      if (S.media.source && !srcs.includes(S.media.source)) opts.push([S.media.source, S.media.source.replace(/\.exe$/i, '') + ' (inte igång)']);
      const now = m && m.active ? `${esc(m.title)} – ${esc(m.artist)} <span class="muted">(${esc(m.source)})</span>` : '<span class="muted">Inget spelas just nu</span>';
      return `<div class="page">
        <h1>Media</h1>
        <p class="lead">Glimt läser Windows mediakontroller. Allt som visar sig i Windows volymruta, som Spotify, YouTube i Chrome och Edge eller Mediaspelaren, går att styra härifrån.</p>
        <div class="group">
          ${card('Spelas nu', now, '', 'music')}
          ${card('Källa', 'Vilken spelare dockan följer när flera är igång',
            `<select id="source">${opts.map(([v, l]) => `<option value="${esc(v)}" ${(S.media.source || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
          ${card('Knappar i dockan', 'Föregående, spela/pausa och nästa direkt i dockan', toggle('dockControls', S.media.dockControls, 'Knappar i dockan'))}
          ${card('Volym i spelaren', 'Visa systemvolymen i den stora spelaren', toggle('showVolume', S.media.showVolume, 'Volym i spelaren'))}
        </div>
      </div>`;
    },

    general() {
      const G = S.general;
      const tb = state.taskbar;
      const autoHideOff = tb && tb.autoHide === false;
      const steps = `<ol class="steps">
          <li>Slå på <b>Dölj aktivitetsfältet automatiskt</b> i Windows. Annars står en tom remsa kvar där aktivitetsfältet satt.
            ${tb ? (autoHideOff ? '<span class="pill warn">Inte påslaget än</span>' : '<span class="pill ok">Påslaget</span>') : ''}
            <div><button class="btn" id="tbSettings">${I.external} Öppna Windows inställningar för aktivitetsfältet</button></div>
            <small class="muted">Där: Beteenden för aktivitetsfältet › Dölj aktivitetsfältet automatiskt.</small></li>
          <li>Slå på <b>Ersätt aktivitetsfältet</b> här nedanför.</li>
          <li>Slå på <b>Starta med Windows</b> så att dockan finns där när du loggar in.</li>
        </ol>`;
      return `<div class="page">
        <h1>Allmänt</h1>
        <div>
          <h2>Ersätt aktivitetsfältet</h2>
          ${steps}
          <div class="group">
            ${card('Ersätt aktivitetsfältet', 'Döljer Windows aktivitetsfält medan Glimt körs och reserverar dockans plats, så att maximerade fönster slutar ovanför. Avslutar du Glimt kommer aktivitetsfältet tillbaka.', toggle('replaceTaskbar', G.replaceTaskbar, 'Ersätt aktivitetsfältet'), 'apps')}
            ${card('Visa öppna fönster', 'Program som är igång visas i dockan med en markering; det aktiva får en längre färgad linje', toggle('showRunning', G.showRunning !== false, 'Visa öppna fönster'))}
          </div>
        </div>
        <div>
          <h2>Start och sök</h2>
          <div class="group">
            ${card('Start-knappen öppnar', 'Knappen längst till vänster i dockan.', seg('startButton', [['glimt', 'Glimts meny'], ['windows', 'Windows Start']], G.startButton || 'windows'), 'apps')}
            ${card('Windows-tangenten öppnar Glimt-sök', 'Sökrutan dyker upp mitt i övre delen av skärmen. Kortkommandon som Win + E fungerar som vanligt, och Ctrl + Esc öppnar fortfarande Windows Start.', toggle('winKey', !!G.winKey, 'Windows-tangenten öppnar Glimt-sök'), 'search')}
            ${card('Win + S öppnar Glimt-sök', 'Ersätter Windows egen sökruta', toggle('winS', G.winS !== false, 'Win + S öppnar Glimt-sök'), 'search')}
            ${card('Alt + Mellanslag öppnar sök', 'Snabbsök var du än är, som Spotlight på Mac', toggle('searchShortcut', G.searchShortcut !== false, 'Alt + Mellanslag öppnar sök'), 'search')}
          </div>
        </div>
        <div>
          <h2>Väder</h2>
          <div class="group">
            ${card('Ort', `Visar vädret för <b>${esc((S.weather && S.weather.name) || '–')}</b>. Data från Open-Meteo.`,
              `<form id="cityForm" class="actions"><input id="city" type="text" value="${esc((S.weather && S.weather.city) || '')}" aria-label="Ort" placeholder="t.ex. Göteborg"><button class="btn" type="submit">Spara</button></form>`, 'cloudSun')}
            <div id="cityMsg" class="muted" role="status"></div>
          </div>
        </div>
        <h2 style="margin-bottom:-14px">Beteende</h2>
        <div class="group">
          ${card('Alltid överst', 'Dockan ligger ovanpå andra fönster', toggle('alwaysOnTop', G.alwaysOnTop, 'Alltid överst'))}
          ${card('Göm vid helskärm', 'Döljer dockan när ett spel eller en video körs i helskärm', toggle('hideFullscreen', G.hideFullscreen, 'Göm vid helskärm'))}
          ${card('Lägg över aktivitetsfältet', 'Placera dockan ända nere i kanten, ovanpå Windows aktivitetsfält', toggle('overTaskbar', G.overTaskbar, 'Lägg över aktivitetsfältet'))}
          ${card('Starta med Windows', 'Glimt startar när du loggar in', toggle('startWithWindows', G.startWithWindows, 'Starta med Windows'))}
        </div>
      </div>`;
    },

    about() {
      return `<div class="page">
        <h1>Om Glimt</h1>
        <div class="group">
          ${card('Version 0.1.0', 'En smart docka för Windows 11', '', 'info')}
          ${card('Kortkommandon', 'Esc stänger en öppen widget. Scrolla på musiken eller volymen för att ändra volym. Högerklicka på dockan för menyn.', '', 'sliders')}
        </div>
        <div class="actions"><button class="btn danger" id="quit">Avsluta Glimt</button></div>
      </div>`;
    }
  };

  /* ---------- Render ---------- */
  function render() {
    theme();
    document.querySelectorAll('.side button').forEach(b => {
      b.classList.toggle('on', b.dataset.tab === tab);
      b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
    });
    const scroll = main.scrollTop;
    main.innerHTML = (pages[tab] || pages.widgets)();
    main.scrollTop = scroll;
    after();
  }

  function after() {
    if (tab === 'look') paintPreview();
    if (tab === 'apps') {
      (S.apps || []).forEach((a, i) => api.appIcon(a.path).then(src => {
        const el = main.querySelector(`[data-appicon="${i}"]`);
        if (el && src) el.innerHTML = `<img src="${src}" alt="">`;
      }));
    }
    if (tab === 'widgets') wireDrag();
  }

  function paintPreview() {
    const L = S.look, pv = document.getElementById('pvDock');
    if (!pv) return;
    const light = L.theme === 'light';
    pv.style.background = light ? `rgba(246,248,251,${L.opacity})` : `rgba(16,20,27,${L.opacity})`;
    pv.style.backdropFilter = { off: 'none', light: 'blur(6px)', strong: 'blur(14px)' }[L.glass || 'strong'];
    pv.style.borderRadius = Math.round(L.radius * 0.75) + 'px';
    pv.style.setProperty('--pv-accent', L.accent);
    pv.style.transform = `translateX(-50%) scale(${L.scale})`;
    pv.style.transformOrigin = L.position === 'top' ? '50% 0' : '50% 100%';
    pv.style.top = L.position === 'top' ? (L.margin / 2 + 6) + 'px' : '';
    pv.style.bottom = L.position === 'top' ? '' : (L.margin / 2 + 6) + 'px';
    pv.style.width = L.layout === 'full' ? 'calc(100% - 24px)' : '';
    pv.style.justifyContent = L.layout === 'full' ? 'space-between' : '';
    pv.querySelectorAll('span').forEach(s => s.style.background = light ? 'rgba(10,20,35,.12)' : '');
  }

  /* ---------- Events ---------- */
  document.querySelector('.side').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) { tab = b.dataset.tab; location.hash = tab; render(); }
  });
  document.querySelectorAll('.side [data-icon]').forEach(s => { s.innerHTML = I[s.dataset.icon]; });

  main.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.goto) { tab = t.dataset.goto; render(); return; }

    // widgets
    if (t.dataset.move) {
      const i = +t.dataset.i, j = i + +t.dataset.move;
      const w = S.widgets.slice(); [w[i], w[j]] = [w[j], w[i]];
      await set({ widgets: w }); render();
      main.querySelector(`[data-move="${t.dataset.move}"][data-i="${j}"]`)?.focus();
      return;
    }
    if (t.dataset.del) { const w = S.widgets.slice(); w.splice(+t.dataset.del, 1); await set({ widgets: w }); render(); return; }
    if (t.id === 'addSpacer') { await set({ widgets: S.widgets.concat([{ id: 'spacer', on: true }]) }); render(); return; }

    // look
    if (t.dataset.sw) { await set({ look: { accent: t.dataset.sw } }); render(); return; }
    const segEl = t.closest('.seg');
    if (segEl && t.dataset.v) {
      const key = segEl.id;
      await set(key === 'startButton' ? { general: { startButton: t.dataset.v } } : { look: { [key]: t.dataset.v } });
      render(); return;
    }
    if (t.id === 'resetLook') { S = await api.resetLook(); render(); return; }

    // apps
    if (t.id === 'addApp') {
      const a = await api.pickApp();
      if (a) { await set({ apps: (S.apps || []).concat([a]) }); render(); }
      return;
    }
    if (t.dataset.adel) { const a = S.apps.slice(); a.splice(+t.dataset.adel, 1); await set({ apps: a }); render(); return; }
    if (t.dataset.amove) {
      const i = +t.dataset.i, j = i + +t.dataset.amove;
      const a = S.apps.slice(); [a[i], a[j]] = [a[j], a[i]];
      await set({ apps: a }); render(); return;
    }

    if (t.id === 'tbSettings') { api.openTaskbarSettings(); return; }
    if (t.id === 'quit') api.quit();
  });

  main.addEventListener('change', async e => {
    const el = e.target;
    if (el.id.startsWith('w-')) {
      const i = +el.id.slice(2);
      const w = S.widgets.map((x, k) => k === i ? { ...x, on: el.checked } : x);
      await set({ widgets: w });
      el.closest('.card').classList.toggle('off', !el.checked);
      return;
    }
    if (el.id === 'accent') { await set({ look: { accent: el.value } }); render(); return; }
    if (el.id === 'accentFromArt' || el.id === 'labels') { await set({ look: { [el.id]: el.checked } }); return; }
    if (['dockControls', 'showVolume'].includes(el.id)) { await set({ media: { [el.id]: el.checked } }); return; }
    if (el.id === 'source') { await set({ media: { source: el.value || null } }); return; }
    if (['alwaysOnTop', 'hideFullscreen', 'overTaskbar', 'startWithWindows', 'replaceTaskbar', 'showRunning', 'searchShortcut', 'winKey', 'winS'].includes(el.id)) { await set({ general: { [el.id]: el.checked } }); return; }
  });

  main.addEventListener('submit', async e => {
    if (e.target.id !== 'cityForm') return;
    e.preventDefault();
    const msg = document.getElementById('cityMsg');
    const city = document.getElementById('city').value.trim();
    if (!city) { msg.textContent = 'Skriv namnet på en ort.'; return; }
    msg.textContent = 'Söker…';
    const r = await api.setWeatherCity(city);
    if (r.ok) { S = await api.getSettings(); render(); document.getElementById('cityMsg').textContent = 'Sparat: ' + r.name; }
    else msg.textContent = r.error;
  });

  // Range sliders apply live while dragging
  let rangeTimer;
  main.addEventListener('input', e => {
    const el = e.target;
    if (el.type !== 'range') return;
    const v = +el.value;
    const out = el.parentElement.querySelector('output');
    const fmt = { opacity: x => Math.round(x * 100) + ' %', scale: x => Math.round(x * 100) + ' %', blur: x => x + ' px', radius: x => x + ' px', margin: x => x + ' px' }[el.id];
    if (out && fmt) out.textContent = fmt(v);
    S.look[el.id] = v; paintPreview();
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => set({ look: { [el.id]: v } }), 40);
  });

  // Drag to reorder widgets
  function wireDrag() {
    const list = document.getElementById('wlist');
    if (!list) return;
    let from = null;
    list.addEventListener('dragstart', e => {
      const c = e.target.closest('.card'); if (!c) return;
      from = +c.dataset.i; c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    list.addEventListener('dragend', e => { e.target.closest('.card')?.classList.remove('dragging'); });
    list.addEventListener('dragover', e => {
      const c = e.target.closest('.card'); if (!c || from === null) return;
      e.preventDefault();
      list.querySelectorAll('.over').forEach(x => x.classList.remove('over'));
      c.classList.add('over');
    });
    list.addEventListener('drop', async e => {
      const c = e.target.closest('.card'); if (!c || from === null) return;
      e.preventDefault();
      const to = +c.dataset.i;
      const w = S.widgets.slice();
      const [item] = w.splice(from, 1);
      w.splice(to, 0, item);
      from = null;
      await set({ widgets: w }); render();
    });
  }

  api.onSettings(s => { S = s; theme(); if (tab === 'look') paintPreview(); });
  api.onMedia(m => {
    const key = m => m ? [m.trackKey, (m.sources || []).join()].join('|') : '';
    const changed = key(m) !== key(state.media);
    state.media = m;
    if (changed && tab === 'media' && !main.contains(document.activeElement)) render();
  });
  api.onGoto(t => { tab = t; render(); });
  api.onTaskbar(t => {
    const changed = !state.taskbar || state.taskbar.autoHide !== t.autoHide;
    state.taskbar = t;
    if (changed && tab === 'general' && !main.contains(document.activeElement)) render();
  });

  render();
})();
