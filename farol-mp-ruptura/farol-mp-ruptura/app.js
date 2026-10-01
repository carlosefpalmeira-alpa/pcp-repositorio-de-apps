
/* ============================================================
   Torre de Controle PCP — Farol de Disponibilidade de MP & Ruptura
   ============================================================ */

const STORAGE_KEY = 'mp-dashboard-dataset';
const CAUSAS = ['Bloqueio de Qualidade', 'Falta MP', 'Divergência de Consumo', 'Inutilizado Alto', 'Quebra de Equipamento', 'Falta Mão de Obra', 'Outros'];
const PLANTS = ['A022', 'A026', 'A055', 'A133'];
const MAX_SNAPSHOTS = 30;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024; // stay safely under the 5MB storage limit

let DATASET = { snapshots: [] };
let STATE = { month: null, plant: 'TODAS', tech: '' };
let OPEN_TECHS = new Set();

/* ---------------- Utility ---------------- */
function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (Math.ceil(v * 1000) / 10).toFixed(1);
}
function clampPct(v) {
  // display-capped at 100 for readability, underlying farol logic uses raw value
  if (v === null || v === undefined) return null;
  return Math.min(v, 1.2);
}
function farolFromPct(v) {
  if (v === null || v === undefined) return 'gray';
  if (v >= 0.95) return 'green';
  if (v >= 0.90) return 'yellow';
  return 'red';
}
// Per-model (individual SKU) farol: only exactly at/above 100% counts as green.
// Anything below that is either Parcial (>=90%) or Crítico (<90%) — there is no
// "almost there" green for a single model, since it either has 100% of its MP or it doesn't.
function rowFarolFromPct(v) {
  if (v === null || v === undefined) return 'gray';
  if (v >= 0.9995) return 'green';
  if (v >= 0.90) return 'yellow';
  return 'red';
}
function rowFarolLabel(c) {
  return c === 'green' ? '100%' : c === 'yellow' ? 'Parcial' : c === 'red' ? 'Crítico' : 'Sem dado';
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function nowStamp() {
  const d = new Date();
  return d.toISOString();
}
function fmtStamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return iso; }
}
function fmtInt(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Math.round(v).toLocaleString('pt-BR');
}
function farolColorHex(v) {
  const c = farolFromPct(v);
  return c === 'green' ? '#16a34a' : c === 'yellow' ? '#d97706' : c === 'red' ? '#dc2626' : '#d0d5dd';
}
function computePercentual(row) {
  if (row.mptipo === 'Comum' || row.mptipo === 'Especifica - Não critica' || row.mptipo === 'Especifica - Nao critica') return 1;
  if (!row.previaAgosto || row.previaAgosto <= 0) return null;
  if (row.estoqueInicial === 0) return 0;
  return row.estoqueInicial / row.previaAgosto;
}

/* ---------------- Storage ---------------- */
// Claude's shared window.storage only exists inside claude.ai artifacts. When this
// dashboard is deployed standalone (Vercel, GitHub Pages, etc.) we fall back to the
// browser's own localStorage so saving still works — it just won't be shared across
// devices/people the way it is inside Claude. IS_STANDALONE drives a small UI notice.
const IS_STANDALONE = typeof window.storage === 'undefined' || !window.storage;
const STORAGE_DRIVER = IS_STANDALONE
  ? {
      async get(key) {
        try {
          const v = localStorage.getItem(key);
          return v === null ? null : { value: v };
        } catch (e) { return null; }
      },
      async set(key, value) {
        localStorage.setItem(key, value);
        return true;
      }
    }
  : {
      async get(key) { return window.storage.get(key, true); },
      async set(key, value) { return window.storage.set(key, value, true); }
    };

async function loadDataset() {
  try {
    const res = await STORAGE_DRIVER.get(STORAGE_KEY);
    if (res && res.value) {
      const parsed = JSON.parse(res.value);
      if (parsed && Array.isArray(parsed.snapshots) && parsed.snapshots.length) {
        return parsed;
      }
    }
  } catch (e) { /* no existing data */ }
  return null;
}
async function saveDataset(attempt = 1, silent = false) {
  // savedAt marks a user-driven change (upload / ruptura edit / restore). Initial
  // persistence of published data is silent and must NOT look like a newer local edit.
  if (!silent) DATASET.savedAt = Date.now();
  if (DATASET.snapshots.length > MAX_SNAPSHOTS) {
    DATASET.snapshots = DATASET.snapshots.slice(DATASET.snapshots.length - MAX_SNAPSHOTS);
  }
  let payload = JSON.stringify(DATASET);
  // if the file(s) this week are bigger than usual, count-based pruning alone isn't
  // enough — keep dropping the oldest snapshot until we're safely under the size limit.
  while (payload.length > MAX_PAYLOAD_BYTES && DATASET.snapshots.length > 1) {
    DATASET.snapshots.shift();
    payload = JSON.stringify(DATASET);
  }
  try {
    await STORAGE_DRIVER.set(STORAGE_KEY, payload);
    return true;
  } catch (e) {
    console.error('storage save failed (attempt ' + attempt + ')', e);
    if (attempt < 3) {
      await new Promise(res => setTimeout(res, attempt * 700));
      return saveDataset(attempt + 1, silent);
    }
    if (silent) return false; // visitors with blocked storage must never see an error
    toast('Não foi possível salvar neste navegador. Baixe um backup (botão "Atualizar dados" → Baixar backup) para não perder o que já foi registrado, e tente novamente em instantes.');
    return false;
  }
}

// Batches rapid, successive edits (e.g. filling out several causas one after another)
// into a single storage write instead of firing one request per field change.
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveDataset(); }, 500);
}

/* ---------------- Init ---------------- */
function showStandaloneNotice() {
  const el = document.getElementById('standalone-notice');
  if (!el) return;
  el.style.display = 'flex';
  const dismiss = document.getElementById('btn-dismiss-standalone-notice');
  if (dismiss) dismiss.onclick = () => { el.style.display = 'none'; };
}

// Loads the published dataset (dados.json). Returns null when the file is absent,
// unreadable or empty, so the app silently falls back to local data / the seed.
async function fetchPublished() {
  if (!IS_STANDALONE) return null; // inside Claude the shared window.storage is used instead
  try {
    const res = await fetch('dados.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && Array.isArray(data.snapshots) && data.snapshots.length) {
      return { publishedAt: Number(data.publishedAt) || 0, snapshots: data.snapshots };
    }
  } catch (e) { /* no published data available */ }
  return null;
}

// "How new is this local copy?" — explicit savedAt when the person changed something,
// otherwise the timestamp of its most recent snapshot (covers data saved by older builds).
function datasetFreshness(ds) {
  if (!ds) return 0;
  if (ds.savedAt) return Number(ds.savedAt) || 0;
  let t = 0;
  (ds.snapshots || []).forEach(sn => { const v = Date.parse(sn.timestamp); if (!isNaN(v) && v > t) t = v; });
  return t;
}

