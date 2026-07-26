/**
 * roster-panel.js — Hidden Active User Roster
 *
 * Attaches to the existing P2P mesh (network-mod.js) via window.TamState
 * and the live playerRegistry / remoteMatchPositions Maps.
 *
 * Activation shortcut: Ctrl + Shift + U
 *   — unbound in Chrome, Firefox, Edge, Safari by default.
 *   — no UI hint, no tooltip, no button.
 *   — once open it re-renders live from the registry every 2 seconds.
 *
 * What it shows (non-private fields only):
 *   - Username / display name
 *   - Peer ID (truncated to 8 chars for readability)
 *   - Region, mode, grid size
 *   - Match state (MATCH / DEAD / LOBBY)
 *   - Spectating allowed flag
 *   - Live x/y tile position (if in-match and position was broadcast)
 *   - Active tile color (hex swatch)
 *   - Last-seen age (seconds ago)
 *   - Whether this peer is your current spectate target
 *   - Whether this peer is spectating YOU
 *   - Peer count summary header
 *
 * Nothing from this script touches localStorage, sessionStorage, or any
 * network action — it is read-only on top of the existing mesh state.
 */

(function rosterPanelMod() {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────
  const SHORTCUT_CODE = 'KeyU';            // Ctrl + Shift + U
  const PANEL_ID      = '_rp_panel';
  const REFRESH_MS    = 2000;
  const PANEL_Z       = 99999;

  // ─── State ────────────────────────────────────────────────────────────────
  let panelOpen    = false;
  let refreshTimer = null;

  // ─── Shortcut: attached immediately, no TamState gate ────────────────────
  // The old design gated attachShortcut() behind a probe() that waited for
  // TamState.getRemoteMatchPlayers. If that hook was slow or the mod load
  // order changed, the listener never got registered — key presses silently
  // did nothing. Fix: register the listener right now at script parse time.
  // TamState readiness is checked inside togglePanel() instead, so the key
  // always works and shows a "still loading" notice if the mesh isn't up yet.
  document.addEventListener('keydown', function onKey(e) {
    if (e.code === SHORTCUT_CODE && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      togglePanel();
    }
  }, { capture: true });

  // ─── Panel lifecycle ──────────────────────────────────────────────────────
  function togglePanel() {
    panelOpen ? closePanel() : openPanel();
  }

  function openPanel() {
    panelOpen = true;
    buildDOM();

    // If TamState isn't wired yet, poll until it is then do first render
    if (!window.TamState || typeof window.TamState.getRemoteMatchPlayers !== 'function') {
      const tbody = document.getElementById('_rp_tbody');
      const empty = document.getElementById('_rp_empty');
      if (empty) {
        empty.textContent = '⏳ Waiting for P2P mesh to initialise…';
        empty.style.display = 'block';
      }
      const waitForMesh = setInterval(() => {
        if (window.TamState && typeof window.TamState.getRemoteMatchPlayers === 'function') {
          clearInterval(waitForMesh);
          if (empty) empty.style.display = 'none';
          renderRoster();
          refreshTimer = setInterval(renderRoster, REFRESH_MS);
        }
      }, 300);
      return;
    }

    renderRoster();
    refreshTimer = setInterval(renderRoster, REFRESH_MS);
  }

  function closePanel() {
    panelOpen = false;
    clearInterval(refreshTimer);
    refreshTimer = null;
    const el = document.getElementById(PANEL_ID);
    if (el) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px) scale(0.97)';
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }
  }

  // ─── DOM scaffold (built once per open) ───────────────────────────────────
  function buildDOM() {
    // Idempotent: if panel already exists just show it
    if (document.getElementById(PANEL_ID)) return;

    injectStyles();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div id="_rp_header">
        <span id="_rp_title">◈ ACTIVE ROSTER</span>
        <div id="_rp_header_right">
          <span id="_rp_count"></span>
          <button id="_rp_close" title="Close (Ctrl+Shift+U)">✕</button>
        </div>
      </div>
      <div id="_rp_subbar">
        <span id="_rp_ts"></span>
        <span id="_rp_self"></span>
      </div>
      <div id="_rp_scroll">
        <table id="_rp_table">
          <thead>
            <tr>
              <th>COLOR</th>
              <th>NAME</th>
              <th>PEER ID</th>
              <th>REGION</th>
              <th>MODE</th>
              <th>STATUS</th>
              <th>POSITION</th>
              <th>LAST SEEN</th>
              <th>SPEC</th>
              <th>FLAGS</th>
            </tr>
          </thead>
          <tbody id="_rp_tbody"></tbody>
        </table>
        <div id="_rp_empty" style="display:none">No peers detected on the mesh.</div>
      </div>
      <div id="_rp_footer">
        <span>Ctrl+Shift+U to hide · Updates every ${REFRESH_MS / 1000}s · Read-only mesh mirror</span>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('_rp_close').addEventListener('click', closePanel);

    // Drag-to-move
    makeDraggable(panel, document.getElementById('_rp_header'));

    // Animate in
    requestAnimationFrame(() => {
      panel.style.opacity = '1';
      panel.style.transform = 'translateY(0) scale(1)';
    });
  }

  // ─── Live render ──────────────────────────────────────────────────────────
  function renderRoster() {
    const tbody   = document.getElementById('_rp_tbody');
    const empty   = document.getElementById('_rp_empty');
    const countEl = document.getElementById('_rp_count');
    const tsEl    = document.getElementById('_rp_ts');
    const selfEl  = document.getElementById('_rp_self');

    if (!tbody) return;  // panel was removed mid-cycle

    const T   = window.TamState;
    const now = Date.now();

    // Collect registry entries. network-mod keeps playerRegistry as a
    // closure-private Map but exposes the spectate-capable subset via
    // updateUI() / the DOM. We reach the full registry through the
    // p2p-list DOM entries (already rendered by network-mod) for names/
    // states, then enrich with position data from getRemoteMatchPlayers().
    //
    // For the fullest possible picture we pull from THREE sources and merge:
    //   1. DOM p2p-item entries (network-mod renders every allowSpectating peer)
    //   2. window.TamState.getRemoteMatchPlayers() (position-broadcasting in-match peers)
    //   3. window.TamState.getSpectatorCount() (number currently watching us)
    //   4. window.TamState.getP2PPlayerNames() (all ping-registry names in our match)

    const peers = new Map();  // peerId|name -> merged object

    // ── Source 1: DOM-rendered list ───────────────────────────────────────
    const listItems = document.querySelectorAll('.p2p-item');
    listItems.forEach(item => {
      const nameEl  = item.querySelector('.p2p-name');
      const infoEl  = item.querySelector('.p2p-info');
      const btnEl   = item.querySelector('.p2p-btn');

      if (!nameEl || !infoEl) return;

      const name   = nameEl.textContent.trim();
      const info   = infoEl.textContent || '';
      const parts  = info.split('•').map(s => s.trim());

      // info format: "region • mode • State"
      const region = parts[0] || '—';
      const mode   = parts[1] || '—';

      // parse state from the colored span inside infoEl
      const stateSpan = infoEl.querySelector('span');
      const state  = stateSpan ? stateSpan.textContent.trim().toUpperCase() : '?';

      // Is this peer currently being spectated? (button says "STOP")
      const isSpectated = btnEl && btnEl.textContent.trim() === 'STOP';
      // Is the button disabled (LOBBY)?
      const isLobby = state === 'LOBBY';

      const key = 'dom_' + name;
      peers.set(key, {
        source:       'dom',
        name,
        peerId:       null,    // DOM doesn't expose peer IDs
        region,
        mode,
        gridSize:     null,
        matchState:   state,
        allowSpectating: true,
        x:            null,
        y:            null,
        color:        null,
        activeColor:  null,
        lastSeen:     now,     // DOM presence = recently seen
        isSpectated,
        isLobby,
      });
    });

    // ── Source 2: position-broadcasting in-match peers ────────────────────
    const matchPlayers = T && typeof T.getRemoteMatchPlayers === 'function'
      ? T.getRemoteMatchPlayers()
      : [];

    matchPlayers.forEach(p => {
      const key = 'pos_' + (p.name || p.id || '');
      const existing = peers.get('dom_' + (p.name || ''));

      if (existing) {
        // Enrich the DOM entry with live position/color data
        existing.x           = p.x;
        existing.y           = p.y;
        existing.color       = p.color;
        existing.activeColor = p.activeColor || p.color;
        existing.gridSize    = p.gridSize;
        existing.region      = p.region || existing.region;
        existing.mode        = p.mode   || existing.mode;
        existing.peerId      = p.id     || existing.peerId;
      } else {
        // Peer is position-broadcasting but not in the spectate DOM list
        // (allowSpectating = false or not yet in registry)
        peers.set(key, {
          source:          'pos',
          name:            p.name || '—',
          peerId:          p.id   || null,
          region:          p.region || '—',
          mode:            p.mode   || '—',
          gridSize:        p.gridSize || null,
          matchState:      'MATCH',
          allowSpectating: false,
          x:               p.x,
          y:               p.y,
          color:           p.color,
          activeColor:     p.activeColor || p.color,
          lastSeen:        now,
          isSpectated:     false,
          isLobby:         false,
        });
      }
    });

    // ── Source 3: known names from ping registry (our match) ─────────────
    const p2pNames = T && typeof T.getP2PPlayerNames === 'function'
      ? T.getP2PPlayerNames()
      : new Set();

    p2pNames.forEach(name => {
      const domKey = 'dom_' + name;
      const posKey = 'pos_' + name;
      if (!peers.has(domKey) && !peers.has(posKey)) {
        peers.set('ping_' + name, {
          source:          'ping',
          name,
          peerId:          null,
          region:          '— (same match)',
          mode:            '—',
          gridSize:        null,
          matchState:      'MATCH',
          allowSpectating: null,   // unknown
          x:               null,
          y:               null,
          color:           null,
          activeColor:     null,
          lastSeen:        now,
          isSpectated:     false,
          isLobby:         false,
        });
      }
    });

    // ── Render ────────────────────────────────────────────────────────────
    const entries = Array.from(peers.values());

    // Sort: MATCH first, then DEAD, then LOBBY; alpha by name within groups
    const stateOrder = { MATCH: 0, DEAD: 1, LOBBY: 2 };
    entries.sort((a, b) => {
      const so = (stateOrder[a.matchState] ?? 3) - (stateOrder[b.matchState] ?? 3);
      return so !== 0 ? so : a.name.localeCompare(b.name);
    });

    // Count totals
    const totalMatch = entries.filter(e => e.matchState === 'MATCH').length;
    const totalDead  = entries.filter(e => e.matchState === 'DEAD').length;
    const totalLobby = entries.filter(e => e.matchState === 'LOBBY').length;
    const spectators = T && typeof T.getSpectatorCount === 'function'
      ? T.getSpectatorCount()
      : 0;

    if (countEl) countEl.textContent = `${entries.length} peer${entries.length !== 1 ? 's' : ''}`;
    if (tsEl)    tsEl.textContent    = `↻ ${new Date().toLocaleTimeString()}`;
    if (selfEl) {
      const selfName = T?.getSelfName?.() || localStorage['n'] || 'You';
      selfEl.textContent = `Self: ${selfName}${spectators > 0 ? ` · ${spectators} spectating you` : ''}`;
    }

    if (entries.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    // Diff-render: only rebuild rows that changed to avoid flicker
    const newHTML = entries.map(e => buildRow(e, now)).join('');
    tbody.innerHTML = newHTML;
  }

  function buildRow(e, now) {
    const stateClass = {
      MATCH: '_rp_s_match',
      DEAD:  '_rp_s_dead',
      LOBBY: '_rp_s_lobby',
    }[e.matchState] || '_rp_s_lobby';

    const stateLabel = {
      MATCH: '▶ MATCH',
      DEAD:  '✕ DEAD',
      LOBBY: '◌ LOBBY',
    }[e.matchState] || e.matchState;

    const colorCell = e.activeColor
      ? `<div class="_rp_swatch" style="background:${sanitizeColor(e.activeColor)}"></div>`
      : `<div class="_rp_swatch _rp_swatch_none"></div>`;

    const posCell = (e.x !== null && e.y !== null)
      ? `<code>${Math.round(e.x)}, ${Math.round(e.y)}</code>`
      : '<span class="_rp_dim">—</span>';

    const peerId = e.peerId
      ? `<code class="_rp_peerid">${e.peerId.slice(0, 8)}</code>`
      : '<span class="_rp_dim">—</span>';

    const lastSeenAge = Math.round((now - e.lastSeen) / 1000);
    const lastSeenCell = lastSeenAge < 5
      ? `<span class="_rp_fresh">now</span>`
      : `<span class="_rp_dim">${lastSeenAge}s ago</span>`;

    const specCell = e.isSpectated
      ? '<span class="_rp_badge _rp_badge_spec">◎ target</span>'
      : '<span class="_rp_dim">—</span>';

    const flags = [];
    if (e.allowSpectating === true)  flags.push('<span class="_rp_badge _rp_badge_ok">spec:on</span>');
    if (e.allowSpectating === false) flags.push('<span class="_rp_badge _rp_badge_off">spec:off</span>');
    if (e.gridSize) flags.push(`<span class="_rp_badge _rp_badge_grid">grid:${e.gridSize}</span>`);
    if (e.source === 'ping') flags.push('<span class="_rp_badge _rp_badge_src">ping-only</span>');
    if (e.source === 'pos')  flags.push('<span class="_rp_badge _rp_badge_src">pos-only</span>');
    const flagCell = flags.length ? flags.join(' ') : '<span class="_rp_dim">—</span>';

    return `
      <tr class="${stateClass}${e.isSpectated ? ' _rp_row_target' : ''}">
        <td>${colorCell}</td>
        <td class="_rp_name">${escapeHTML(e.name)}</td>
        <td>${peerId}</td>
        <td>${escapeHTML(e.region)}</td>
        <td>${escapeHTML(e.mode)}</td>
        <td><span class="_rp_state ${stateClass}">${stateLabel}</span></td>
        <td>${posCell}</td>
        <td>${lastSeenCell}</td>
        <td>${specCell}</td>
        <td>${flagCell}</td>
      </tr>
    `;
  }

  // ─── Drag ─────────────────────────────────────────────────────────────────
  function makeDraggable(panel, handle) {
    let ox = 0, oy = 0, startX = 0, startY = 0, dragging = false;

    const onDown = (e) => {
      if (e.target.id === '_rp_close') return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      ox = rect.left;     oy = rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = Math.max(0, ox + dx) + 'px';
      panel.style.top  = Math.max(0, oy + dy) + 'px';
      panel.style.right = 'auto';
    };

    const onUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };

    handle.addEventListener('mousedown', onDown);
    handle.style.cursor = 'grab';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function escapeHTML(str) {
    if (!str) return '—';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sanitizeColor(val) {
    // Accept only #RGB / #RRGGBB / #RRGGBBAA
    return typeof val === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(val) ? val : 'transparent';
  }

  // ─── Styles ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('_rp_styles')) return;
    const s = document.createElement('style');
    s.id = '_rp_styles';
    s.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 60px;
        right: 24px;
        width: min(960px, 92vw);
        max-height: 80vh;
        background: #0d0f14;
        border: 1px solid #2a2e3a;
        border-radius: 6px;
        box-shadow: 0 8px 40px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.04) inset;
        display: flex;
        flex-direction: column;
        z-index: ${PANEL_Z};
        font-family: 'Segoe UI', ui-sans-serif, system-ui, sans-serif;
        font-size: 12px;
        color: #c9cdd8;
        opacity: 0;
        transform: translateY(-8px) scale(0.97);
        transition: opacity .18s ease, transform .18s ease;
        user-select: none;
      }

      /* ── Header ── */
      #_rp_header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 14px 8px;
        background: #13161e;
        border-bottom: 1px solid #1e2130;
        border-radius: 6px 6px 0 0;
      }
      #_rp_title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .14em;
        text-transform: uppercase;
        color: #6fffa0;
      }
      #_rp_header_right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #_rp_count {
        font-size: 11px;
        color: #6b7080;
        font-variant-numeric: tabular-nums;
      }
      #_rp_close {
        background: none;
        border: 1px solid #2d3245;
        border-radius: 3px;
        color: #888;
        cursor: pointer;
        font-size: 11px;
        line-height: 1;
        padding: 3px 7px;
        transition: background .12s, color .12s;
      }
      #_rp_close:hover { background: #FF2E4222; color: #FF2E42; border-color: #FF2E4266; }

      /* ── Sub-bar ── */
      #_rp_subbar {
        display: flex;
        justify-content: space-between;
        padding: 4px 14px;
        background: #10121a;
        border-bottom: 1px solid #1a1e2c;
        font-size: 10.5px;
        color: #4a5060;
        font-variant-numeric: tabular-nums;
      }
      #_rp_self { color: #52A8FF; }

      /* ── Scroll area ── */
      #_rp_scroll {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        scrollbar-width: thin;
        scrollbar-color: #2a2e3a #0d0f14;
      }
      #_rp_scroll::-webkit-scrollbar { width: 6px; }
      #_rp_scroll::-webkit-scrollbar-track { background: #0d0f14; }
      #_rp_scroll::-webkit-scrollbar-thumb { background: #2a2e3a; border-radius: 3px; }

      /* ── Table ── */
      #_rp_table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      #_rp_table th {
        position: sticky;
        top: 0;
        background: #111420;
        color: #454d62;
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: .1em;
        padding: 6px 10px 5px;
        text-align: left;
        border-bottom: 1px solid #1e2130;
        z-index: 2;
      }
      #_rp_table th:nth-child(1)  { width: 38px; }
      #_rp_table th:nth-child(2)  { width: 14%; }  /* name */
      #_rp_table th:nth-child(3)  { width: 90px; } /* peer id */
      #_rp_table th:nth-child(4)  { width: 11%; }  /* region */
      #_rp_table th:nth-child(5)  { width: 9%; }   /* mode */
      #_rp_table th:nth-child(6)  { width: 90px; } /* status */
      #_rp_table th:nth-child(7)  { width: 100px; }/* position */
      #_rp_table th:nth-child(8)  { width: 82px; } /* last seen */
      #_rp_table th:nth-child(9)  { width: 76px; } /* spec */
      #_rp_table th:nth-child(10) { }              /* flags (remainder) */

      #_rp_table tr {
        border-bottom: 1px solid #13161e;
        transition: background .1s;
      }
      #_rp_table tr:hover { background: #161922; }
      #_rp_row_target,
      #_rp_table tr._rp_row_target { background: #0f2018 !important; }

      #_rp_table td {
        padding: 7px 10px;
        vertical-align: middle;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ── Color swatch ── */
      ._rp_swatch {
        width: 18px;
        height: 18px;
        border-radius: 3px;
        border: 1px solid rgba(255,255,255,.12);
        flex-shrink: 0;
      }
      ._rp_swatch_none {
        background: #1a1e2c;
        border-style: dashed;
      }

      /* ── Name ── */
      ._rp_name { color: #d4d8e8; font-weight: 500; }

      /* ── Peer ID ── */
      ._rp_peerid {
        font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
        font-size: 10px;
        color: #52A8FF88;
        letter-spacing: .04em;
      }

      /* ── Position ── */
      #_rp_table code {
        font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
        font-size: 10px;
        color: #c792ff;
        letter-spacing: .02em;
      }

      /* ── State chips ── */
      ._rp_state {
        display: inline-block;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .06em;
        border-radius: 3px;
        padding: 2px 6px;
      }
      ._rp_s_match { color: #6fffa0; background: #6fffa012; }
      ._rp_s_dead  { color: #FF2E42; background: #FF2E4212; }
      ._rp_s_lobby { color: #666e88; background: #666e8812; }

      /* ── Badges ── */
      ._rp_badge {
        display: inline-block;
        font-size: 9px;
        font-weight: 600;
        border-radius: 2px;
        padding: 1px 5px;
        letter-spacing: .04em;
        margin-right: 3px;
      }
      ._rp_badge_spec { background: #52A8FF22; color: #52A8FF; border: 1px solid #52A8FF44; }
      ._rp_badge_ok   { background: #6fffa018; color: #6fffa0; border: 1px solid #6fffa030; }
      ._rp_badge_off  { background: #FF2E4218; color: #FF2E42; border: 1px solid #FF2E4230; }
      ._rp_badge_grid { background: #FFD70018; color: #FFD700; border: 1px solid #FFD70030; }
      ._rp_badge_src  { background: #c792ff18; color: #c792ff; border: 1px solid #c792ff30; }

      /* ── Utility ── */
      ._rp_dim   { color: #2e3447; }
      ._rp_fresh { color: #6fffa0; font-weight: 600; }

      /* ── Empty state ── */
      #_rp_empty {
        padding: 32px;
        text-align: center;
        color: #2e3447;
        font-size: 13px;
      }

      /* ── Footer ── */
      #_rp_footer {
        padding: 5px 14px;
        background: #10121a;
        border-top: 1px solid #1a1e2c;
        border-radius: 0 0 6px 6px;
        font-size: 10px;
        color: #2a2e3a;
        text-align: center;
      }

      /* ── Row state colouring (subtle left accent) ── */
      #_rp_table tr._rp_s_match td:first-child { box-shadow: inset 2px 0 0 #6fffa040; }
      #_rp_table tr._rp_s_dead  td:first-child { box-shadow: inset 2px 0 0 #FF2E4240; }
    `;
    document.head.appendChild(s);
  }

})();
