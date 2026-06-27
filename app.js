// ============================================================
// TX Scratch Counter — Main Application Logic
// Corrected Workflow: Scan REMAINING tickets at end of shift
// to determine which tickets were SOLD.
// ============================================================

(function () {
  'use strict';

  // ===== STORAGE KEYS =====
  const KEYS = {
    GAMES: 'txscratch_games',
    PACKS: 'txscratch_packs',
    COUNTS: 'txscratch_counts',    // finalized shift counts
    SETTINGS: 'txscratch_settings',
    SHIFT: 'txscratch_shift',
    TEMP_SCANS: 'txscratch_tempscans', // scans in progress (not yet finalized)
  };

  // ===== DATA HELPERS =====
  function load(key, fallback) {
    try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : fallback; }
    catch { return fallback; }
  }
  function save(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

  // ===== APP STATE =====
  let games       = load(KEYS.GAMES, []);
  let packs       = load(KEYS.PACKS, []);
  let counts      = load(KEYS.COUNTS, []);   // Array of finalized count sessions
  let settings    = load(KEYS.SETTINGS, { storeName: '', storeAddress: '', license: '' });
  let currentShift = load(KEYS.SHIFT, null);
  let tempScans   = load(KEYS.TEMP_SCANS, []); // { gameId, packNumber, ticketNumber, timestamp }

  let activeView = 'dashboard';
  let countMode  = 'scanner';  // 'scanner' or 'manual'
  let countingActive = false;
  let editingGameId = null;
  let gameFilter = 'all';
  let activeReportType = 'shift';
  let confirmCallback = null;
  let scannerStream = null;
  let scannerInterval = null;
  let lastProcessedBarcode = '';
  let lastProcessedTime = 0;

  // ===== UTILITIES =====
  function uid() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function nowTime() {
    return new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true });
  }
  function nowDateTime() {
    return new Date().toLocaleString('en-US', {
      month:'short', day:'numeric', year:'numeric',
      hour:'2-digit', minute:'2-digit', hour12:true
    });
  }
  function formatCurrency(n) { return '$' + Number(n).toFixed(2); }
  function padNum(n, len = 3) { return String(n).padStart(len, '0'); }

  // ===== TOAST =====
  const toastContainer = document.getElementById('toast-container');
  function showToast(message, type = 'info', duration = 3000) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    t.innerHTML = `<span style="font-weight:700;font-size:1rem;">${icons[type]||'ℹ'}</span><span>${message}</span>`;
    toastContainer.appendChild(t);
    setTimeout(() => { t.classList.add('removing'); setTimeout(() => t.remove(), 300); }, duration);
  }

  // ===== CONFIRM MODAL =====
  const confirmModal      = document.getElementById('confirm-modal');
  const confirmTitle      = document.getElementById('confirm-title');
  const confirmMessage    = document.getElementById('confirm-message');
  const confirmOkBtn      = document.getElementById('confirm-ok-btn');
  const confirmCancelBtn  = document.getElementById('confirm-cancel-btn');
  const confirmModalClose = document.getElementById('confirm-modal-close');

  function showConfirm(title, message, onConfirm) {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmModal.classList.add('open');
  }
  confirmOkBtn.addEventListener('click', () => {
    confirmModal.classList.remove('open');
    if (confirmCallback) confirmCallback();
    confirmCallback = null;
  });
  [confirmCancelBtn, confirmModalClose].forEach(el =>
    el.addEventListener('click', () => { confirmModal.classList.remove('open'); confirmCallback = null; })
  );

  // ===== NAVIGATION =====
  const navTabs = document.querySelectorAll('.nav-tab');
  const views = {
    dashboard: document.getElementById('view-dashboard'),
    games:     document.getElementById('view-games'),
    count:     document.getElementById('view-count'),
    reports:   document.getElementById('view-reports'),
  };

  function switchView(name) {
    activeView = name;
    navTabs.forEach(t => t.classList.toggle('active', t.dataset.view === name));
    Object.entries(views).forEach(([k, v]) => v.classList.toggle('active', k === name));
    if (name !== 'count') stopScanner();
    if (name === 'dashboard') refreshDashboard();
    if (name === 'games') renderGames();
    if (name === 'count') refreshCountView();
    if (name === 'reports') generateReport();
  }
  navTabs.forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

  // ===== SHIFT MANAGEMENT =====
  const shiftBanner    = document.getElementById('shift-banner');
  const shiftStatusText = document.getElementById('shift-status-text');
  const shiftToggleBtn = document.getElementById('shift-toggle-btn');

  function updateShiftBanner() {
    if (currentShift && currentShift.status === 'active') {
      shiftBanner.classList.remove('no-shift');
      const t = new Date(currentShift.startTime).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
      shiftStatusText.textContent = `Shift started at ${t}`;
      shiftToggleBtn.textContent = 'End Shift';
      shiftToggleBtn.className = 'btn btn-sm btn-danger';
    } else {
      shiftBanner.classList.add('no-shift');
      shiftStatusText.textContent = 'No active shift';
      shiftToggleBtn.textContent = 'Start Shift';
      shiftToggleBtn.className = 'btn btn-sm btn-success';
    }
  }

  shiftToggleBtn.addEventListener('click', () => {
    if (currentShift && currentShift.status === 'active') {
      showConfirm('End Shift', 'End the current shift? Go to Scan & Count to record remaining tickets first.', () => {
        currentShift.status = 'closed';
        currentShift.endTime = new Date().toISOString();
        save(KEYS.SHIFT, currentShift);
        updateShiftBanner();
        showToast('Shift ended', 'success');
        switchView('reports');
      });
    } else {
      currentShift = {
        shiftId: uid(),
        startTime: new Date().toISOString(),
        endTime: null,
        status: 'active',
        date: todayStr()
      };
      save(KEYS.SHIFT, currentShift);
      updateShiftBanner();
      showToast('Shift started!', 'success');
    }
  });

  // ===== DASHBOARD =====
  function refreshDashboard() {
    const today = todayStr();
    const activeGames = games.filter(g => g.status === 'active');
    const openPacks   = packs.filter(p => p.status !== 'finished');

    // Today's sold count from finalized counts
    const todayCounts = counts.filter(c => c.date === today);
    let totalSold = 0, totalRevenue = 0;
    todayCounts.forEach(c => {
      c.packResults.forEach(pr => {
        totalSold += pr.soldTickets.length;
        const g = games.find(g => g.gameId === pr.gameId);
        if (g) totalRevenue += pr.soldTickets.length * g.price;
      });
    });

    document.getElementById('stat-active-games').textContent  = activeGames.length;
    document.getElementById('stat-open-packs').textContent    = openPacks.length;
    document.getElementById('stat-tickets-today').textContent = totalSold;
    document.getElementById('stat-revenue-today').textContent = formatCurrency(totalRevenue);

    // Bins grid — show each game's bin position
    renderBinsGrid();

    // Recent counts
    const recentEl = document.getElementById('dashboard-recent-counts');
    if (todayCounts.length === 0) {
      recentEl.innerHTML = `<div class="empty-state" style="padding:20px;">
        <p style="font-size:0.82rem;">No counts finalized today. Go to Scan & Count at end of shift.</p></div>`;
    } else {
      recentEl.innerHTML = todayCounts.map(c => {
        const totalS = c.packResults.reduce((s, pr) => s + pr.soldTickets.length, 0);
        const t = new Date(c.timestamp).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
        return `<div class="sale-log-item">
          <div class="sale-detail">${totalS} tickets sold across ${c.packResults.length} pack(s)</div>
          <span class="sale-time">${t}</span>
        </div>`;
      }).join('');
    }
  }

  function renderBinsGrid() {
    const binsGrid = document.getElementById('bins-grid');
    const activeGames = games.filter(g => g.status === 'active').sort((a, b) => (a.binNumber || 0) - (b.binNumber || 0));

    if (activeGames.length === 0) {
      binsGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;padding:20px;">
        <p style="font-size:0.82rem;">No active games. Add games in the Games tab.</p></div>`;
      return;
    }

    binsGrid.innerHTML = activeGames.map(g => {
      const gamePacks = packs.filter(p => p.gameId === g.gameId && p.status !== 'finished');
      const currentPack = gamePacks[0];
      const remaining = currentPack ? currentPack.totalTickets - getPackSoldTotal(currentPack) : 0;
      return `<div class="stat-card gold" style="cursor:pointer; padding:12px 10px;" title="${g.gameName}">
        <div class="stat-card-label">BIN #${g.binNumber || '?'}</div>
        <div class="stat-card-value" style="font-size:1.2rem;">${formatCurrency(g.price)}</div>
        <div class="stat-card-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${g.gameName}</div>
        ${currentPack ? `<div class="stat-card-sub" style="color:var(--accent-green);">${remaining} left</div>` : `<div class="stat-card-sub" style="color:var(--accent-red);">No pack</div>`}
      </div>`;
    }).join('');
  }

  // Get total sold for a pack from finalized counts
  function getPackSoldTotal(pack) {
    let sold = 0;
    counts.forEach(c => {
      c.packResults.forEach(pr => {
        if (pr.gameId === pack.gameId && pr.packNumber === pack.packNumber) {
          sold += pr.soldTickets.length;
        }
      });
    });
    return sold;
  }

  // ===== GAMES MANAGEMENT =====
  const addGameBtn      = document.getElementById('add-game-btn');
  const gameModal       = document.getElementById('game-modal');
  const gameModalTitle  = document.getElementById('game-modal-title');
  const gameModalClose  = document.getElementById('game-modal-close');
  const gameModalCancel = document.getElementById('game-modal-cancel');
  const gameModalSave   = document.getElementById('game-modal-save');
  const gameIdInput     = document.getElementById('game-id-input');
  const gameNameInput   = document.getElementById('game-name-input');
  const gamePriceInput  = document.getElementById('game-price-input');
  const gamePackSizeInput = document.getElementById('game-packsize-input');
  const gameBinInput    = document.getElementById('game-bin-input');
  const gameFilterTabs  = document.getElementById('game-filter-tabs');

  function openGameModal(game = null) {
    editingGameId = game ? game.gameId : null;
    gameModalTitle.textContent = game ? 'Edit Game' : 'Add New Game';
    gameBinInput.value    = game ? (game.binNumber || '') : '';
    gameIdInput.value     = game ? game.gameId : '';
    gameNameInput.value   = game ? game.gameName : '';
    gamePriceInput.value  = game ? String(game.price) : '5';
    gamePackSizeInput.value = game ? String(game.packSize) : '50';
    gameIdInput.disabled  = !!game;
    gameModal.classList.add('open');
  }

  function closeGameModal() { gameModal.classList.remove('open'); editingGameId = null; }
  addGameBtn.addEventListener('click', () => openGameModal());
  gameModalClose.addEventListener('click', closeGameModal);
  gameModalCancel.addEventListener('click', closeGameModal);

  gameModalSave.addEventListener('click', () => {
    const bin   = parseInt(gameBinInput.value, 10) || 0;
    const gid   = gameIdInput.value.trim();
    const gname = gameNameInput.value.trim();
    const price = parseFloat(gamePriceInput.value);
    const packSize = parseInt(gamePackSizeInput.value, 10);

    if (!gid)   return showToast('Game number is required', 'error');
    if (!gname) return showToast('Game name is required', 'error');
    if (!bin)   return showToast('Bin / display position is required', 'error');

    if (!editingGameId && games.find(g => g.gameId === gid))
      return showToast('Game #' + gid + ' already exists', 'error');

    // Check bin conflict
    const binConflict = games.find(g => g.binNumber === bin && g.gameId !== (editingGameId || '') && g.status === 'active');
    if (binConflict) return showToast(`Bin #${bin} already used by game #${binConflict.gameId}`, 'error');

    if (editingGameId) {
      const g = games.find(g => g.gameId === editingGameId);
      if (g) { g.gameName = gname; g.price = price; g.packSize = packSize; g.binNumber = bin; }
      showToast('Game updated', 'success');
    } else {
      games.push({ gameId: gid, gameName: gname, price, packSize, binNumber: bin, status: 'active', dateAdded: new Date().toISOString() });
      showToast('Game #' + gid + ' added at bin #' + bin, 'success');
    }
    save(KEYS.GAMES, games);
    closeGameModal();
    renderGames();
    refreshDashboard();
  });

  gameFilterTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.report-type-btn');
    if (!btn) return;
    gameFilter = btn.dataset.filter;
    gameFilterTabs.querySelectorAll('.report-type-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderGames();
  });

  function renderGames() {
    const list = document.getElementById('games-list');
    let filtered = [...games].sort((a, b) => (a.binNumber || 0) - (b.binNumber || 0));
    if (gameFilter === 'active')   filtered = filtered.filter(g => g.status === 'active');
    if (gameFilter === 'finished') filtered = filtered.filter(g => g.status === 'finished');

    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
        <h3>No games found</h3><p>Add your first scratch game to get started</p>
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('add-game-btn').click()">Add Game</button></div>`;
      return;
    }

    list.innerHTML = filtered.map(g => {
      const gamePacks = packs.filter(p => p.gameId === g.gameId);
      const openPacks = gamePacks.filter(p => p.status !== 'finished');
      return `<div class="game-item" data-game-id="${g.gameId}">
        <div class="game-info">
          <div class="game-number" style="min-width:auto; display:flex; flex-direction:column; align-items:center; gap:2px;">
            <span style="font-size:0.6rem; opacity:0.7;">BIN</span>
            <span>${g.binNumber || '?'}</span>
          </div>
          <div class="game-number">#${g.gameId}</div>
          <div class="game-details">
            <h4>${g.gameName}</h4>
            <div class="game-meta">
              <span>${formatCurrency(g.price)}</span>
              <span>${g.packSize}/pack</span>
              <span>${openPacks.length} open</span>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="status-badge ${g.status}">${g.status}</span>
          <div class="game-actions">
            <button class="btn btn-secondary btn-sm" onclick="window.txApp.loadPackForGame('${g.gameId}')" title="Load Pack">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg> Pack
            </button>
            <button class="btn btn-secondary btn-sm" onclick="window.txApp.editGame('${g.gameId}')" title="Edit">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
            </button>
            <button class="btn btn-sm ${g.status === 'active' ? 'btn-danger' : 'btn-success'}"
              onclick="window.txApp.toggleGameStatus('${g.gameId}')"
              title="${g.status === 'active' ? 'Finish' : 'Reactivate'}">
              ${g.status === 'active' ? '✕' : '✓'}
            </button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ===== PACK MANAGEMENT =====
  const packModal       = document.getElementById('pack-modal');
  const packModalClose  = document.getElementById('pack-modal-close');
  const packModalCancel = document.getElementById('pack-modal-cancel');
  const packModalSave   = document.getElementById('pack-modal-save');
  const packGameSelect  = document.getElementById('pack-game-select');
  const packNumberInput = document.getElementById('pack-number-input');
  const dirAscBtn       = document.getElementById('dir-asc-btn');
  const dirDescBtn      = document.getElementById('dir-desc-btn');
  let packDirection = 'asc';

  function openPackModal(preGameId = '') {
    packGameSelect.innerHTML = '<option value="">— Select Game —</option>' +
      games.filter(g => g.status === 'active').map(g =>
        `<option value="${g.gameId}" ${g.gameId === preGameId ? 'selected' : ''}>#${g.gameId} — ${g.gameName}</option>`
      ).join('');
    packNumberInput.value = '';
    packDirection = 'asc';
    dirAscBtn.classList.add('active');  dirDescBtn.classList.remove('active');
    packModal.classList.add('open');
  }
  function closePackModal() { packModal.classList.remove('open'); }
  packModalClose.addEventListener('click', closePackModal);
  packModalCancel.addEventListener('click', closePackModal);
  dirAscBtn.addEventListener('click', () => { packDirection = 'asc'; dirAscBtn.classList.add('active'); dirDescBtn.classList.remove('active'); });
  dirDescBtn.addEventListener('click', () => { packDirection = 'desc'; dirDescBtn.classList.add('active'); dirAscBtn.classList.remove('active'); });

  packModalSave.addEventListener('click', () => {
    const gameId  = packGameSelect.value;
    const packNum = packNumberInput.value.trim();
    if (!gameId)  return showToast('Select a game', 'error');
    if (!packNum) return showToast('Pack number is required', 'error');
    const game = games.find(g => g.gameId === gameId);
    if (!game) return;
    if (packs.find(p => p.gameId === gameId && p.packNumber === packNum))
      return showToast('Pack #' + packNum + ' already loaded', 'error');

    packs.push({
      packId: uid(), gameId, packNumber: packNum,
      totalTickets: game.packSize, direction: packDirection,
      status: 'active', dateLoaded: new Date().toISOString()
    });
    save(KEYS.PACKS, packs);
    closePackModal();
    showToast(`Pack #${packNum} loaded for game #${gameId}`, 'success');
    renderGames();
    refreshDashboard();
  });

  // ===== SCAN & COUNT VIEW =====
  const countSessionBanner = document.getElementById('count-session-banner');
  const countSessionText   = document.getElementById('count-session-text');
  const startCountBtn      = document.getElementById('start-count-btn');
  const finalizeCountBtn   = document.getElementById('finalize-count-btn');
  const scanInputArea      = document.getElementById('scan-input-area');
  const countSummaryArea   = document.getElementById('count-summary-area');
  const totalScannedBadge  = document.getElementById('total-scanned-badge');
  const countPerGameList   = document.getElementById('count-per-game-list');
  const missingTicketsArea = document.getElementById('missing-tickets-area');
  const missingTicketsList = document.getElementById('missing-tickets-list');
  const lastScanFeedback   = document.getElementById('last-scan-feedback');

  const modeScannerBtn = document.getElementById('mode-scanner-btn');
  const modeManualBtn  = document.getElementById('mode-manual-btn');
  const scannerModeArea = document.getElementById('scanner-mode-area');
  const manualEntryArea = document.getElementById('manual-entry-area');
  const barcodeInput    = document.getElementById('barcode-input');
  const barcodeSubmitBtn = document.getElementById('barcode-submit-btn');
  // ===== WIZARD STATE =====
  let wizardBins = [];      // sorted array of game objects with packs
  let wizardIndex = 0;      // current bin index
  let wizardCounts = {};    // { gameId__packNumber: remainingCount } user entries
  const WIZARD_KEY = 'txscratch_wizardcounts';
  wizardCounts = load(WIZARD_KEY, {});

  // Wizard DOM elements
  const wizardBinStrip      = document.getElementById('wizard-bin-strip');
  const wizardBinNumber     = document.getElementById('wizard-bin-number');
  const wizardGameName      = document.getElementById('wizard-game-name');
  const wizardGameId        = document.getElementById('wizard-game-id');
  const wizardGamePrice     = document.getElementById('wizard-game-price');
  const wizardGameStatus    = document.getElementById('wizard-game-status');
  const wizardPackInfo      = document.getElementById('wizard-pack-info');
  const wizardPackNumber    = document.getElementById('wizard-pack-number');
  const wizardPackTotal     = document.getElementById('wizard-pack-total');
  const wizardPrevSold      = document.getElementById('wizard-prev-sold');
  const wizardOpening       = document.getElementById('wizard-opening');
  const wizardNoPack        = document.getElementById('wizard-no-pack');
  const wizardFinishedBanner = document.getElementById('wizard-finished-banner');
  const wizardInputArea     = document.getElementById('wizard-input-area');
  const wizardRemainingInput = document.getElementById('wizard-remaining-input');
  const wizardSaveBtn       = document.getElementById('wizard-save-btn');
  const wizardSoldPreview   = document.getElementById('wizard-sold-preview');
  const wizardPrevBtn       = document.getElementById('wizard-prev-btn');
  const wizardNextBtn       = document.getElementById('wizard-next-btn');
  const wizardStepIndicator = document.getElementById('wizard-step-indicator');
  const wizardSummary       = document.getElementById('wizard-summary');
  const wizardSummaryText   = document.getElementById('wizard-summary-text');

  // Mode toggle
  modeScannerBtn.addEventListener('click', () => {
    countMode = 'scanner';
    modeScannerBtn.classList.add('active'); modeManualBtn.classList.remove('active');
    scannerModeArea.style.display = '';     manualEntryArea.style.display = 'none';
    if (countingActive) startScanner();
  });
  modeManualBtn.addEventListener('click', () => {
    countMode = 'manual';
    modeManualBtn.classList.add('active');  modeScannerBtn.classList.remove('active');
    scannerModeArea.style.display = 'none'; manualEntryArea.style.display = '';
    stopScanner();
    initWizard();
  });

  function initWizard() {
    // Build sorted list of ALL games (active + finished) by bin number
    wizardBins = [...games].sort((a, b) => (a.binNumber || 999) - (b.binNumber || 999));
    if (wizardBins.length === 0) return;
    renderWizardBinStrip();
    renderWizardStep();
  }

  function renderWizardBinStrip() {
    wizardBinStrip.innerHTML = wizardBins.map((g, i) => {
      const pack = getActivePack(g.gameId);
      const key = pack ? `${g.gameId}__${pack.packNumber}` : null;
      const counted = key && wizardCounts[key] !== undefined;
      const isActive = i === wizardIndex;
      const isFinished = g.status === 'finished';
      let bg, border, color;
      if (isActive) {
        bg = 'var(--accent-gold)'; border = 'var(--accent-gold)'; color = 'var(--text-dark)';
      } else if (counted) {
        bg = 'rgba(34,197,94,0.15)'; border = 'rgba(34,197,94,0.4)'; color = 'var(--accent-green)';
      } else if (isFinished) {
        bg = 'rgba(107,114,128,0.1)'; border = 'rgba(107,114,128,0.2)'; color = 'var(--text-muted)';
      } else {
        bg = 'var(--bg-input)'; border = 'var(--border-color)'; color = 'var(--text-secondary)';
      }
      return `<button onclick="window.txApp.wizardGoTo(${i})" style="
        min-width:40px; height:36px; border-radius:6px; font-size:0.78rem; font-weight:600;
        font-family:var(--font-mono); cursor:pointer; border:1.5px solid ${border};
        background:${bg}; color:${color}; transition:all 0.15s ease;
        display:flex; align-items:center; justify-content:center;
        ${isFinished && !isActive ? 'text-decoration:line-through;' : ''}
      " title="Bin #${g.binNumber||'?'} — ${g.gameName}${counted ? ' ✓' : ''}">${g.binNumber || '?'}${counted ? '✓' : ''}</button>`;
    }).join('');
  }

  function getActivePack(gameId) {
    return packs.find(p => p.gameId === gameId && p.status !== 'finished') || null;
  }

  function renderWizardStep() {
    if (wizardBins.length === 0) return;
    const g = wizardBins[wizardIndex];
    const pack = getActivePack(g.gameId);
    const key = pack ? `${g.gameId}__${pack.packNumber}` : null;

    // Bin number badge
    wizardBinNumber.innerHTML = `<span style="font-size:0.5rem;opacity:0.8;">BIN</span><span>${g.binNumber || '?'}</span>`;

    // Game info
    wizardGameName.textContent = g.gameName;
    wizardGameId.textContent = '#' + g.gameId;
    wizardGamePrice.textContent = formatCurrency(g.price);
    wizardGameStatus.textContent = g.status;
    wizardGameStatus.className = `status-badge ${g.status}`;

    // Pack info
    if (pack) {
      wizardPackInfo.style.display = '';
      wizardNoPack.style.display = 'none';
      wizardPackNumber.textContent = pack.packNumber;
      wizardPackTotal.textContent = pack.totalTickets;
      const prevSold = getPackSoldTotal(pack);
      wizardPrevSold.textContent = prevSold;
      const opening = pack.totalTickets - prevSold;
      wizardOpening.textContent = opening;
    } else {
      wizardPackInfo.style.display = 'none';
      wizardNoPack.style.display = g.status === 'finished' ? 'none' : '';
    }

    // Finished banner
    wizardFinishedBanner.style.display = g.status === 'finished' ? '' : 'none';

    // Input area — hide if finished or no pack
    if (g.status === 'finished' || !pack) {
      wizardInputArea.style.display = 'none';
    } else {
      wizardInputArea.style.display = '';
      // Restore previously entered value
      wizardRemainingInput.value = key && wizardCounts[key] !== undefined ? wizardCounts[key] : '';
      updateSoldPreview();
      wizardRemainingInput.focus();
    }

    // Step indicator
    wizardStepIndicator.textContent = `${wizardIndex + 1} / ${wizardBins.length}`;

    // Prev/Next button states
    wizardPrevBtn.disabled = wizardIndex <= 0;
    wizardNextBtn.disabled = wizardIndex >= wizardBins.length - 1;
    wizardNextBtn.textContent = wizardIndex >= wizardBins.length - 1 ? 'Done' : 'Next';

    // Update strip
    renderWizardBinStrip();

    // Check completion
    checkWizardCompletion();
  }

  function updateSoldPreview() {
    const g = wizardBins[wizardIndex];
    if (!g) return;
    const pack = getActivePack(g.gameId);
    if (!pack) { wizardSoldPreview.innerHTML = ''; return; }
    const remaining = parseInt(wizardRemainingInput.value, 10);
    if (isNaN(remaining) || remaining < 0) {
      wizardSoldPreview.innerHTML = '';
      return;
    }
    const opening = pack.totalTickets - getPackSoldTotal(pack);
    const sold = opening - remaining;
    if (sold < 0) {
      wizardSoldPreview.innerHTML = `<span style="color:var(--accent-red);">⚠ Remaining can't exceed opening count (${opening})</span>`;
    } else if (sold === 0) {
      wizardSoldPreview.innerHTML = `<span style="color:var(--text-muted);">No tickets sold from this pack</span>`;
    } else {
      wizardSoldPreview.innerHTML = `<span style="color:var(--accent-green);">🎫 <strong>${sold}</strong> ticket${sold !== 1 ? 's' : ''} sold = <strong>${formatCurrency(sold * g.price)}</strong></span>`;
    }
  }

  wizardRemainingInput.addEventListener('input', updateSoldPreview);

  // Save current bin count
  wizardSaveBtn.addEventListener('click', () => {
    const g = wizardBins[wizardIndex];
    if (!g) return;
    const pack = getActivePack(g.gameId);
    if (!pack) return;
    const val = wizardRemainingInput.value.trim();
    if (val === '') return showToast('Enter remaining ticket count', 'error');
    const remaining = parseInt(val, 10);
    if (isNaN(remaining) || remaining < 0) return showToast('Enter a valid number', 'error');
    const opening = pack.totalTickets - getPackSoldTotal(pack);
    if (remaining > opening) return showToast(`Remaining (${remaining}) can't exceed opening (${opening})`, 'error');

    const key = `${g.gameId}__${pack.packNumber}`;
    wizardCounts[key] = remaining;
    save(WIZARD_KEY, wizardCounts);

    const sold = opening - remaining;
    showToast(`Bin #${g.binNumber}: ${sold} sold saved ✓`, 'success');

    // Convert to tempScans: remaining tickets become scan entries
    // Remove old scans for this pack first
    tempScans = tempScans.filter(s => !(s.gameId === g.gameId && s.packNumber === pack.packNumber));
    // Add remaining tickets as scanned (remaining = still there)
    const prevSoldTickets = getPackPreviouslySoldTickets(pack);
    for (let t = 1; t <= pack.totalTickets; t++) {
      if (prevSoldTickets.includes(t)) continue; // skip previously sold
      // Mark remaining tickets as scanned
      if (remaining > 0) {
        // We'll fill in the first N non-previously-sold tickets as remaining
        // Actually, for manual count we just record the count, not specific ticket numbers
      }
    }
    // For manual mode, we'll generate synthetic scans in finalizeCount
    save(KEYS.TEMP_SCANS, tempScans);

    // Auto-advance to next bin
    if (wizardIndex < wizardBins.length - 1) {
      wizardIndex++;
      renderWizardStep();
    } else {
      renderWizardStep(); // refresh for completion check
    }
    renderCountSummary();
  });

  // Navigate Enter key = save + next
  wizardRemainingInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') wizardSaveBtn.click();
  });

  // Navigation
  wizardPrevBtn.addEventListener('click', () => {
    if (wizardIndex > 0) { wizardIndex--; renderWizardStep(); }
  });
  wizardNextBtn.addEventListener('click', () => {
    if (wizardIndex < wizardBins.length - 1) { wizardIndex++; renderWizardStep(); }
  });

  // Jump to bin
  window.txApp = window.txApp || {};
  window.txApp.wizardGoTo = function(index) {
    if (index >= 0 && index < wizardBins.length) {
      wizardIndex = index;
      renderWizardStep();
    }
  };

  function checkWizardCompletion() {
    // Count how many active bins have been counted
    let totalActive = 0, totalCounted = 0, totalSold = 0, totalRev = 0;
    wizardBins.forEach(g => {
      if (g.status === 'finished') return;
      const pack = getActivePack(g.gameId);
      if (!pack) return;
      totalActive++;
      const key = `${g.gameId}__${pack.packNumber}`;
      if (wizardCounts[key] !== undefined) {
        totalCounted++;
        const opening = pack.totalTickets - getPackSoldTotal(pack);
        const sold = opening - wizardCounts[key];
        totalSold += sold;
        totalRev += sold * g.price;
      }
    });

    if (totalCounted > 0 && totalCounted >= totalActive) {
      wizardSummary.style.display = '';
      wizardSummaryText.textContent = `All ${totalActive} bins counted! ${totalSold} tickets sold = ${formatCurrency(totalRev)}. Click "Finalize & Save" above.`;
    } else if (totalCounted > 0) {
      wizardSummary.style.display = '';
      wizardSummaryText.textContent = `${totalCounted}/${totalActive} bins counted so far. ${totalSold} tickets sold = ${formatCurrency(totalRev)}.`;
    } else {
      wizardSummary.style.display = 'none';
    }
  }

  // Start / Stop Counting Session
  startCountBtn.addEventListener('click', () => {
    if (countingActive) {
      // Reset
      showConfirm('Reset Count', 'Discard all scan & manual count data and start over?', () => {
        tempScans = [];
        wizardCounts = {};
        save(KEYS.TEMP_SCANS, tempScans);
        save(WIZARD_KEY, wizardCounts);
        countingActive = false;
        wizardIndex = 0;
        refreshCountView();
        showToast('Count reset', 'info');
      });
    } else {
      countingActive = true;
      tempScans = [];
      wizardCounts = {};
      save(KEYS.TEMP_SCANS, tempScans);
      save(WIZARD_KEY, wizardCounts);
      wizardIndex = 0;
      refreshCountView();
      showToast('Counting session started. Scan or manually count remaining tickets.', 'success');
    }
  });

  finalizeCountBtn.addEventListener('click', () => {
    const totalEntries = tempScans.length + Object.keys(wizardCounts).length;
    if (totalEntries === 0) return showToast('No data to finalize', 'error');
    showConfirm('Finalize Count',
      'Save this count? Un-scanned tickets will be marked as SOLD. Verify all data is correct.',
      () => finalizeCount()
    );
  });

  function finalizeCount() {
    const packResults = [];
    const processedKeys = new Set();

    // 1) Process SCANNER scans (individual ticket-level scans)
    const scanGroups = {};
    tempScans.forEach(s => {
      const key = `${s.gameId}__${s.packNumber}`;
      if (!scanGroups[key]) scanGroups[key] = { gameId: s.gameId, packNumber: s.packNumber, scannedTickets: [] };
      if (!scanGroups[key].scannedTickets.includes(s.ticketNumber)) {
        scanGroups[key].scannedTickets.push(s.ticketNumber);
      }
    });

    Object.values(scanGroups).forEach(sg => {
      const pack = packs.find(p => p.gameId === sg.gameId && p.packNumber === sg.packNumber);
      if (!pack) return;
      const allTickets = Array.from({ length: pack.totalTickets }, (_, i) => i + 1);
      const remaining  = sg.scannedTickets.sort((a, b) => a - b);
      const sold       = allTickets.filter(t => !remaining.includes(t));
      packResults.push({
        gameId: sg.gameId, packNumber: sg.packNumber,
        totalTickets: pack.totalTickets, scannedTickets: remaining, soldTickets: sold,
      });
      if (sold.length >= pack.totalTickets) pack.status = 'finished';
      processedKeys.add(`${sg.gameId}__${sg.packNumber}`);
    });

    // 2) Process MANUAL WIZARD counts (remaining count per pack)
    Object.entries(wizardCounts).forEach(([key, remainingCount]) => {
      if (processedKeys.has(key)) return; // already handled by scanner
      const [gameId, packNumber] = key.split('__');
      const pack = packs.find(p => p.gameId === gameId && p.packNumber === packNumber);
      if (!pack) return;
      const game = games.find(g => g.gameId === gameId);
      if (!game) return;

      const prevSold = getPackPreviouslySoldTickets(pack);
      const opening = pack.totalTickets - prevSold.length;
      const soldCount = Math.max(0, opening - remainingCount);

      // Generate synthetic sold ticket numbers (sequential from the selling direction)
      const availableTickets = [];
      if (pack.direction === 'desc') {
        for (let t = pack.totalTickets; t >= 1; t--) {
          if (!prevSold.includes(t)) availableTickets.push(t);
        }
      } else {
        for (let t = 1; t <= pack.totalTickets; t++) {
          if (!prevSold.includes(t)) availableTickets.push(t);
        }
      }
      const soldTickets = availableTickets.slice(0, soldCount);
      const remainingTickets = availableTickets.slice(soldCount);

      packResults.push({
        gameId, packNumber,
        totalTickets: pack.totalTickets,
        scannedTickets: remainingTickets,
        soldTickets: [...prevSold, ...soldTickets].filter((v, i, a) => a.indexOf(v) === i),
        manualCount: true,
        remainingEntered: remainingCount,
      });

      if (soldTickets.length + prevSold.length >= pack.totalTickets) pack.status = 'finished';
    });

    save(KEYS.PACKS, packs);

    // Save finalized count
    const countRecord = {
      countId: uid(),
      shiftId: currentShift ? currentShift.shiftId : null,
      date: todayStr(),
      timestamp: new Date().toISOString(),
      packResults,
    };
    counts.push(countRecord);
    save(KEYS.COUNTS, counts);

    // Clear temp
    tempScans = [];
    wizardCounts = {};
    save(KEYS.TEMP_SCANS, tempScans);
    save(WIZARD_KEY, wizardCounts);
    countingActive = false;
    stopScanner();

    showToast('Count finalized and saved!', 'success');
    refreshCountView();
    refreshDashboard();
    switchView('reports');
    activeReportType = 'shift';
    generateReport();
  }

  function refreshCountView() {
    // Restore temp scans if any
    if ((tempScans.length > 0 || Object.keys(wizardCounts).length > 0) && !countingActive) countingActive = true;

    const totalEntries = tempScans.length + Object.keys(wizardCounts).length;

    if (countingActive) {
      countSessionBanner.classList.remove('no-shift');
      countSessionText.textContent = `Counting: ${tempScans.length} scanned, ${Object.keys(wizardCounts).length} manual`;
      startCountBtn.textContent = 'Reset Count';
      startCountBtn.className = 'btn btn-sm btn-danger';
      finalizeCountBtn.style.display = totalEntries > 0 ? '' : 'none';
      scanInputArea.style.display = '';
      countSummaryArea.style.display = '';
      if (countMode === 'scanner') {
        barcodeInput.focus();
        startScanner();
      }
      if (countMode === 'manual') initWizard();
    } else {
      countSessionBanner.classList.add('no-shift');
      countSessionText.textContent = 'No counting session active';
      startCountBtn.textContent = 'Start Counting';
      startCountBtn.className = 'btn btn-sm btn-success';
      finalizeCountBtn.style.display = 'none';
      scanInputArea.style.display = 'none';
      countSummaryArea.style.display = 'none';
    }

    renderCountSummary();
  }

  function renderCountSummary() {
    if (!countingActive) return;

    totalScannedBadge.textContent = `${tempScans.length} scanned`;

    // Group by game+pack
    const groups = {};
    tempScans.forEach(s => {
      const key = `${s.gameId}__${s.packNumber}`;
      if (!groups[key]) groups[key] = { gameId: s.gameId, packNumber: s.packNumber, tickets: new Set() };
      groups[key].tickets.add(s.ticketNumber);
    });

    const entries = Object.values(groups);
    if (entries.length === 0) {
      countPerGameList.innerHTML = `<div class="empty-state" style="padding:20px;">
        <p style="font-size:0.82rem;">Scan tickets to see summary here</p></div>`;
      missingTicketsArea.style.display = 'none';
      return;
    }

    // Also include packs that have NOT been scanned at all (to remind user)
    const activePacks = packs.filter(p => p.status !== 'finished');
    const scannedPackKeys = new Set(entries.map(e => `${e.gameId}__${e.packNumber}`));

    let html = '';

    // Scanned packs
    entries.forEach(e => {
      const game = games.find(g => g.gameId === e.gameId);
      const pack = packs.find(p => p.gameId === e.gameId && p.packNumber === e.packNumber);
      if (!game || !pack) return;

      const scannedArr = [...e.tickets].sort((a, b) => a - b);
      const allTickets = Array.from({ length: pack.totalTickets }, (_, i) => i + 1);
      const missing = allTickets.filter(t => !scannedArr.includes(t));
      const previouslySold = getPackPreviouslySoldTickets(pack);
      const newlySold = missing.filter(t => !previouslySold.includes(t));

      html += `<div class="game-item" style="flex-direction:column; align-items:stretch;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div class="game-info" style="flex:1;">
            <div class="game-number" style="min-width:auto;"><span style="font-size:0.55rem;opacity:0.7;">BIN</span><br>${game.binNumber || '?'}</div>
            <div class="game-number">#${game.gameId}</div>
            <div class="game-details">
              <h4>${game.gameName} · Pack #${e.packNumber}</h4>
              <div class="game-meta">
                <span>${formatCurrency(game.price)}</span>
                <span>Scanned: ${scannedArr.length}/${pack.totalTickets}</span>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            <span class="status-badge ${missing.length > 0 ? 'selling' : 'active'}">${missing.length} sold</span>
            <button class="btn btn-secondary btn-sm" onclick="window.txApp.showTicketDetail('${e.gameId}','${e.packNumber}')" title="View Details">Details</button>
          </div>
        </div>
        ${newlySold.length > 0 ? `
          <div style="margin-top:8px; padding:8px 10px; background:rgba(249,115,22,0.08); border-radius:var(--radius-sm); font-size:0.78rem;">
            <strong style="color:var(--accent-orange);">⚠ Not scanned (assumed sold):</strong>
            <span style="font-family:var(--font-mono); color:var(--text-primary);">${newlySold.map(t => padNum(t)).join(', ')}</span>
          </div>` : ''}
      </div>`;
    });

    // Un-scanned packs reminder
    const unscannedPacks = activePacks.filter(p => !scannedPackKeys.has(`${p.gameId}__${p.packNumber}`));
    if (unscannedPacks.length > 0) {
      html += `<div class="card" style="border-color:rgba(239,68,68,0.2); background:rgba(239,68,68,0.04); margin-top:8px;">
        <h4 style="color:var(--accent-red); margin-bottom:8px;">⚠ Packs Not Yet Scanned</h4>
        <p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:8px;">You haven't scanned any tickets from these packs yet. If no tickets were sold, scan at least one to confirm.</p>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">
          ${unscannedPacks.map(p => {
            const g = games.find(g => g.gameId === p.gameId);
            return `<span class="status-badge new">#${p.gameId} · Pk ${p.packNumber} (${g ? g.gameName : 'Unknown'})</span>`;
          }).join('')}
        </div>
      </div>`;
    }

    countPerGameList.innerHTML = html;

    // Global missing tickets area
    let allMissing = [];
    entries.forEach(e => {
      const pack = packs.find(p => p.gameId === e.gameId && p.packNumber === e.packNumber);
      if (!pack) return;
      const scannedArr = [...e.tickets];
      const allTickets = Array.from({ length: pack.totalTickets }, (_, i) => i + 1);
      const missing = allTickets.filter(t => !scannedArr.includes(t));
      const previouslySold = getPackPreviouslySoldTickets(pack);
      const newMissing = missing.filter(t => !previouslySold.includes(t));
      if (newMissing.length > 0) {
        const game = games.find(g => g.gameId === e.gameId);
        allMissing.push({ gameId: e.gameId, gameName: game ? game.gameName : 'Unknown', packNumber: e.packNumber, tickets: newMissing });
      }
    });

    if (allMissing.length > 0) {
      missingTicketsArea.style.display = '';
      missingTicketsList.innerHTML = allMissing.map(m =>
        `<div style="margin-bottom:8px; padding:8px 10px; background:var(--bg-input); border-radius:var(--radius-sm);">
          <div style="font-size:0.78rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">
            #${m.gameId} — ${m.gameName} · Pack #${m.packNumber}
          </div>
          <div style="font-family:var(--font-mono); font-size:0.85rem; color:var(--accent-orange);">
            Tickets: ${m.tickets.map(t => padNum(t)).join(', ')}
          </div>
        </div>`
      ).join('');
    } else {
      missingTicketsArea.style.display = 'none';
    }
  }

  function getPackPreviouslySoldTickets(pack) {
    // Get tickets marked sold in previous counts
    const soldSet = new Set();
    counts.forEach(c => {
      c.packResults.forEach(pr => {
        if (pr.gameId === pack.gameId && pr.packNumber === pack.packNumber) {
          pr.soldTickets.forEach(t => soldSet.add(t));
        }
      });
    });
    return [...soldSet];
  }

  // ===== BARCODE PROCESSING =====
  barcodeSubmitBtn.addEventListener('click', () => { processBarcode(barcodeInput.value.trim()); });
  barcodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') processBarcode(barcodeInput.value.trim());
  });

  // Manual ticket add
  manualTicketAddBtn.addEventListener('click', () => {
    const gameId = manualGameSelect.value;
    const packNum = manualPackSelect.value;
    const ticketNum = parseInt(manualTicketInput.value, 10);
    if (!gameId || !packNum || !ticketNum) return showToast('Fill game, pack, and ticket #', 'error');
    addScan(gameId, packNum, ticketNum);
    manualTicketInput.value = '';
    manualTicketInput.focus();
  });
  manualTicketInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') manualTicketAddBtn.click();
  });

  function processBarcode(raw) {
    if (!raw) return;
    if (!countingActive) return showToast('Start a counting session first', 'error');

    // Debounce same barcode within 2s
    const now = Date.now();
    if (raw === lastProcessedBarcode && now - lastProcessedTime < 2000) return;
    lastProcessedBarcode = raw;
    lastProcessedTime = now;

    const code = raw.replace(/\D/g, '');
    if (code.length < 13) {
      showScanFeedback('Barcode too short (need 13+ digits)', 'error');
      return;
    }

    // Parse: try 4-digit game ID first, then 3-digit
    let gameId, packNumber, ticketNumber, matched = false;

    const gid4 = code.substring(0, 4);
    if (games.find(g => g.gameId === gid4)) {
      gameId = gid4;
      packNumber = code.substring(4, 11);
      ticketNumber = parseInt(code.substring(11, 14), 10);
      matched = true;
    }
    if (!matched) {
      const gid3 = code.substring(0, 3);
      if (games.find(g => g.gameId === gid3)) {
        gameId = gid3;
        packNumber = code.substring(3, 10);
        ticketNumber = parseInt(code.substring(10, 13), 10);
        matched = true;
      }
    }

    if (!matched) {
      showScanFeedback('Game not recognized. Register it in Games tab first.', 'error');
      return;
    }

    // Auto-create pack if needed
    let pack = packs.find(p => p.gameId === gameId && p.packNumber === packNumber);
    if (!pack) {
      const game = games.find(g => g.gameId === gameId);
      if (!game) return;
      pack = {
        packId: uid(), gameId, packNumber,
        totalTickets: game.packSize, direction: 'asc',
        status: 'active', dateLoaded: new Date().toISOString()
      };
      packs.push(pack);
      save(KEYS.PACKS, packs);
      showToast(`Auto-created pack #${packNumber} for game #${gameId}`, 'info');
    }

    addScan(gameId, packNumber, ticketNumber);
    barcodeInput.value = '';
    barcodeInput.focus();
  }

  function addScan(gameId, packNumber, ticketNumber) {
    // Check duplicate
    const exists = tempScans.find(s => s.gameId === gameId && s.packNumber === packNumber && s.ticketNumber === ticketNumber);
    if (exists) {
      showScanFeedback(`Ticket #${padNum(ticketNumber)} already scanned (Game #${gameId}, Pack #${packNumber})`, 'error');
      return;
    }

    const game = games.find(g => g.gameId === gameId);
    const pack = packs.find(p => p.gameId === gameId && p.packNumber === packNumber);

    // Validate ticket number range
    if (pack && (ticketNumber < 1 || ticketNumber > pack.totalTickets)) {
      showScanFeedback(`Ticket #${padNum(ticketNumber)} is out of range (1-${pack.totalTickets})`, 'error');
      return;
    }

    tempScans.push({ gameId, packNumber, ticketNumber, timestamp: new Date().toISOString() });
    save(KEYS.TEMP_SCANS, tempScans);

    const gameName = game ? game.gameName : 'Unknown';
    showScanFeedback(`✓ Ticket #${padNum(ticketNumber)} — ${gameName} (Pack #${packNumber})`, 'success');
    renderCountSummary();
    countSessionText.textContent = `Counting: ${tempScans.length} ticket(s) scanned`;
  }

  function showScanFeedback(msg, type) {
    lastScanFeedback.style.display = '';
    lastScanFeedback.textContent = msg;
    lastScanFeedback.style.background = type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
    lastScanFeedback.style.color = type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)';
    lastScanFeedback.style.borderLeft = `3px solid ${type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)'}`;
  }

  // ===== CAMERA SCANNER =====
  const scannerVideo    = document.getElementById('scanner-video');
  const scannerStatus   = document.getElementById('scanner-status');
  const startScannerBtn = document.getElementById('start-scanner-btn');
  const stopScannerBtn  = document.getElementById('stop-scanner-btn');

  startScannerBtn.addEventListener('click', startScanner);
  stopScannerBtn.addEventListener('click', stopScanner);

  async function startScanner() {
    if (!countingActive) {
      showToast('Start a counting session first', 'error');
      return;
    }
    // If stream already active, don't re-request
    if (scannerStream) return;

    scannerStatus.textContent = 'Requesting camera permission...';
    scannerStatus.style.color = '#ffcc00';

    // Check if getUserMedia is available at all
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const msg = 'Camera not available. This app requires HTTPS to access the camera. Please make sure you are visiting via https://';
      scannerStatus.textContent = msg;
      scannerStatus.style.color = '#ff4444';
      alert(msg);
      return;
    }

    // Check permission state first (if Permissions API available)
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const permStatus = await navigator.permissions.query({ name: 'camera' });
        if (permStatus.state === 'denied') {
          const msg = 'Camera permission is BLOCKED. Go to your browser settings and allow camera access for this site, then reload.';
          scannerStatus.textContent = msg;
          scannerStatus.style.color = '#ff4444';
          alert(msg);
          return;
        }
      }
    } catch (permErr) {
      // Permissions API not supported on this browser, continue anyway
    }

    // Request camera access
    try {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
      } catch (envErr) {
        // Fallback: try any available camera
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      scannerStream = stream;
      scannerVideo.srcObject = stream;

      // Wait for video to be ready
      await new Promise((resolve, reject) => {
        scannerVideo.onloadedmetadata = resolve;
        scannerVideo.onerror = reject;
        setTimeout(() => reject(new Error('Video load timed out')), 5000);
      });

      await scannerVideo.play();

      scannerStatus.textContent = '✅ Camera active — point at barcode';
      scannerStatus.style.color = '#44ff44';
      startScannerBtn.style.display = 'none';
      stopScannerBtn.style.display = '';

      if ('BarcodeDetector' in window) {
        const detector = new BarcodeDetector({ formats: ['itf', 'code_128', 'code_39', 'ean_13'] });
        scannerInterval = setInterval(async () => {
          try {
            const barcodes = await detector.detect(scannerVideo);
            if (barcodes.length > 0) processBarcode(barcodes[0].rawValue);
          } catch { /* ignore detection errors */ }
        }, 500);
      } else {
        scannerStatus.textContent = '📷 Camera active — auto-detect unavailable. Type barcode below.';
        scannerStatus.style.color = '#ffcc00';
      }
    } catch (e) {
      // Clean up on failure
      if (scannerStream) {
        scannerStream.getTracks().forEach(t => t.stop());
      }
      scannerStream = null;
      scannerVideo.srcObject = null;

      let errorMsg = 'Unknown camera error';
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        errorMsg = 'Camera permission denied. Please allow camera access when prompted, or go to browser settings to enable it.';
      } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        errorMsg = 'No camera found on this device.';
      } else if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
        errorMsg = 'Camera is being used by another app. Close other apps using the camera and try again.';
      } else if (e.name === 'OverconstrainedError') {
        errorMsg = 'Camera does not support the requested settings.';
      } else if (e.name === 'SecurityError') {
        errorMsg = 'Camera blocked by security policy. HTTPS is required.';
      } else {
        errorMsg = 'Camera error: ' + (e.message || e.name || 'Unknown');
      }

      scannerStatus.textContent = '❌ ' + errorMsg;
      scannerStatus.style.color = '#ff4444';
      startScannerBtn.style.display = '';
      stopScannerBtn.style.display = 'none';
      alert('Camera Error: ' + errorMsg);
    }
  }

  function stopScanner() {
    if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
    if (scannerInterval) { clearInterval(scannerInterval); scannerInterval = null; }
    scannerVideo.srcObject = null;
    scannerStatus.textContent = 'Scanner stopped';
    scannerStatus.style.color = '';
    startScannerBtn.style.display = '';
    stopScannerBtn.style.display = 'none';
  }

  // ===== TICKET DETAIL MODAL =====
  const ticketDetailModal = document.getElementById('ticket-detail-modal');
  const ticketDetailTitle = document.getElementById('ticket-detail-title');
  const ticketDetailBody  = document.getElementById('ticket-detail-body');
  const ticketDetailClose = document.getElementById('ticket-detail-close');
  const ticketDetailCloseBtn = document.getElementById('ticket-detail-close-btn');

  [ticketDetailClose, ticketDetailCloseBtn].forEach(el =>
    el.addEventListener('click', () => ticketDetailModal.classList.remove('open'))
  );

  window.txApp = window.txApp || {};
  window.txApp.showTicketDetail = function(gameId, packNumber) {
    const game = games.find(g => g.gameId === gameId);
    const pack = packs.find(p => p.gameId === gameId && p.packNumber === packNumber);
    if (!game || !pack) return;

    ticketDetailTitle.textContent = `#${gameId} — ${game.gameName} · Pack #${packNumber}`;

    const scannedSet = new Set();
    tempScans.forEach(s => {
      if (s.gameId === gameId && s.packNumber === packNumber) scannedSet.add(s.ticketNumber);
    });

    const previouslySold = new Set(getPackPreviouslySoldTickets(pack));

    let gridHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(52px,1fr)); gap:4px; margin-top:12px;">`;
    for (let t = 1; t <= pack.totalTickets; t++) {
      let style = '';
      let label = padNum(t);
      if (scannedSet.has(t)) {
        style = 'background:rgba(34,197,94,0.15); color:var(--accent-green); border:1px solid rgba(34,197,94,0.3);';
      } else if (previouslySold.has(t)) {
        style = 'background:rgba(107,114,128,0.15); color:var(--text-muted); border:1px solid rgba(107,114,128,0.2); text-decoration:line-through;';
      } else {
        style = 'background:rgba(249,115,22,0.15); color:var(--accent-orange); border:1px solid rgba(249,115,22,0.3); font-weight:700;';
      }
      gridHTML += `<div style="${style} padding:6px 4px; border-radius:4px; text-align:center; font-family:var(--font-mono); font-size:0.72rem;">${label}</div>`;
    }
    gridHTML += `</div>`;

    gridHTML += `<div style="display:flex; gap:16px; margin-top:12px; font-size:0.72rem; color:var(--text-muted);">
      <span><span style="display:inline-block;width:12px;height:12px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);border-radius:2px;vertical-align:middle;margin-right:4px;"></span> Remaining (scanned)</span>
      <span><span style="display:inline-block;width:12px;height:12px;background:rgba(249,115,22,0.15);border:1px solid rgba(249,115,22,0.3);border-radius:2px;vertical-align:middle;margin-right:4px;"></span> Sold (not scanned)</span>
      <span><span style="display:inline-block;width:12px;height:12px;background:rgba(107,114,128,0.15);border:1px solid rgba(107,114,128,0.2);border-radius:2px;vertical-align:middle;margin-right:4px;"></span> Previously sold</span>
    </div>`;

    ticketDetailBody.innerHTML = gridHTML;
    ticketDetailModal.classList.add('open');
  };

  // ===== REPORTS =====
  const reportTypeTabs  = document.getElementById('report-type-tabs');
  const reportOutput    = document.getElementById('report-output');
  const printReportBtn  = document.getElementById('print-report-btn');
  const reportDatePicker = document.getElementById('report-date-picker');

  reportDatePicker.value = todayStr();
  reportTypeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.report-type-btn');
    if (!btn) return;
    activeReportType = btn.dataset.report;
    reportTypeTabs.querySelectorAll('.report-type-btn').forEach(b => b.classList.toggle('active', b === btn));
    generateReport();
  });
  reportDatePicker.addEventListener('change', generateReport);

  function generateReport() {
    const date = reportDatePicker.value || todayStr();
    if (activeReportType === 'shift')    generateShiftReport(date);
    else if (activeReportType === 'day') generateDayReport(date);
    else if (activeReportType === 'packs') generatePackReport();
    else if (activeReportType === 'history') generateHistoryReport(date);
  }

  function generateShiftReport(date) {
    let shiftCounts;
    let subtitle;
    if (currentShift) {
      shiftCounts = counts.filter(c => c.shiftId === currentShift.shiftId);
      const startT = new Date(currentShift.startTime).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
      const endT = currentShift.endTime
        ? new Date(currentShift.endTime).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true })
        : 'Active';
      subtitle = `${startT} — ${endT}`;
    } else {
      shiftCounts = counts.filter(c => c.date === date);
      subtitle = 'No active shift — showing all for ' + date;
    }
    renderCountReport(shiftCounts, 'Shift Report', subtitle);
  }

  function generateDayReport(date) {
    const dayCounts = counts.filter(c => c.date === date);
    renderCountReport(dayCounts, "Day Report — " + date, date);
  }

  function renderCountReport(countData, title, subtitle) {
    if (countData.length === 0) {
      reportOutput.innerHTML = `<div class="empty-state" style="padding:40px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        <h3>No Data</h3><p>No counts finalized for this period</p></div>`;
      return;
    }

    // Aggregate by game
    const gameAgg = {};
    countData.forEach(c => {
      c.packResults.forEach(pr => {
        const g = games.find(g => g.gameId === pr.gameId);
        const key = pr.gameId;
        if (!gameAgg[key]) {
          gameAgg[key] = {
            gameId: pr.gameId,
            gameName: g ? g.gameName : 'Unknown',
            binNumber: g ? g.binNumber : 0,
            price: g ? g.price : 0,
            soldCount: 0, total: 0, packs: []
          };
        }
        gameAgg[key].soldCount += pr.soldTickets.length;
        gameAgg[key].total += pr.soldTickets.length * (g ? g.price : 0);
        gameAgg[key].packs.push({ packNumber: pr.packNumber, sold: pr.soldTickets.length });
      });
    });

    const rows = Object.values(gameAgg).sort((a, b) => (a.binNumber || 0) - (b.binNumber || 0));
    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    const totalTickets = rows.reduce((s, r) => s + r.soldCount, 0);

    reportOutput.innerHTML = `
      <div class="report-header-bar">
        <h3>${title}</h3>
        <span class="report-date">${subtitle}</span>
      </div>
      <div class="report-table-container">
        <table class="report-table">
          <thead><tr>
            <th>Bin</th><th>Game #</th><th>Game Name</th>
            <th style="text-align:right;">Price</th>
            <th style="text-align:right;">Sold</th>
            <th style="text-align:right;">Revenue</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="mono">${r.binNumber || '-'}</td>
              <td class="mono">${r.gameId}</td>
              <td>${r.gameName}</td>
              <td class="mono" style="text-align:right;">${formatCurrency(r.price)}</td>
              <td class="mono" style="text-align:right;">${r.soldCount}</td>
              <td class="amount" style="text-align:right;">${formatCurrency(r.total)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="4" style="text-align:right;">Grand Total</td>
            <td class="mono" style="text-align:right;">${totalTickets}</td>
            <td class="amount" style="text-align:right;">${formatCurrency(grandTotal)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div class="report-summary">
        <div class="report-summary-item"><div class="label">Tickets Sold</div>
          <div class="value" style="color:var(--accent-blue);">${totalTickets}</div></div>
        <div class="report-summary-item"><div class="label">Total Revenue</div>
          <div class="value" style="color:var(--accent-green);">${formatCurrency(grandTotal)}</div></div>
        <div class="report-summary-item"><div class="label">Games Active</div>
          <div class="value" style="color:var(--accent-gold);">${rows.length}</div></div>
        <div class="report-summary-item"><div class="label">Avg Per Ticket</div>
          <div class="value" style="color:var(--accent-purple);">${formatCurrency(totalTickets > 0 ? grandTotal / totalTickets : 0)}</div></div>
      </div>`;
  }

  function generatePackReport() {
    if (packs.length === 0) {
      reportOutput.innerHTML = `<div class="empty-state" style="padding:40px;"><h3>No Packs</h3><p>No packs loaded</p></div>`;
      return;
    }
    const rows = packs.map(p => {
      const g = games.find(g => g.gameId === p.gameId);
      const sold = getPackSoldTotal(p);
      return { ...p, gameName: g ? g.gameName : '?', price: g ? g.price : 0, binNumber: g ? g.binNumber : 0, sold, remaining: p.totalTickets - sold, pct: Math.round((sold / p.totalTickets) * 100) };
    }).sort((a, b) => { const o = { active: 0, selling: 1, finished: 2 }; return (o[a.status]||3) - (o[b.status]||3); });

    reportOutput.innerHTML = `
      <div class="report-header-bar"><h3>Pack Inventory</h3><span class="report-date">${nowDateTime()}</span></div>
      <div class="report-table-container">
        <table class="report-table">
          <thead><tr><th>Bin</th><th>Game#</th><th>Name</th><th>Pack#</th><th style="text-align:right;">Sold</th><th style="text-align:right;">Rem.</th><th style="text-align:right;">%</th><th>Status</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td class="mono">${r.binNumber||'-'}</td><td class="mono">${r.gameId}</td><td>${r.gameName}</td><td class="mono">${r.packNumber}</td>
            <td class="mono" style="text-align:right;">${r.sold}</td><td class="mono" style="text-align:right;">${r.remaining}</td>
            <td class="mono" style="text-align:right;">${r.pct}%</td><td><span class="status-badge ${r.status}">${r.status}</span></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function generateHistoryReport(date) {
    const allDates = [...new Set(counts.map(c => c.date))].sort().reverse();
    if (allDates.length === 0) {
      reportOutput.innerHTML = `<div class="empty-state" style="padding:40px;"><h3>No History</h3><p>No counts recorded yet</p></div>`;
      return;
    }

    let html = `<div class="report-header-bar"><h3>Count History</h3><span class="report-date">All dates</span></div>`;
    html += `<div class="report-table-container"><table class="report-table">
      <thead><tr><th>Date</th><th>Time</th><th style="text-align:right;">Packs</th><th style="text-align:right;">Tickets Sold</th><th style="text-align:right;">Revenue</th></tr></thead><tbody>`;

    counts.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).forEach(c => {
      const totalSold = c.packResults.reduce((s, pr) => s + pr.soldTickets.length, 0);
      let rev = 0;
      c.packResults.forEach(pr => { const g = games.find(g => g.gameId === pr.gameId); if (g) rev += pr.soldTickets.length * g.price; });
      const t = new Date(c.timestamp).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
      html += `<tr><td>${c.date}</td><td>${t}</td><td class="mono" style="text-align:right;">${c.packResults.length}</td>
        <td class="mono" style="text-align:right;">${totalSold}</td><td class="amount" style="text-align:right;">${formatCurrency(rev)}</td></tr>`;
    });

    html += `</tbody></table></div>`;
    reportOutput.innerHTML = html;
  }

  // ===== PRINT =====
  printReportBtn.addEventListener('click', () => {
    const date = reportDatePicker.value || todayStr();
    let countData, title;

    if (activeReportType === 'shift') {
      countData = currentShift ? counts.filter(c => c.shiftId === currentShift.shiftId) : counts.filter(c => c.date === date);
      title = 'SHIFT REPORT';
    } else if (activeReportType === 'day') {
      countData = counts.filter(c => c.date === date);
      title = 'DAILY REPORT';
    } else if (activeReportType === 'packs') {
      printPackReport(); return;
    } else {
      printHistoryReport(); return;
    }

    printCountReport(countData, title, date);
  });

  function printCountReport(countData, title, date) {
    const gameAgg = {};
    countData.forEach(c => {
      c.packResults.forEach(pr => {
        const g = games.find(g => g.gameId === pr.gameId);
        if (!gameAgg[pr.gameId]) {
          gameAgg[pr.gameId] = { gameId: pr.gameId, gameName: g ? g.gameName : '?', binNumber: g ? g.binNumber : 0, price: g ? g.price : 0, soldCount: 0, total: 0 };
        }
        gameAgg[pr.gameId].soldCount += pr.soldTickets.length;
        gameAgg[pr.gameId].total += pr.soldTickets.length * (g ? g.price : 0);
      });
    });

    const rows = Object.values(gameAgg).sort((a, b) => (a.binNumber || 0) - (b.binNumber || 0));
    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    const totalTickets = rows.reduce((s, r) => s + r.soldCount, 0);
    const storeName = settings.storeName || 'TX Scratch Counter';
    const storeAddr = settings.storeAddress || '';
    const license   = settings.license || '';

    const shiftTime = currentShift ? (() => {
      const st = new Date(currentShift.startTime).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
      const et = currentShift.endTime ? new Date(currentShift.endTime).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true }) : 'Active';
      return `Shift: ${st} — ${et}`;
    })() : '';

    document.getElementById('print-report-area').innerHTML = `
      <div class="print-report">
        <div class="print-report-header">
          <h1>${storeName}</h1>
          ${storeAddr ? `<div class="store-info">${storeAddr}</div>` : ''}
          ${license ? `<div class="store-info">License: ${license}</div>` : ''}
          <div class="report-title">${title}</div>
          <div class="report-datetime">Date: ${date} ${shiftTime ? ' · ' + shiftTime : ''}</div>
          <div class="report-datetime">Printed: ${nowDateTime()}</div>
        </div>
        <hr class="print-separator">
        <table class="print-table">
          <thead><tr><th>Bin</th><th>Game#</th><th>Game Name</th><th class="right">Price</th><th class="right">Sold</th><th class="right">Total</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td>${r.binNumber||'-'}</td><td>${r.gameId}</td><td>${r.gameName}</td>
            <td class="right">${formatCurrency(r.price)}</td><td class="right">${r.soldCount}</td><td class="right">${formatCurrency(r.total)}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="4" class="right">GRAND TOTAL</td><td class="right">${totalTickets}</td><td class="right">${formatCurrency(grandTotal)}</td></tr></tfoot>
        </table>
        <hr class="print-separator">
        <div class="print-summary">
          <div class="print-summary-item"><div class="label">Tickets</div><div class="value">${totalTickets}</div></div>
          <div class="print-summary-item"><div class="label">Revenue</div><div class="value">${formatCurrency(grandTotal)}</div></div>
          <div class="print-summary-item"><div class="label">Games</div><div class="value">${rows.length}</div></div>
        </div>
        ${printOpenPacks()}
        <div class="print-footer"><p>*** End of Report ***</p><div class="signature-line">Employee Signature</div></div>
      </div>`;
    window.print();
  }

  function printOpenPacks() {
    const open = packs.filter(p => p.status !== 'finished');
    if (open.length === 0) return '';
    return `<div class="print-pack-section"><h3>OPEN PACKS</h3>
      <table class="print-table"><thead><tr><th>Bin</th><th>Game#</th><th>Pack#</th><th class="right">Sold</th><th class="right">Rem.</th><th>Status</th></tr></thead>
      <tbody>${open.map(p => {
        const g = games.find(g => g.gameId === p.gameId);
        const sold = getPackSoldTotal(p);
        return `<tr><td>${g ? g.binNumber || '-' : '-'}</td><td>${p.gameId}</td><td>${p.packNumber}</td>
          <td class="right">${sold}</td><td class="right">${p.totalTickets - sold}</td><td>${p.status.toUpperCase()}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function printPackReport() {
    const storeName = settings.storeName || 'TX Scratch Counter';
    document.getElementById('print-report-area').innerHTML = `
      <div class="print-report">
        <div class="print-report-header"><h1>${storeName}</h1>
          <div class="report-title">PACK INVENTORY</div><div class="report-datetime">Printed: ${nowDateTime()}</div></div>
        <hr class="print-separator">
        <table class="print-table"><thead><tr><th>Bin</th><th>Game#</th><th>Name</th><th>Pack#</th><th class="right">Sold</th><th class="right">Rem.</th><th class="right">%</th><th>Status</th></tr></thead>
        <tbody>${packs.map(p => {
          const g = games.find(g => g.gameId === p.gameId);
          const sold = getPackSoldTotal(p);
          const pct = Math.round((sold / p.totalTickets) * 100);
          return `<tr><td>${g ? g.binNumber||'-' : '-'}</td><td>${p.gameId}</td><td>${g ? g.gameName : '?'}</td><td>${p.packNumber}</td>
            <td class="right">${sold}</td><td class="right">${p.totalTickets - sold}</td><td class="right">${pct}%</td><td>${p.status.toUpperCase()}</td></tr>`;
        }).join('')}</tbody></table>
        <div class="print-footer"><p>*** End of Report ***</p><div class="signature-line">Employee Signature</div></div>
      </div>`;
    window.print();
  }

  function printHistoryReport() {
    const storeName = settings.storeName || 'TX Scratch Counter';
    document.getElementById('print-report-area').innerHTML = `
      <div class="print-report">
        <div class="print-report-header"><h1>${storeName}</h1>
          <div class="report-title">COUNT HISTORY</div><div class="report-datetime">Printed: ${nowDateTime()}</div></div>
        <hr class="print-separator">
        <table class="print-table"><thead><tr><th>Date</th><th>Time</th><th class="right">Packs</th><th class="right">Sold</th><th class="right">Revenue</th></tr></thead>
        <tbody>${counts.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map(c => {
          const sold = c.packResults.reduce((s, pr) => s + pr.soldTickets.length, 0);
          let rev = 0; c.packResults.forEach(pr => { const g = games.find(g => g.gameId === pr.gameId); if (g) rev += pr.soldTickets.length * g.price; });
          return `<tr><td>${c.date}</td><td>${new Date(c.timestamp).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true})}</td>
            <td class="right">${c.packResults.length}</td><td class="right">${sold}</td><td class="right">${formatCurrency(rev)}</td></tr>`;
        }).join('')}</tbody></table>
        <div class="print-footer"><p>*** End of Report ***</p></div>
      </div>`;
    window.print();
  }

  // ===== SETTINGS =====
  const settingsBtn       = document.getElementById('settings-btn');
  const settingsModal     = document.getElementById('settings-modal');
  const settingsModalClose = document.getElementById('settings-modal-close');
  const settingsSaveBtn   = document.getElementById('settings-save-btn');
  const sStoreName        = document.getElementById('settings-store-name');
  const sStoreAddress     = document.getElementById('settings-store-address');
  const sLicense          = document.getElementById('settings-license');
  const exportDataBtn     = document.getElementById('export-data-btn');
  const importDataBtn     = document.getElementById('import-data-btn');
  const importFileInput   = document.getElementById('import-file-input');

  settingsBtn.addEventListener('click', () => {
    sStoreName.value    = settings.storeName || '';
    sStoreAddress.value = settings.storeAddress || '';
    sLicense.value      = settings.license || '';
    settingsModal.classList.add('open');
  });
  settingsModalClose.addEventListener('click', () => settingsModal.classList.remove('open'));
  settingsSaveBtn.addEventListener('click', () => {
    settings.storeName    = sStoreName.value.trim();
    settings.storeAddress = sStoreAddress.value.trim();
    settings.license      = sLicense.value.trim();
    save(KEYS.SETTINGS, settings);
    settingsModal.classList.remove('open');
    showToast('Settings saved', 'success');
  });

  exportDataBtn.addEventListener('click', () => {
    const data = { games, packs, counts, settings, currentShift, exportDate: new Date().toISOString(), version: '2.0' };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `txscratch_backup_${todayStr()}.json`; a.click(); URL.revokeObjectURL(a.href);
    showToast('Data exported', 'success');
  });

  importDataBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const d = JSON.parse(ev.target.result);
        if (d.games) games = d.games;
        if (d.packs) packs = d.packs;
        if (d.counts) counts = d.counts;
        if (d.settings) settings = d.settings;
        if (d.currentShift !== undefined) currentShift = d.currentShift;
        save(KEYS.GAMES, games); save(KEYS.PACKS, packs);
        save(KEYS.COUNTS, counts); save(KEYS.SETTINGS, settings);
        save(KEYS.SHIFT, currentShift);
        showToast('Data imported!', 'success');
        refreshAll();
      } catch { showToast('Invalid backup file', 'error'); }
    };
    reader.readAsText(file);
    importFileInput.value = '';
  });

  // ===== GLOBAL API =====
  window.txApp = {
    ...window.txApp,
    editGame(gameId) { const g = games.find(g => g.gameId === gameId); if (g) openGameModal(g); },
    toggleGameStatus(gameId) {
      const g = games.find(g => g.gameId === gameId);
      if (!g) return;
      if (g.status === 'active') {
        showConfirm('Finish Game', `Mark game #${gameId} as finished?`, () => {
          g.status = 'finished';
          save(KEYS.GAMES, games);
          renderGames(); refreshDashboard();
          showToast(`Game #${gameId} finished`, 'info');
        });
      } else {
        g.status = 'active';
        save(KEYS.GAMES, games);
        renderGames(); refreshDashboard();
        showToast(`Game #${gameId} reactivated`, 'success');
      }
    },
    loadPackForGame(gameId) { openPackModal(gameId); }
  };

  // ===== REFRESH ALL =====
  function refreshAll() {
    updateShiftBanner();
    refreshDashboard();
    renderGames();
    refreshCountView();
    if (activeView === 'reports') generateReport();
  }

  // ===== INIT =====
  refreshAll();

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(o =>
    o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); })
  );

  // Register service worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

})();