async function init() {
  const seedRaw = JSON.parse(document.getElementById('seed-data').textContent);
  let seedDataset;
  if (seedRaw && Array.isArray(seedRaw.snapshots)) {
    // full dataset embedded (produced by "Baixar site atualizado para publicar")
    seedDataset = seedRaw;
  } else {
    // legacy format: a flat rows array for a single initial month
    seedDataset = {
      snapshots: [{
        id: 'seed',
        month: window.__SEED_MONTH__ || 'Agosto',
        timestamp: window.__SEED_TIMESTAMP__ || nowStamp(),
        uploader: 'Carga inicial (template)',
        rows: Array.isArray(seedRaw) ? seedRaw : []
      }]
    };
  }

  // Data source priority (this is what makes a shared link show real numbers):
  //  1) dados.json published next to index.html  -> what EVERY visitor sees
  //  2) the local working copy, only if it holds changes newer than what was published
  //     (the person who updates the data, before publishing again)
  //  3) the seed embedded in index.html (empty template)
  const [local, published] = await Promise.all([loadDataset(), fetchPublished()]);
  if (published && (!local || published.publishedAt >= datasetFreshness(local))) {
    DATASET = { snapshots: published.snapshots };
    await saveDataset(1, true);
  } else if (local) {
    DATASET = local;
  } else {
    DATASET = seedDataset;
    await saveDataset(1, true);
  }

  const ordered = monthsAvailable();
  STATE.month = ordered.length ? ordered[ordered.length - 1] : DATASET.snapshots[DATASET.snapshots.length - 1].month;
  bindEvents();
  renderAll();
  // Notice intentionally no longer shown automatically — the redeploy-to-update
  // workflow ("Baixar site atualizado") is the mechanism now; the popup was noise.
}

/* ---------------- Derived data helpers ---------------- */
const MONTH_PREFIX_ORDER = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_CANONICAL_NAME = {
  jan: 'Janeiro', fev: 'Fevereiro', mar: 'Março', abr: 'Abril', mai: 'Maio',
  jun: 'Junho', jul: 'Julho', ago: 'Agosto', set: 'Setembro', out: 'Outubro',
  nov: 'Novembro', dez: 'Dezembro'
};
// Fixes typos in the month name coming from the spreadsheet header (e.g. "Fevereriro")
// so the correct spelling always shows in pills, charts, and history — regardless of
// how the column was actually typed that week.
function canonicalMonthName(m) {
  const prefix = String(m || '').trim().toLowerCase().slice(0, 3);
  return MONTH_CANONICAL_NAME[prefix] || m;
}
function monthOrderIndex(m) {
  const prefix = String(m || '').trim().toLowerCase().slice(0, 3);
  const idx = MONTH_PREFIX_ORDER.indexOf(prefix);
  return idx === -1 ? 99 : idx;
}
function monthsAvailable() {
  const seen = [];
  DATASET.snapshots.forEach(s => { const cm = canonicalMonthName(s.month); if (!seen.includes(cm)) seen.push(cm); });
  seen.sort((a, b) => monthOrderIndex(a) - monthOrderIndex(b));
  return seen;
}
function latestSnapshotForMonth(month) {
  const target = canonicalMonthName(month);
  const list = DATASET.snapshots.filter(s => canonicalMonthName(s.month) === target);
  return list.length ? list[list.length - 1] : null;
}
function currentSnapshot() {
  return latestSnapshotForMonth(STATE.month) || DATASET.snapshots[DATASET.snapshots.length - 1];
}
function techsAvailable(rows) {
  const seen = [];
  rows.forEach(r => { if (r.tecnologia && !seen.includes(r.tecnologia)) seen.push(r.tecnologia); });
  return seen.sort();
}
function filteredRows() {
  const snap = currentSnapshot();
  if (!snap) return [];
  return snap.rows.filter(r => {
    if (STATE.plant !== 'TODAS' && r.centro !== STATE.plant) return false;
    if (STATE.tech && r.tecnologia !== STATE.tech) return false;
    return true;
  });
}

/* weighted MP attendance for a set of rows
   - pctModelos: % of the models THAT HAVE A PRODUCTION PLAN this month (countScored)
     which have 100% of the MP available — this is the number that drives the farol.
   - paresRisco: % of the total production volume (pares) that is exposed to shortage
   - paresCobertura: inverse of paresRisco, % of volume covered
   NOTE: Comum / Especifica-Não critica rows are auto-100% by business rule (percentual=1)
   regardless of their raw estoque number, so both metrics respect the effective
   percentual per row rather than the raw stock figure. */
function mpAttendance(rows) {
  let countTotal = 0, countBelow = 0, countScored = 0;
  let sumPlan = 0, sumCovered = 0;
  rows.forEach(r => {
    countTotal++;
    const p = (r.percentual === null || r.percentual === undefined) ? computePercentual(r) : r.percentual;
    const hasPlan = r.previaAgosto && r.previaAgosto > 0;
    if (hasPlan) {
      countScored++;
      sumPlan += r.previaAgosto;
      const effP = (p === null) ? 0 : Math.min(p, 1);
      sumCovered += r.previaAgosto * effP;
      if (p === null || p < 0.9995) countBelow++;
    }
  });
  const pctModelos = countScored > 0 ? (countScored - countBelow) / countScored : null;
  const paresRisco = sumPlan > 0 ? (1 - sumCovered / sumPlan) : null;
  const paresCobertura = sumPlan > 0 ? (sumCovered / sumPlan) : null;
  return { pctModelos, countTotal, countBelow, countScored, paresRisco, paresCobertura, sumPlan, sumCovered };
}
function rupturaStats(rows) {
  let reviewed = 0, sim = 0;
  rows.forEach(r => {
    if (r.ruptura === 'Sim' || r.ruptura === 'Não') {
      reviewed++;
      if (r.ruptura === 'Sim') sim++;
    }
  });
  // binary compliance with the "zero rupturas" goal: any occurrence at all -> 0%/red,
  // otherwise 100%/green. No partial/yellow state for this indicator.
  const pct = sim > 0 ? 0 : 1;
  return { pct, reviewed, sim };
}

/* ---------------- Rendering ---------------- */
function renderAll() {
  const steps = [renderLastUpdate, renderFilters, renderKPIs, renderPlantGrid, renderMPTable, renderRupturaPanel, renderChart, renderRupturaChart, renderHistory, renderVolumeCard];
  steps.forEach(fn => {
    try { fn(); } catch (e) { console.error(fn.name, e); }
  });
}

function renderLastUpdate() {
  const snaps = DATASET.snapshots;
  const last = snaps[snaps.length - 1];
  document.getElementById('last-update').innerHTML =
    `Última atualização: <b>${fmtStamp(last.timestamp)}</b> &middot; ${last.uploader || 'PCP'}`;
  const statsEl = document.getElementById('stats-tech-count');
  if (statsEl) statsEl.textContent = techsAvailable(last.rows).length;
}

