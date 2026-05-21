// ── Navigation ───────────────────────────────────────────────────────────────

let _sidebarOpen = false;

function toggleSidebar() {
  _sidebarOpen = !_sidebarOpen;
  document.getElementById('sidebar').classList.toggle('open', _sidebarOpen);
  document.getElementById('main-content').classList.toggle('shifted', _sidebarOpen);
}

const PAGE_LOADERS = {
  dashboard: loadDashboard,
  ordini:    loadOrdini,
  clienti:   loadClienti,
  ddt:       loadDDT,
  budget:    loadBudget,
};

function showPage(pageId, event) {
  event.preventDefault();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId)?.classList.add('active');
  document.querySelectorAll('.sidebar a').forEach(a => a.classList.remove('active'));
  if (event?.currentTarget?.classList) event.currentTarget.classList.add('active');
  PAGE_LOADERS[pageId]?.();
}

// ── Sync ─────────────────────────────────────────────────────────────────────

async function loadUltimoSync() {
  const el = document.getElementById('ultimo-sync');
  try {
    const { data, error } = await sb.from('importazioni')
      .select('created_at').eq('esito', 'ok')
      .order('created_at', { ascending: false }).limit(1).single();
    if (error || !data) { el.textContent = 'Nessun sync'; return; }
    const d = new Date(data.created_at);
    el.textContent = 'Agg. ' + d.toLocaleString('it-IT', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { el.textContent = '—'; }
}

async function triggerSync() {
  const btn  = document.getElementById('sync-btn');
  const icon = document.getElementById('sync-icon');
  const token = window.__env?.GITHUB_TOKEN;

  if (!token) { alert('GITHUB_TOKEN non configurato in env.js'); return; }

  btn.disabled = true;
  btn.classList.remove('success', 'error');
  icon.className   = 'spin';
  icon.textContent = '↻';

  try {
    const res = await fetch(
      'https://api.github.com/repos/loriscuba/Wilson/actions/workflows/wilson_sync.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (res.status !== 204) throw new Error(`HTTP ${res.status}`);

    icon.className = '';
    icon.textContent = '✓';
    btn.classList.add('success');
    setTimeout(() => {
      btn.classList.remove('success');
      icon.textContent = '↻';
      btn.disabled = false;
      _latestRollingDate = null;
      _rollingEnriched   = null;
      loadUltimoSync();
    }, 3000);
  } catch (err) {
    icon.className   = '';
    icon.textContent = '✕';
    btn.classList.add('error');
    setTimeout(() => {
      btn.classList.remove('error');
      icon.textContent = '↻';
      btn.disabled = false;
    }, 3000);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadDashboard();
loadUltimoSync();
