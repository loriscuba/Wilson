// ── Navigation ───────────────────────────────────────────────────────────────

function updateMobileNavActive(pageId) {
  document.querySelectorAll('.bottom-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
}

function mobileNavSelect(pageId, event) {
  event.preventDefault();
  showPage(pageId, event);
  updateMobileNavActive(pageId);
  closeMobileDrawer();
  document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleMobileDrawer(event) {
  event?.stopPropagation();
  document.getElementById('mobile-drawer-overlay')?.classList.toggle('open');
}

function closeMobileDrawer() {
  document.getElementById('mobile-drawer-overlay')?.classList.remove('open');
}

function handleMobileDrawerOverlay(event) {
  if (event.target.id === 'mobile-drawer-overlay') {
    closeMobileDrawer();
  }
}

const PAGE_LOADERS = {
  dashboard:    loadDashboard,
  ordini:       () => { _initOrdiniDates(); loadOrdini(); },
  clienti:      loadClienti,
  ddt:          loadDDT,
  budget:       loadBudget,
  statistiche:  loadStatistiche,
  agenda:       loadAgenda,
  impostazioni: loadImpostazioni,
};

function _setNavActive(pageId) {
  document.querySelectorAll('.top-nav-link').forEach(a => a.classList.remove('active'));
  document.querySelector(`.top-nav-link[data-page="${pageId}"]`)?.classList.add('active');
  updateMobileNavActive(pageId);
}

function navToPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId)?.classList.add('active');
  _setNavActive(pageId);
  PAGE_LOADERS[pageId]?.();
}

function showPage(pageId, event) {
  event.preventDefault();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId)?.classList.add('active');
  _setNavActive(pageId);
  PAGE_LOADERS[pageId]?.();
}

function initMobileSectionObserver() {
  const root = document.getElementById('main-content');
  if (!root || !window.IntersectionObserver) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const id = entry.target.id;
      if (!id) return;
      if (entry.isIntersecting && entry.intersectionRatio > 0.35) {
        updateMobileNavActive(id);
      }
    });
  }, {
    root,
    threshold: [0.35],
  });
  document.querySelectorAll('.page').forEach(page => observer.observe(page));
}

// ── Sync ─────────────────────────────────────────────────────────────────────