function renderPlantPills(containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = '';
  ['TODAS', ...PLANTS].forEach(p => {
    const el = document.createElement('div');
    el.className = 'pill' + (p === STATE.plant ? ' active' : '');
    el.textContent = p === 'TODAS' ? 'Todas' : p;
    el.onclick = () => { STATE.plant = p; renderAll(); };
    wrap.appendChild(el);
  });
}

function renderFilters() {
  const monthWrap = document.getElementById('month-pills');
  monthWrap.innerHTML = '';
  monthsAvailable().forEach(m => {
    const el = document.createElement('div');
    el.className = 'pill' + (m === STATE.month ? ' active' : '');
    el.textContent = m;
    el.onclick = () => { STATE.month = m; renderAll(); };
    monthWrap.appendChild(el);
  });

  renderPlantPills('plant-pills');
  renderPlantPills('mp-plant-pills');
  renderPlantPills('rup-plant-pills');

  const techSel = document.getElementById('tech-select');
  const snap = currentSnapshot();
  const rowsForTech = snap ? snap.rows.filter(r => STATE.plant === 'TODAS' || r.centro === STATE.plant) : [];
  const techs = techsAvailable(rowsForTech);
  const prevVal = STATE.tech;
  techSel.innerHTML = '<option value="">Todas</option>' + techs.map(t => `<option value="${t}">${t}</option>`).join('');
  if (techs.includes(prevVal)) techSel.value = prevVal; else { techSel.value = ''; STATE.tech = ''; }
}

function setLamps(containerId, color) {
  const c = document.getElementById(containerId);
  c.querySelectorAll('.lamp').forEach(l => l.className = 'lamp');
  if (color === 'gray') return;
  const lamp = c.querySelector(`.lamp[data-l="${color}"]`);
  if (lamp) lamp.classList.add('on-' + color);
}

function renderKPIs() {
  const rows = filteredRows();
  const mp = overallMpForScope();
  const rup = rupturaStats(rows);

  document.getElementById('kpi-mp-value').textContent = mp.pctModelos === null ? '—' : fmtPct(mp.pctModelos);
  setLamps('sem-mp', farolFromPct(mp.pctModelos));
  document.getElementById('kpi-mp-skus').innerHTML = mp.isAverage
    ? `média simples de <b>${mp.plantCount}</b> fábricas`
    : (mp.countBelow > 0
        ? `<b>${mp.countBelow}</b> de ${mp.countScored} modelos com plano abaixo de 100%`
        : `<b>${mp.countScored}</b> modelos com plano, todos atendidos`);

  const rupColor = rup.sim === 0 ? 'green' : 'red';
  document.getElementById('kpi-rup-value').textContent = fmtPct(rup.pct);
  setLamps('sem-rup', rupColor);
  document.getElementById('kpi-rup-skus').innerHTML = rup.reviewed > 0
    ? `<b>${rup.sim}</b> com ruptura de ${rup.reviewed} apontados`
    : 'nenhum apontamento nesta semana';

  // trend vs previous snapshot in same month/plant/tech scope
  renderTrendBadge('kpi-mp-trend', mp.pctModelos, 'mp');
  renderTrendBadge('kpi-rup-trend', rup.pct, 'rup');
}

// When "Todas" fábricas is selected, the headline MP number is a SIMPLE AVERAGE of
// each of the 4 plants' own attendance % — not a pooled count across every row.
// A pooled count would let whichever plant has the most SKUs this week dominate the
// number; a simple average gives each fábrica equal weight, which is what's expected
// here. When a single plant is selected, this is just that plant's own value.
function overallMpForScope() {
  if (STATE.plant !== 'TODAS') {
    return { ...mpAttendance(filteredRows()), isAverage: false };
  }
  const snap = currentSnapshot();
  const perPlant = PLANTS.map(p => {
    const rows = snap ? snap.rows.filter(r => r.centro === p && (!STATE.tech || r.tecnologia === STATE.tech)) : [];
    return mpAttendance(rows).pctModelos;
  }).filter(v => v !== null);
  const pctModelos = perPlant.length ? perPlant.reduce((a, b) => a + b, 0) / perPlant.length : null;
  return { pctModelos, isAverage: true, plantCount: perPlant.length };
}

function previousComparableSnapshot() {
  const months = monthsAvailable();
  const idx = months.indexOf(STATE.month);
  if (idx <= 0) return null;
  return latestSnapshotForMonth(months[idx - 1]);
}
function renderTrendBadge(elId, currentVal, kind) {
  const el = document.getElementById(elId);
  const prevSnap = previousComparableSnapshot();
  if (!prevSnap || currentVal === null) { el.innerHTML = ''; return; }
  let prevVal;
  if (kind === 'mp' && STATE.plant === 'TODAS') {
    const perPlant = PLANTS.map(p => {
      const rows = prevSnap.rows.filter(r => r.centro === p && (!STATE.tech || r.tecnologia === STATE.tech));
      return mpAttendance(rows).pctModelos;
    }).filter(v => v !== null);
    prevVal = perPlant.length ? perPlant.reduce((a, b) => a + b, 0) / perPlant.length : null;
  } else {
    const rows = prevSnap.rows.filter(r => (STATE.plant === 'TODAS' || r.centro === STATE.plant) && (!STATE.tech || r.tecnologia === STATE.tech));
    prevVal = kind === 'mp' ? mpAttendance(rows).pctModelos : rupturaStats(rows).pct;
  }
  if (prevVal === null) { el.innerHTML = ''; return; }
  const diff = (currentVal - prevVal) * 100;
  const better = kind === 'mp' ? diff >= 0 : diff <= 0;
  const cls = Math.abs(diff) < 0.05 ? 'flat' : (better ? 'up' : 'down');
  const arrow = Math.abs(diff) < 0.05 ? '→' : (diff > 0 ? '↑' : '↓');
  el.innerHTML = `<span class="trend ${cls}">${arrow} ${Math.abs(diff).toFixed(1)} p.p. vs mês anterior</span>`;
}

function renderPlantGrid() {
  const grid = document.getElementById('plant-grid');
  grid.innerHTML = '';
  const snap = currentSnapshot();
  const computed = PLANTS.map(p => {
    const rows = snap ? snap.rows.filter(r => r.centro === p && (!STATE.tech || r.tecnologia === STATE.tech)) : [];
    return { p, mp: mpAttendance(rows), rup: rupturaStats(rows) };
  });
  computed.sort((a, b) => {
    const av = a.mp.pctModelos === null ? -1 : a.mp.pctModelos;
    const bv = b.mp.pctModelos === null ? -1 : b.mp.pctModelos;
    return bv - av;
  });
  computed.forEach(({ p, mp, rup }) => {
    const mpColor = farolFromPct(mp.pctModelos);
    const rupColor = rup.sim === 0 ? 'green' : 'red';
    const dotCls = c => c === 'green' ? 'g' : c === 'yellow' ? 'y' : c === 'red' ? 'r' : '';
    const card = document.createElement('div');
    card.className = 'plant-card' + (STATE.plant === p ? ' active' : '');
    card.innerHTML = `
      <div class="plant-card-top">
        <span class="plant-code">${p}</span>
        <span class="mini-dots"><span class="dot ${dotCls(mpColor)}"></span><span class="dot ${dotCls(rupColor)}"></span></span>
      </div>
      <div class="plant-metric-row"><span class="lbl">Disponibilidade MP (modelos)</span><span class="val">${mp.pctModelos === null ? '—' : fmtPct(mp.pctModelos) + '%'}</span></div>
      <div class="plant-metric-row"><span class="lbl">Ruptura</span><span class="val ${rup.sim > 0 ? 'val-danger' : ''}">${rup.sim}</span></div>`;
    card.onclick = () => { STATE.plant = (STATE.plant === p ? 'TODAS' : p); renderAll(); };
    grid.appendChild(card);
  });
}

function renderMPTable() {
  const rows = filteredRows();
  const byTech = {};
  rows.forEach(r => {
    if (!r.tecnologia) return;
    (byTech[r.tecnologia] = byTech[r.tecnologia] || []).push(r);
  });
  const techNames = Object.keys(byTech).sort();
  document.getElementById('mp-count-badge').textContent = `${techNames.length} tecnologias`;

  const tbody = document.getElementById('mp-table-body');
  tbody.innerHTML = '';
  if (!techNames.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-note">Nenhum dado para os filtros selecionados.</td></tr>';
    return;
  }

  techNames.forEach(tech => {
    const techRows = byTech[tech];
    const agg = mpAttendance(techRows);
    const color = farolFromPct(agg.pctModelos);
    const plantsHere = [...new Set(techRows.map(r => r.centro))].join(', ');
    const isOpen = OPEN_TECHS.has(tech);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="tech-name"><span class="caret ${isOpen ? 'open' : ''}"></span>${tech}</span></td>
      <td>${plantsHere}</td>
      <td class="pct-cell">${agg.pctModelos === null ? '—' : fmtPct(agg.pctModelos) + '%'}</td>
      <td><span class="status-chip ${color}"><span class="sdot"></span>${rowFarolLabel(color)}</span></td>
      <td>${agg.countBelow > 0 ? `${agg.countBelow} de ${agg.countScored} modelos abaixo de 100%` : `${agg.countScored} modelos atendidos`}</td>`;
    tr.querySelector('.tech-name').onclick = () => {
      if (OPEN_TECHS.has(tech)) OPEN_TECHS.delete(tech); else OPEN_TECHS.add(tech);
      renderMPTable();
    };
    tbody.appendChild(tr);

    if (isOpen) {
      const below = techRows.filter(r => {
        const p = (r.percentual === null || r.percentual === undefined) ? computePercentual(r) : r.percentual;
        return r.previaAgosto > 0 && (p === null || p < 0.9995);
      }).sort((a, b) => (a.percentual || 0) - (b.percentual || 0));

      if (!below.length) {
        const sr = document.createElement('tr');
        sr.className = 'subrow';
        sr.innerHTML = `<td colspan="5" style="color:var(--green);">Todos os modelos desta tecnologia com 100% de MP disponível.</td>`;
        tbody.appendChild(sr);
      } else {
        below.forEach(r => {
          const p = (r.percentual === null || r.percentual === undefined) ? computePercentual(r) : r.percentual;
          const c = rowFarolFromPct(p);
          const sr = document.createElement('tr');
          sr.className = 'subrow';
          sr.innerHTML = `
            <td><div class="model-name"><span class="mm">${r.modelo} · cor ${r.cor}</span><span class="dd">${r.descricao || ''}</span></div></td>
            <td>${r.centro}</td>
            <td class="pct-cell">${fmtPct(p)}%</td>
            <td><span class="status-chip ${c}"><span class="sdot"></span>${rowFarolLabel(c)}</span></td>
            <td>${Math.round(r.estoqueInicial || 0).toLocaleString('pt-BR')} / ${Math.round(r.previaAgosto || 0).toLocaleString('pt-BR')} pares</td>`;
          tbody.appendChild(sr);
        });
      }
    }
  });
}

function renderRupturaPanel() {
  const rows = filteredRows();
  const marked = rows.filter(r => r.ruptura === 'Sim');
  document.getElementById('rup-count-badge').textContent = `${marked.length} com ruptura`;

  const tbody = document.getElementById('rup-table-body');
  tbody.innerHTML = '';

  if (!marked.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Nenhuma ruptura registrada para os filtros atuais. Use "+ Registrar ruptura" abaixo da tabela para apontar um bloqueio.</td></tr>';
  } else {
    marked.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'ruptura-row';
      tr.innerHTML = `
        <td><div class="model-name"><span class="mm">${r.modelo} · cor ${r.cor}</span><span class="dd">${r.descricao || ''}</span></div></td>
        <td>${r.centro}</td>
        <td>${r.tecnologia || '—'}</td>
        <td><button class="toggle-btn is-yes" data-key="${r.chave}">Sim</button></td>
        <td><select class="causa-select" data-key="${r.chave}">${CAUSAS.map(c => `<option value="${c}" ${c === r.causa ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
        <td><input type="date" class="date-input" data-key="${r.chave}" value="${r.dataOcorrencia || ''}"></td>`;
      tbody.appendChild(tr);
    });
  }

  // add-row control
  const addRow = document.createElement('tr');
  addRow.innerHTML = `<td colspan="6" style="padding:14px 20px;">
    <button class="btn ghost" id="btn-add-ruptura" style="font-size:12.5px;padding:8px 14px;">+ Registrar ruptura</button>
  </td>`;
  tbody.appendChild(addRow);

  tbody.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.onclick = () => setRuptura(btn.dataset.key, 'Não');
  });
  tbody.querySelectorAll('.causa-select').forEach(sel => {
    sel.onchange = () => setCausa(sel.dataset.key, sel.value);
  });
  tbody.querySelectorAll('.date-input').forEach(inp => {
    inp.onchange = () => setDataOcorrencia(inp.dataset.key, inp.value);
  });
  const addBtn = document.getElementById('btn-add-ruptura');
  if (addBtn) addBtn.onclick = openAddRupturaPicker;
}