async function loadUltimoSync() {
  const el  = document.getElementById('ultimo-sync');
  const mel = document.getElementById('mobile-ultimo-sync');
  try {
    const { data, error } = await sb.from('importazioni')
      .select('created_at').eq('esito', 'ok')
      .order('created_at', { ascending: false }).limit(1).single();
    if (error || !data) {
      if (el)  el.textContent  = 'Nessun sync';
      if (mel) mel.textContent = 'Nessun sync';
      return;
    }
    const d = new Date(data.created_at);
    const txt = 'Agg. ' + d.toLocaleString('it-IT', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    if (el)  el.textContent  = txt;
    if (mel) mel.textContent = txt;
  } catch {
    if (el)  el.textContent  = '—';
    if (mel) mel.textContent = '—';
  }
}

function _reloadActivePage() {
  _latestRollingDate  = null;
  _rollingEnriched    = null;
  _clientiEsclusi     = null;
  _ordinaDiPersonaSet = null;
  const activePage = document.querySelector('.page.active')?.id;
  if (activePage && PAGE_LOADERS[activePage]) PAGE_LOADERS[activePage]();
  loadUltimoSync();
}

function _syncDone(btn, icon, label, ok) {
  const mBtn   = document.getElementById('mobile-sync-btn');
  const mIcon  = document.getElementById('mobile-sync-icon');
  const mLabel = document.getElementById('mobile-sync-label');

  icon.className   = '';
  icon.textContent = ok ? '✓' : '⚠';
  if (label)  label.textContent  = ok ? 'Aggiornato' : 'Timeout';
  btn.classList.add(ok ? 'success' : 'error');
  if (mIcon)  { mIcon.className = ''; mIcon.textContent = ok ? '✓' : '⚠'; }
  if (mLabel) mLabel.textContent = ok ? 'Aggiornato' : 'Timeout';
  if (mBtn)   mBtn.classList.add(ok ? 'success' : 'error');

  setTimeout(() => {
    btn.classList.remove('success', 'error');
    icon.textContent  = '↻';
    if (label)  label.textContent  = 'Aggiorna dati';
    btn.disabled = false;
    if (mBtn)   { mBtn.classList.remove('success', 'error'); mBtn.disabled = false; }
    if (mIcon)  mIcon.textContent  = '↻';
    if (mLabel) mLabel.textContent = 'Aggiorna dati';
  }, 3000);
}

async function triggerSync() {
  const btn   = document.getElementById('sync-btn');
  const icon  = document.getElementById('sync-icon');
  const label = document.getElementById('sync-label');
  const mBtn   = document.getElementById('mobile-sync-btn');
  const mIcon  = document.getElementById('mobile-sync-icon');
  const mLabel = document.getElementById('mobile-sync-label');
  const token  = window.__env?.GITHUB_TOKEN;

  btn.disabled = true;
  btn.classList.remove('success', 'error');
  icon.className    = 'spin';
  icon.textContent  = '↻';
  if (label)  label.textContent  = 'Aggiorna dati';
  if (mBtn)   { mBtn.disabled = true; mBtn.classList.remove('success', 'error'); }
  if (mIcon)  { mIcon.className = 'spin'; mIcon.textContent = '↻'; }
  if (mLabel) mLabel.textContent = 'Aggiorna…';

  // Senza token: ricarica solo la UI
  if (!token) {
    _reloadActivePage();
    _syncDone(btn, icon, label, true);
    return;
  }

  const REPO      = 'loriscuba/Wilson';
  const WORKFLOWS = ['wilson_sync.yml', 'shippeo_tracking.yml'];
  const HEADERS   = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  // Dispatch entrambi i workflow
  const dispatchedAt = Date.now();
  await Promise.all(WORKFLOWS.map(wf =>
    fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${wf}/dispatches`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ ref: 'main' }),
    }).catch(() => {})
  ));

  // Polling ogni 10s, timeout 3 minuti
  const MAX_MS  = 3 * 60 * 1000;
  const POLL_MS = 10 * 1000;
  let elapsed   = 0;

  async function latestRun(wf) {
    try {
      const r = await fetch(
        `https://api.github.com/repos/${REPO}/actions/workflows/${wf}/runs?per_page=1`,
        { headers: HEADERS }
      );
      const j = await r.json();
      return j.workflow_runs?.[0] || null;
    } catch { return null; }
  }

  const pollTimer = setInterval(async () => {
    elapsed += POLL_MS;
    const prog = `in corso… ${Math.round(elapsed / 1000)}s`;
    label.textContent = prog;
    if (mLabel) mLabel.textContent = prog;

    if (elapsed >= MAX_MS) {
      clearInterval(pollTimer);
      _reloadActivePage();
      _syncDone(btn, icon, label, false);
      return;
    }

    const runs = await Promise.all(WORKFLOWS.map(latestRun));
    // Considera solo le run avviate dopo il dispatch (margine 5s per skew)
    const relevant = runs.filter(r => r && new Date(r.created_at).getTime() >= dispatchedAt - 5000);
    if (relevant.length < WORKFLOWS.length) return; // non tutte partite

    const allDone = relevant.every(r => r.status === 'completed');
    if (!allDone) return;

    clearInterval(pollTimer);
    _reloadActivePage();
    _syncDone(btn, icon, label, relevant.every(r => r.conclusion === 'success'));
  }, POLL_MS);
}

// ── Nav compact on scroll ────────────────────────────────────────────────────
document.getElementById('main-content')?.addEventListener('scroll', function () {
  document.getElementById('top-nav')?.classList.toggle('compact', this.scrollTop > 30);
}, { passive: true });

// ── Init ─────────────────────────────────────────────────────────────────────
loadDashboard();
loadUltimoSync();