function setRuptura(chave, value) {
  const snap = currentSnapshot();
  const row = snap.rows.find(r => r.chave === chave);
  if (!row) return;
  row.ruptura = value;
  if (value !== 'Sim') row.causa = row.causa || null;
  scheduleSave();
  renderKPIs(); renderPlantGrid(); renderRupturaPanel(); renderRupturaChart();
  toast(value === 'Sim' ? 'Ruptura registrada.' : 'Ruptura removida.');
}
function setCausa(chave, causa) {
  const snap = currentSnapshot();
  const row = snap.rows.find(r => r.chave === chave);
  if (!row) return;
  row.causa = causa;
  scheduleSave();
  toast('Causa atualizada.');
}

function setDataOcorrencia(chave, data) {
  const snap = currentSnapshot();
  const row = snap.rows.find(r => r.chave === chave);
  if (!row) return;
  row.dataOcorrencia = data || null;
  scheduleSave();
  renderRupturaChart();
  toast('Data da ocorrência atualizada.');
}

async function openAddRupturaPicker() {
  const snap = currentSnapshot();
  // search across ALL plants — a model like "Brasil" can be produced in more than one
  // fábrica, so the picker must not be restricted to the currently selected plant filter.
  const options = snap.rows
    .filter(r => (!STATE.tech || r.tecnologia === STATE.tech) && r.ruptura !== 'Sim')
    .slice(0, 4000);
  const search = prompt('Digite o modelo (ou parte da descrição) para registrar a ruptura — busca em todas as fábricas:');
  if (!search) return;
  const term = search.trim().toLowerCase();
  const rawMatches = options.filter(r =>
    String(r.modelo).includes(term) ||
    (r.descricao || '').toLowerCase().includes(term) ||
    String(r.chave).toLowerCase().includes(term)
  );
  // Interleave round-robin by plant so a term matching many SKUs in one fábrica
  // doesn't crowd out matches from other fábricas that also produce the model.
  const byPlant = {};
  PLANTS.forEach(p => { byPlant[p] = rawMatches.filter(r => r.centro === p); });
  const matches = [];
  let more = true;
  while (more && matches.length < 40) {
    more = false;
    for (const p of PLANTS) {
      if (byPlant[p].length) { matches.push(byPlant[p].shift()); more = true; }
      if (matches.length >= 40) break;
    }
  }
  if (!matches.length) { toast('Nenhum modelo encontrado com esse termo.'); return; }
  const list = matches.map((r, i) => `${i + 1}. [${r.centro}] ${r.modelo} cor ${r.cor} — ${r.descricao || ''} (${r.tecnologia || ''})`).join('\n');
  const pick = prompt(`Modelos encontrados em todas as fábricas — digite o número:\n${list}`);
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || !matches[idx]) return;
  const causa = prompt(`Causa da ruptura para ${matches[idx].modelo} (${CAUSAS.join(', ')}):`, CAUSAS[0]);
  const causaFinal = CAUSAS.includes(causa) ? causa : CAUSAS[0];
  const todayStr = new Date().toISOString().slice(0, 10);
  const dataInput = prompt('Data da ocorrência (AAAA-MM-DD):', todayStr);
  const dataFinal = /^\d{4}-\d{2}-\d{2}$/.test(dataInput || '') ? dataInput : todayStr;
  matches[idx].ruptura = 'Sim';
  matches[idx].causa = causaFinal;
  matches[idx].dataOcorrencia = dataFinal;
  const ok = await saveDataset();
  renderAll();
  if (ok) toast('Ruptura registrada. Para todos verem, baixe o dados.json e publique de novo.');
}

/* ---------------- Chart ---------------- */
// Draws the numeric value above each point, since this chart gets screenshotted for
// email — recipients can't hover to see a tooltip, so the label has to be visible.
const valueLabelPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((ds, dsIndex) => {
      if (ds.hideLabels) return;
      const meta = chart.getDatasetMeta(dsIndex);
      if (meta.hidden) return;
      meta.data.forEach((point, i) => {
        const val = ds.data[i];
        if (val === null || val === undefined) return;
        ctx.save();
        ctx.fillStyle = ds.pointBackgroundColor || ds.borderColor || '#12172a';
        ctx.font = '700 11px IBM Plex Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(val.toFixed(1) + '%', point.x, point.y - 10);
        ctx.restore();
      });
    });
  }
};
let chartInstance = null;
function renderChart() {
  if (typeof Chart === 'undefined') {
    const wrap = document.querySelector('.chart-wrap');
    if (wrap) wrap.innerHTML = '<div class="empty-note">Gráfico indisponível no momento (biblioteca de gráficos não carregou). Os demais dados continuam atualizados normalmente.</div>';
    return;
  }
  const months = monthsAvailable();
  document.getElementById('chart-scope-label').textContent =
    (STATE.plant === 'TODAS' ? 'todas as fábricas' : STATE.plant) + (STATE.tech ? ' · ' + STATE.tech : '');

  const labels = [];
  const mpSeries = [];
  months.forEach(m => {
    const snap = latestSnapshotForMonth(m);
    let pct;
    if (STATE.plant === 'TODAS') {
      const perPlant = PLANTS.map(p => {
        const rows = snap.rows.filter(r => r.centro === p && (!STATE.tech || r.tecnologia === STATE.tech));
        return mpAttendance(rows).pctModelos;
      }).filter(v => v !== null);
      pct = perPlant.length ? perPlant.reduce((a, b) => a + b, 0) / perPlant.length : null;
    } else {
      const rows = snap.rows.filter(r => r.centro === STATE.plant && (!STATE.tech || r.tecnologia === STATE.tech));
      pct = mpAttendance(rows).pctModelos;
    }
    labels.push(m);
    mpSeries.push(pct === null ? null : Math.round(pct * 1000) / 10);
  });

  const accMP = mpSeries.filter(v => v !== null);
  const accMPavg = accMP.length ? (accMP.reduce((a, b) => a + b, 0) / accMP.length) : null;
  labels.push('Acumulado ano');
  mpSeries.push(accMPavg === null ? null : Math.round(accMPavg * 10) / 10);

  const ctx = document.getElementById('trend-chart').getContext('2d');
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Disponibilidade de MP (%)',
          data: mpSeries,
          borderColor: '#16a34a',
          backgroundColor: 'rgba(22,163,74,0.10)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: '#16a34a',
          spanGaps: true
        },
        {
          label: 'Meta MP (100%)',
          data: labels.map(() => 100),
          borderColor: '#98a2b3',
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
          hideLabels: true
        }
      ]
    },
    plugins: [valueLabelPlugin],
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#475467', font: { family: 'IBM Plex Mono', size: 11 } } },
        tooltip: { backgroundColor: '#ffffff', borderColor: '#e3e7ee', borderWidth: 1, titleColor: '#12172a', bodyColor: '#12172a' }
      },
      scales: {
        y: { min: 0, max: 110, grid: { color: '#edf0f4' }, ticks: { color: '#667085', callback: v => v + '%' } },
        x: { grid: { display: false }, ticks: { color: '#667085', font: { family: 'IBM Plex Mono', size: 11 } } }
      }
    }
  });
}

/* ---------------- Ruptura occurrences chart (day x plant x count) ---------------- */
const MONTH_DAYS_PT = {
  'janeiro': 31, 'fevereiro': 28, 'março': 31, 'marco': 31, 'abril': 30, 'maio': 31,
  'junho': 30, 'julho': 31, 'agosto': 31, 'setembro': 30, 'outubro': 31,
  'novembro': 30, 'dezembro': 31
};
function daysInMonthPT(monthLabel) {
  const key = String(monthLabel || '').trim().toLowerCase();
  return MONTH_DAYS_PT[key] || 31;
}

let rupturaChartInstance = null;
function renderRupturaChart() {
  const label = document.getElementById('rup-chart-scope-label');
  if (label) label.textContent = STATE.month + (STATE.tech ? ' · ' + STATE.tech : '') + ' · todas as fábricas';

  if (typeof Chart === 'undefined') {
    const wraps = document.querySelectorAll('.chart-wrap');
    const wrap = wraps[wraps.length - 1];
    if (wrap) wrap.innerHTML = '<div class="empty-note">Gráfico indisponível no momento (biblioteca de gráficos não carregou).</div>';
    return;
  }

  const snap = currentSnapshot();
  const daysInMonth = daysInMonthPT(STATE.month);
  const colors = { A022: '#3159e3', A026: '#16a34a', A055: '#d97706', A133: '#dc2626' };

  // group occurrences by (day, plant) so each bubble can carry the full cause breakdown
  const cells = {}; // key `${day}-${plant}` -> { day, plant, causas: {causa: count}, total }
  if (snap) {
    // Deliberately ignores the plant filter — the whole point of this chart is to
    // compare which fábrica each occurrence happened in, side by side, per day.
    snap.rows
      .filter(r => r.ruptura === 'Sim' && r.dataOcorrencia && (!STATE.tech || r.tecnologia === STATE.tech) && PLANTS.includes(r.centro))
      .forEach(r => {
        const day = parseInt(String(r.dataOcorrencia).slice(8, 10), 10);
        if (day < 1 || day > daysInMonth) return;
        const key = `${day}-${r.centro}`;
        if (!cells[key]) cells[key] = { day, plant: r.centro, causas: {}, total: 0 };
        const causa = r.causa || 'Não informada';
        cells[key].causas[causa] = (cells[key].causas[causa] || 0) + 1;
        cells[key].total++;
      });
  }

  const datasets = PLANTS.map((p, plantIdx) => {
    const points = Object.values(cells).filter(c => c.plant === p).map(c => ({
      x: c.day,
      y: plantIdx,
      r: Math.min(8 + c.total * 4, 26),
      total: c.total,
      causas: c.causas
    }));
    return {
      label: p,
      data: points,
      backgroundColor: colors[p] + 'b3',
      borderColor: colors[p],
      borderWidth: 1.5
    };
  });

  const canvas = document.getElementById('ruptura-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (rupturaChartInstance) rupturaChartInstance.destroy();
  rupturaChartInstance = new Chart(ctx, {
    type: 'bubble',
    data: { datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#475467', font: { family: 'IBM Plex Mono', size: 11 } } },
        tooltip: {
          backgroundColor: '#ffffff', borderColor: '#e3e7ee', borderWidth: 1,
          titleColor: '#12172a', bodyColor: '#12172a', bodyFont: { family: 'IBM Plex Mono', size: 11 },
          callbacks: {
            title: (items) => {
              const d = items[0].raw;
              return `${PLANTS[Math.round(d.y)]} · dia ${d.x}`;
            },
            label: (item) => {
              const d = item.raw;
              const causasTxt = Object.entries(d.causas).map(([causa, n]) => `${causa} ×${n}`);
              return [`${d.total} ocorrência${d.total > 1 ? 's' : ''}`, ...causasTxt];
            }
          }
        }
      },
      scales: {
        y: {
          min: -0.5, max: PLANTS.length - 0.5,
          ticks: {
            stepSize: 1, color: '#667085', font: { family: 'IBM Plex Mono', size: 11 },
            callback: (v) => PLANTS[v] || ''
          },
          grid: { color: '#edf0f4' },
          title: { display: true, text: 'Fábrica', color: '#667085', font: { family: 'IBM Plex Mono', size: 11 } }
        },
        x: {
          min: 0.5, max: daysInMonth + 0.5,
          afterBuildTicks: (axis) => {
            axis.ticks = Array.from({ length: daysInMonth }, (_, i) => ({ value: i + 1 }));
          },
          ticks: { color: '#667085', font: { family: 'IBM Plex Mono', size: 10 } },
          grid: { color: '#f5f6f8' },
          title: { display: true, text: 'Dia do mês', color: '#667085', font: { family: 'IBM Plex Mono', size: 11 } }
        }
      }
    }
  });
}

/* ---------------- Volume de Produção card ---------------- */
function renderVolumeCard() {
  const snap = currentSnapshot();
  const totalEl = document.getElementById('kpi-vol-total');
  if (!snap || !totalEl) return;

  // Grand total is computed from EVERY row in the snapshot, not just the sum of the
  // 4 known plants — this guarantees it always matches the source spreadsheet's own
  // totals even if a row has an unexpected/mistyped centro value.
  const totalPlan = snap.rows.reduce((a, r) => a + (r.previaAgosto || 0), 0);
  const totalGap = snap.rows.reduce((a, r) => a + (r.paresSemana01 || 0), 0);
  const pct = totalPlan > 0 ? (totalPlan - totalGap) / totalPlan : null;

  const perPlant = PLANTS.map(p => {
    const rows = snap.rows.filter(r => r.centro === p);
    const plan = rows.reduce((a, r) => a + (r.previaAgosto || 0), 0);
    const gap = rows.reduce((a, r) => a + (r.paresSemana01 || 0), 0);
    return { p, plan, gap };
  }).sort((a, b) => b.plan - a.plan);

  totalEl.innerHTML = `${fmtInt(totalPlan)}<span class="unit"> pares</span>`;
  document.getElementById('kpi-vol-gap').textContent = `${fmtInt(totalGap)} pares indisponíveis em estoque`;
  document.getElementById('kpi-vol-pct').textContent = pct === null ? '— atendido' : `${fmtPct(pct)}% atendido`;

  const bd = document.getElementById('volume-breakdown');
  if (!bd) return;
  bd.innerHTML = '';
  perPlant.forEach(x => {
    const pctP = x.plan > 0 ? (x.plan - x.gap) / x.plan : null;
    const row = document.createElement('div');
    row.className = 'volume-row';
    row.innerHTML = `
      <span class="vp-name">${x.p} <span class="vp-count">(${fmtInt(x.plan)})</span></span>
      <div class="vp-bar-wrap"><div class="vp-bar" style="width:${pctP === null ? 0 : Math.min(pctP * 100, 100)}%;background:${farolColorHex(pctP)}"></div></div>
      <span class="vp-pct">${pctP === null ? '—' : fmtPct(pctP) + '%'}</span>`;
    bd.appendChild(row);
  });
}

/* ---------------- History ---------------- */
function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  [...DATASET.snapshots].reverse().forEach(s => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `<span class="when">${fmtStamp(s.timestamp)}</span><span class="meta">${canonicalMonthName(s.month)} &middot; ${s.rows.length} modelos &middot; ${s.uploader || 'PCP'}</span>`;
    list.appendChild(div);
  });
}

/* ---------------- Upload / Update flow ---------------- */
function findHeaderRow(sheetRows) {
  for (let i = 0; i < Math.min(sheetRows.length, 10); i++) {
    const row = sheetRows[i] || [];
    if (row.some(c => String(c).trim() === 'Centro')) return i;
  }
  return -1;
}
function colIndex(headerRow, matcher) {
  for (let i = 0; i < headerRow.length; i++) {
    const v = String(headerRow[i] || '').trim();
    if (matcher(v)) return i;
  }
  return -1;
}

// Excel cells are free text — "Sim", "sim", "SIM ", etc. must all count the same way.
// A strict === 'Sim' comparison elsewhere in the app was silently dropping any
// non-exact-case entry, which is why some ruptura rows were going missing.
function normalizeRuptura(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (['sim', 's', 'yes', 'y'].includes(s)) return 'Sim';
  if (['não', 'nao', 'n', 'no'].includes(s)) return 'Não';
  return null;
}

function parseDateCell(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];
    const br = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
    return null;
  }
  if (typeof v === 'number' && v > 0) {
    // Excel serial date fallback (days since 1899-12-30)
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  return null;
}

async function handleFile(file) {
  const statusEl = document.getElementById('upload-status');
  statusEl.className = 'upload-status';
  statusEl.textContent = 'Lendo arquivo…';
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('disponibilidade')) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

    const headerIdx = findHeaderRow(grid);
    if (headerIdx === -1) throw new Error('Não encontrei a linha de cabeçalho (coluna "Centro"). Verifique se a planilha segue o layout padrão.');
    const header = grid[headerIdx].map(h => String(h || '').trim());

    const idxChave = colIndex(header, v => v.startsWith('Chave'));
    const idxCentro = colIndex(header, v => v === 'Centro');
    const idxTec = colIndex(header, v => v === 'Tecnologia');
    const idxModelo = colIndex(header, v => v === 'Modelo');
    const idxDesc = colIndex(header, v => v.startsWith('Descrição Modelo'));
    const idxCor = colIndex(header, v => v === 'Cor');
    const idxColecao = colIndex(header, v => v === 'Coleção');
    const idxMptipo = colIndex(header, v => v.startsWith('MP Comum'));
    const idxEstoque = colIndex(header, v => v.startsWith('Estoque Inicial Previsto'));
    // The monthly target-plan column has been named "Previa <mês>" in some weekly
    // files and "Plano <mês>" in others — accept both, but never match the unrelated
    // "Plano de Produção" column (reject if the word right after is "de").
    const idxPrevia = colIndex(header, v => {
      const m = v.trim().match(/^(pr[eé]via|plano)\s+(\S+)/i);
      return !!m && m[2].toLowerCase() !== 'de';
    });
    const idxPercentual = colIndex(header, v => v.startsWith('Percentual MP'));
    const idxRuptura = colIndex(header, v => v.startsWith('Ruptura'));
    const idxCausa = colIndex(header, v => v === 'Causa');
    const idxParesSemana = colIndex(header, v => v.toLowerCase().startsWith('pares semana'));
    const idxDataOcorrencia = colIndex(header, v => v.toLowerCase().startsWith('data'));

    if (idxCentro === -1 || idxEstoque === -1 || idxPrevia === -1) {
      throw new Error('Colunas obrigatórias não encontradas (Centro, Estoque Inicial Previsto, Prévia do mês).');
    }

    let month = 'Mês';
    const previaHeaderText = header[idxPrevia] || '';
    const m = previaHeaderText.match(/(?:pr[eé]via|plano)\s+(\S+)/i);
    if (m) month = canonicalMonthName(m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase());

    const prevSnap = DATASET.snapshots[DATASET.snapshots.length - 1];
    const prevByChave = {};
    if (prevSnap) prevSnap.rows.forEach(r => { prevByChave[r.chave] = r; });

    const rows = [];
    for (let i = headerIdx + 1; i < grid.length; i++) {
      const r = grid[i];
      if (!r) continue;
      const centro = r[idxCentro];
      if (!centro) continue;
      const chave = idxChave > -1 ? r[idxChave] : `${centro}${r[idxModelo]}${r[idxCor]}`;
      const row = {
        chave: String(chave),
        centro: String(centro).trim().toUpperCase(),
        tecnologia: idxTec > -1 ? r[idxTec] : null,
        modelo: idxModelo > -1 ? r[idxModelo] : null,
        descricao: idxDesc > -1 ? r[idxDesc] : null,
        cor: idxCor > -1 ? r[idxCor] : null,
        colecao: idxColecao > -1 ? r[idxColecao] : null,
        mptipo: idxMptipo > -1 ? r[idxMptipo] : null,
        estoqueInicial: idxEstoque > -1 ? Number(r[idxEstoque]) || 0 : 0,
        previaAgosto: idxPrevia > -1 ? Number(r[idxPrevia]) || 0 : 0,
        percentual: null,
        ruptura: idxRuptura > -1 ? normalizeRuptura(r[idxRuptura]) : null,
        causa: idxCausa > -1 ? (r[idxCausa] || null) : null,
        paresSemana01: idxParesSemana > -1 ? (Number(r[idxParesSemana]) || 0) : 0,
        dataOcorrencia: idxDataOcorrencia > -1 ? parseDateCell(r[idxDataOcorrencia]) : null
      };
      row.percentual = (idxPercentual > -1 && typeof r[idxPercentual] === 'number') ? r[idxPercentual] : computePercentual(row);

      // The spreadsheet is now the source of truth for Ruptura/Causa/Data — a blank
      // "Ruptura?" cell means "no rupture this week", full stop. We do NOT carry the
      // previous week's "Sim" forward anymore, otherwise a resolved item stays stuck
      // as a rupture forever just because the cell was left blank instead of "Não".
      // The only thing we still backfill is causa/data when the file marks "Sim" but
      // simply forgot to fill those two specific cells that same week.
      if (row.ruptura === 'Sim' && prevByChave[row.chave]) {
        if (!row.causa && prevByChave[row.chave].causa) row.causa = prevByChave[row.chave].causa;
        if (!row.dataOcorrencia && prevByChave[row.chave].dataOcorrencia) row.dataOcorrencia = prevByChave[row.chave].dataOcorrencia;
      }
      // guard against duplicate "Chave" rows within the same file — keep the first
      // occurrence and skip the rest so a spreadsheet mistake never double-counts totals.
      if (rows.some(existing => existing.chave === row.chave)) continue;
      rows.push(row);
    }

    if (!rows.length) throw new Error('Nenhuma linha de dados foi encontrada abaixo do cabeçalho.');

    // week-over-week diff, purely informational — helps confirm the update looks right
    let diffMsg = '';
    if (prevSnap) {
      const newChaves = new Set(rows.map(r => r.chave));
      const oldChaves = new Set(prevSnap.rows.map(r => r.chave));
      const added = [...newChaves].filter(c => !oldChaves.has(c)).length;
      const removed = [...oldChaves].filter(c => !newChaves.has(c)).length;
      diffMsg = ` (${added} novos, ${removed} removidos vs. última carga de ${prevSnap.rows.length})`;
    }

    const uploaderName = document.getElementById('uploader-name').value.trim();
    const snapshot = {
      id: 'snap-' + Date.now(),
      month,
      timestamp: nowStamp(),
      uploader: uploaderName || 'PCP',
      rows
    };
    DATASET.snapshots.push(snapshot);
    await saveDataset();

    statusEl.className = 'upload-status ok';
    statusEl.textContent = `Pronto! ${rows.length} modelos carregados para ${month}${diffMsg}.`;
    STATE.month = month;
    renderAll();
    toast('Dados atualizados com sucesso.');
    const cta = document.getElementById('post-upload-cta');
    if (cta) {
      cta.style.display = 'block';
      cta.innerHTML = `
        <div style="background:#eef4ff;border:1px solid #c2cef8;border-radius:10px;padding:12px 14px;">
          <p style="margin:0 0 8px;font-size:12.5px;color:#1e3a8a;line-height:1.5;">
            <b>Falta um passo:</b> pra quem receber o link enxergar esses dados, baixe o dados.json, coloque na pasta do site e publique a pasta de novo.
          </p>
          <button class="btn primary" id="btn-cta-export-site" style="font-size:12.5px;padding:8px 14px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 15V3m0 0L7 8m5-5l5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
            Baixar dados.json agora
          </button>
        </div>`;
      const ctaBtn = document.getElementById('btn-cta-export-site');
      if (ctaBtn) ctaBtn.onclick = exportPublishedData;
    }
  } catch (err) {
    console.error(err);
    statusEl.className = 'upload-status err';
    statusEl.textContent = 'Erro: ' + err.message;
  }
}

/* ---------------- Modal / events ---------------- */
function openModal() {
  document.getElementById('modal').classList.add('show');
  document.getElementById('upload-status').textContent = '';
  document.getElementById('upload-status').className = 'upload-status';
  const cta = document.getElementById('post-upload-cta');
  if (cta) { cta.style.display = 'none'; cta.innerHTML = ''; }
}
function closeModal() {
  document.getElementById('modal').classList.remove('show');
}

function bindEvents() {
  document.getElementById('btn-update').onclick = openModal;
  document.getElementById('btn-cancel-modal').onclick = closeModal;
  document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  const dz = document.getElementById('dropzone');
  const fi = document.getElementById('file-input');
  dz.onclick = () => fi.click();
  fi.onchange = () => { if (fi.files[0]) handleFile(fi.files[0]); };
  ['dragenter', 'dragover'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  document.getElementById('btn-mobile').onclick = () => {
    const app = document.getElementById('app');
    app.classList.toggle('mobile-preview');
    const btn = document.getElementById('btn-mobile');
    const isMobile = app.classList.contains('mobile-preview');
    btn.innerHTML = isMobile
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="13" rx="1"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Versão PC'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg> Versão mobile';
  };
  document.getElementById('btn-share').onclick = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('Link copiado! Já pode colar no e-mail ou chat.');
    } catch (e) {
      toast('Não foi possível copiar automaticamente. Link: ' + window.location.href);
    }
  };
  document.getElementById('btn-pdf').onclick = () => {
    toast('Abrindo impressão — escolha "Salvar como PDF" no destino.');
    setTimeout(() => window.print(), 300);
  };
  document.getElementById('tech-select').onchange = (e) => { STATE.tech = e.target.value; renderAll(); };

  bindCollapseToggle('btn-toggle-mp-table', 'mp-table-wrap', 'tecnologias');
  bindCollapseToggle('btn-toggle-rup-table', 'rup-table-wrap', 'ocorrências', true);
  bindCollapseToggle('btn-toggle-history', 'history-list-wrap', 'histórico', true);

  document.getElementById('btn-export-site').onclick = exportPublishedData;
  document.getElementById('btn-export-backup').onclick = exportBackup;
  const backupInput = document.getElementById('backup-file-input');
  document.getElementById('btn-import-backup').onclick = () => backupInput.click();
  backupInput.onchange = () => { if (backupInput.files[0]) importBackup(backupInput.files[0]); };
}

// Downloads dados.json — the file that carries the data everyone sees. Put it in the
// site folder (next to index.html), replacing the old one, and publish the whole folder.
function exportPublishedData() {
  try {
    const payload = { publishedAt: Date.now(), snapshots: DATASET.snapshots };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dados.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('dados.json baixado! Coloque na pasta do site (junto do index.html) e publique a pasta inteira no Vercel.');
  } catch (e) {
    console.error(e);
    toast('Não foi possível gerar o dados.json.');
  }
}

function exportBackup() {
  try {
    const blob = new Blob([JSON.stringify(DATASET, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `backup-farol-mp-ruptura-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Backup baixado. Guarde este arquivo — ele restaura todos os apontamentos de ruptura.');
  } catch (e) {
    console.error(e);
    toast('Não foi possível gerar o backup.');
  }
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.snapshots) || !parsed.snapshots.length) {
      throw new Error('Arquivo de backup inválido — formato inesperado.');
    }
    DATASET = parsed;
    await saveDataset();
    STATE.month = DATASET.snapshots[DATASET.snapshots.length - 1].month;
    renderAll();
    toast('Backup restaurado com sucesso.');
  } catch (e) {
    console.error(e);
    toast('Erro ao restaurar backup: ' + e.message);
  }
}

function bindCollapseToggle(btnId, wrapId, noun, startCollapsed) {
  const btn = document.getElementById(btnId);
  const wrap = document.getElementById(wrapId);
  if (!btn || !wrap) return;
  const applyState = (hiddenNow) => {
    wrap.style.display = hiddenNow ? 'none' : '';
    btn.innerHTML = hiddenNow
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="6 9 12 15 18 9"/></svg> Mostrar ${noun}`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="18 15 12 9 6 15"/></svg> Ocultar ${noun}`;
  };
  if (startCollapsed) applyState(true);
  btn.onclick = () => {
    const hiddenNow = wrap.style.display !== 'none';
    applyState(hiddenNow);
  };
}

init();

