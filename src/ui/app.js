import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const MODEL_COLORS = [
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#6366f1',
];

const state = {
  data: null,
  quota: null,
  quotaLoading: false,
  loading: true,
  error: null,
  range: '30d',
  model: 'all',
  workspace: 'all',
  search: '',
  chartMode: 'split', // 'split' | 'model' | 'turns'
  sortBy: 'recent', // 'recent' | 'tokens' | 'cache' | 'turns'
  connected: false,
};

const app = new App({ name: 'Antigravity Usage Dashboard', version: '1.0.0' }, {});

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

function fmtExact(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

function fmtRelativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '—';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtResetCountdown(iso) {
  if (!iso) return '';
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return '';
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Refreshing soon';
  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${mins}m`;
  return `Resets in ${mins}m`;
}

function quotaFillColor(usedPct) {
  if (usedPct >= 85) return 'var(--c-danger)';
  if (usedPct >= 60) return 'var(--c-warn)';
  return 'var(--c-cache)';
}

function quotaBadgeClass(usedPct) {
  if (usedPct >= 85) return 'badge-low';
  if (usedPct >= 60) return 'badge-mid';
  return 'badge-good';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cacheBadgeClass(pct) {
  if (pct >= 70) return 'badge-good';
  if (pct >= 35) return 'badge-mid';
  return 'badge-low';
}

function getModelColorMap(models) {
  const map = new Map();
  (models || []).forEach((m, i) => {
    map.set(m.id || m.model, MODEL_COLORS[i % MODEL_COLORS.length]);
  });
  return map;
}

function applyTheme(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.dataset.theme = ctx.theme;
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

async function fetchUsage() {
  if (!state.connected) return;
  state.loading = true;
  state.error = null;
  render();
  try {
    const result = await app.callServerTool({
      name: 'get_usage_data',
      arguments: {
        range: state.range,
        model: state.model,
        workspace: state.workspace,
        search: state.search,
      },
    });
    if (result?.structuredContent) {
      state.data = result.structuredContent;
      if (state.data.quota && !state.quota) {
        state.quota = state.data.quota;
      }
      syncFiltersFromData(state.data);
    } else if (result?.isError) {
      state.error = result.content?.[0]?.text || 'Failed to load usage telemetry.';
    }
  } catch (err) {
    state.error = err?.message || 'Unable to refresh usage data.';
  } finally {
    state.loading = false;
    render();
  }
}

async function fetchLiveQuota() {
  if (!state.connected || state.quotaLoading) return;
  state.quotaLoading = true;
  render();
  try {
    const result = await app.callServerTool({
      name: 'get_live_quota',
      arguments: {},
    });
    if (result?.structuredContent) {
      state.quota = result.structuredContent;
    } else if (result?.isError) {
      state.quota = {
        ok: false,
        error: result.content?.[0]?.text || 'Failed to query live quota.',
      };
    }
  } catch (err) {
    state.quota = {
      ok: false,
      error: err?.message || 'Unable to run agy /usage check.',
    };
  } finally {
    state.quotaLoading = false;
    render();
  }
}

function renderQuotaCard() {
  const q = state.quota;
  const checkedAt = q?.fetchedAt
    ? new Date(q.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const btnClass = q?.ok ? 'btn-icon' : 'btn-primary';
  const btnLabel = state.quotaLoading
    ? 'Checking…'
    : q?.ok
      ? 'Refresh Quota'
      : 'Check Live Quota';

  const headerHtml = `
    <div class="card-header" style="${q ? '' : 'margin-bottom:6px;'}">
      <div>
        <div class="card-title">Live Account Quota</div>
        <div class="card-subtitle">${
          q?.ok
            ? `Checked at ${escapeHtml(checkedAt)} via official agy CLI (0 tokens used)`
            : 'On-demand check via official local agy --print /usage --output-format json (0 tokens used)'
        }</div>
      </div>
      <button id="checkQuotaBtn" class="${btnClass}" ${state.quotaLoading ? 'disabled' : ''}>
        <svg class="${state.quotaLoading ? 'spin' : ''}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>
        </svg>
        ${btnLabel}
      </button>
    </div>
  `;

  if (!q) {
    return `
      <section class="card">
        ${headerHtml}
        <div class="quota-hint">
          <span>Click <strong>Check Live Quota</strong> to fetch your current 5-hour and weekly model quota usage percentages locally via <code>agy --print /usage</code>.</span>
        </div>
      </section>
    `;
  }

  if (!q.ok) {
    return `
      <section class="card">
        ${headerHtml}
        <div class="error-banner">
          <strong>Quota check unavailable:</strong> ${escapeHtml(q.error || 'Unknown error')}
          ${q.hint ? `<div style="margin-top:4px;opacity:0.9;">${escapeHtml(q.hint)}</div>` : ''}
        </div>
      </section>
    `;
  }

  const groupsHtml = (q.groups || [])
    .map((g) => {
      const bucketsHtml = (g.buckets || [])
        .map((b) => {
          const winLabel =
            b.window === '5h'
              ? '5-Hour Window'
              : b.window === 'weekly'
                ? 'Weekly Limit'
                : b.name || 'Quota';
          const resetText = fmtResetCountdown(b.resetTime);
          const resetTitle = b.resetTime ? new Date(b.resetTime).toLocaleString() : '';
          return `
            <div class="quota-bucket">
              <div class="quota-bucket-top">
                <span class="quota-window">${escapeHtml(winLabel)}</span>
                <span class="quota-pct">
                  <span class="badge ${quotaBadgeClass(b.usedPct)}">${b.usedPct}% used</span>
                  <span style="margin-left:4px;">${b.remainingPct}% left</span>
                </span>
              </div>
              <div class="track">
                <div class="fill" style="width:${Math.max(b.usedPct > 0 ? 2 : 0, Math.min(100, b.usedPct))}%;background:${quotaFillColor(b.usedPct)}"></div>
              </div>
              <div class="quota-reset">
                <span title="${escapeHtml(resetTitle)}">${escapeHtml(resetText)}</span>
                <span>${b.remainingPct === 100 ? 'Full' : b.remainingPct === 0 ? 'Exhausted' : ''}</span>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="quota-group">
          <div>
            <div class="quota-group-name">${escapeHtml(g.name)}</div>
            ${g.description ? `<div class="quota-group-desc">${escapeHtml(g.description)}</div>` : ''}
          </div>
          ${bucketsHtml}
        </div>
      `;
    })
    .join('');

  return `
    <section class="card">
      ${headerHtml}
      <div class="quota-grid">${groupsHtml}</div>
    </section>
  `;
}

function syncFiltersFromData(data) {
  if (!data?.filters) return;
  state.range = data.filters.range || state.range;
  state.model = data.filters.model || 'all';
  state.workspace = data.filters.workspace || 'all';
}

function renderChart(data, colorMap) {
  const timeline = data.timeline || [];
  if (!timeline.length) {
    return '<div class="empty-state">No timeline data for this selection.</div>';
  }

  const width = 920;
  const height = 210;
  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const isTurns = state.chartMode === 'turns';
  const maxVal = Math.max(
    1,
    ...timeline.map((b) => (isTurns ? b.turns : b.totalTokens)),
  );

  // Gridlines (4 levels)
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const y = padT + plotH * (1 - frac);
    const val = maxVal * frac;
    const label = isTurns ? Math.round(val) : fmtTokens(val);
    return `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}"
            stroke="var(--border-1)" stroke-dasharray="${frac === 0 ? '0' : '3 3'}" />
      <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
            fill="var(--fg-3)" font-size="10.5">${escapeHtml(label)}</text>
    `;
  }).join('');

  const n = timeline.length;
  const slotW = plotW / n;
  const barW = Math.max(4, Math.min(34, slotW * 0.68));
  const labelEvery = Math.max(1, Math.ceil(n / 10));

  const modelKeys = (data.models || []).map((m) => m.model);

  const bars = timeline.map((b, idx) => {
    const cx = padL + idx * slotW + slotW / 2;
    const x = cx - barW / 2;
    let segs = '';

    if (isTurns) {
      const h = (b.turns / maxVal) * plotH;
      const y = padT + plotH - h;
      if (h > 0) {
        segs += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, h).toFixed(1)}" rx="3" fill="var(--accent)" />`;
      }
    } else if (state.chartMode === 'model') {
      let curY = padT + plotH;
      for (const mKey of modelKeys) {
        const v = b.byModel?.[mKey] || 0;
        if (!v) continue;
        const h = (v / maxVal) * plotH;
        curY -= h;
        const fill = colorMap.get(mKey) || '#3b82f6';
        segs += `<rect x="${x.toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${fill}" />`;
      }
    } else {
      // Token split: cacheRead (bottom), freshInput (middle), output (top)
      const parts = [
        { v: b.cacheRead, fill: 'var(--c-cache)' },
        { v: b.freshInput, fill: 'var(--c-fresh)' },
        { v: b.output, fill: 'var(--c-output)' },
      ];
      let curY = padT + plotH;
      for (const p of parts) {
        if (!p.v) continue;
        const h = (p.v / maxVal) * plotH;
        curY -= h;
        segs += `<rect x="${x.toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${p.fill}" />`;
      }
    }

    const showLabel = idx === 0 || idx === n - 1 || idx % labelEvery === 0;
    const xLabel = showLabel
      ? `<text x="${cx.toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="var(--fg-3)" font-size="10.5">${escapeHtml(b.label)}</text>`
      : '';

    return `
      <g class="chart-col" data-bucket-idx="${idx}">
        <rect x="${(padL + idx * slotW).toFixed(1)}" y="${padT}" width="${slotW.toFixed(1)}" height="${plotH}" fill="transparent" />
        ${segs}
        ${xLabel}
      </g>
    `;
  }).join('');

  let legendHtml = '';
  if (state.chartMode === 'split') {
    legendHtml = `
      <span class="legend-item"><span class="swatch" style="background:var(--c-cache)"></span>Cache Read</span>
      <span class="legend-item"><span class="swatch" style="background:var(--c-fresh)"></span>Fresh Input</span>
      <span class="legend-item"><span class="swatch" style="background:var(--c-output)"></span>Output</span>
    `;
  } else if (state.chartMode === 'model') {
    legendHtml = (data.models || []).slice(0, 6).map((m) => `
      <span class="legend-item"><span class="swatch" style="background:${colorMap.get(m.model) || '#3b82f6'}"></span>${escapeHtml(m.label)}</span>
    `).join('');
  } else {
    legendHtml = `<span class="legend-item"><span class="swatch" style="background:var(--accent)"></span>Model Turns</span>`;
  }

  return `
    <div class="chart-wrap">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        ${gridLines}
        ${bars}
      </svg>
    </div>
    <div class="chart-legend">${legendHtml}</div>
  `;
}

function getSortedConversations(convs) {
  const copy = [...(convs || [])];
  switch (state.sortBy) {
    case 'tokens':
      return copy.sort((a, b) => b.totalTokens - a.totalTokens);
    case 'cache':
      return copy.sort((a, b) => b.cacheHitRate - a.cacheHitRate || b.totalTokens - a.totalTokens);
    case 'turns':
      return copy.sort((a, b) => b.turns - a.turns || b.totalTokens - a.totalTokens);
    case 'recent':
    default:
      return copy.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  }
}

function render() {
  const root = document.getElementById('root');
  if (!state.data) {
    if (state.error) {
      root.innerHTML = `<div class="error-banner">${escapeHtml(state.error)}</div>`;
    } else {
      root.innerHTML = `<div class="empty-state">Loading Antigravity usage telemetry…</div>`;
    }
    return;
  }

  const d = state.data;
  const s = d.summary;
  const colorMap = getModelColorMap(d.availableModels);

  const totalT = Math.max(1, s.totalTokens);
  const cachePctOfTotal = (s.cacheReadTokens / totalT) * 100;
  const freshPctOfTotal = (s.freshInputTokens / totalT) * 100;
  const outPctOfTotal = (s.outputTokens / totalT) * 100;

  const updatedTime = d.generatedAt
    ? new Date(d.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';

  const modelOptions = [
    `<option value="all"${state.model === 'all' ? ' selected' : ''}>All Models</option>`,
    ...(d.availableModels || []).map(
      (m) =>
        `<option value="${escapeHtml(m.id)}"${state.model === m.id ? ' selected' : ''}>${escapeHtml(m.label)}</option>`,
    ),
  ].join('');

  const wsOptions = [
    `<option value="all"${state.workspace === 'all' ? ' selected' : ''}>All Workspaces</option>`,
    ...(d.availableWorkspaces || []).map(
      (w) =>
        `<option value="${escapeHtml(w.name)}"${state.workspace === w.name ? ' selected' : ''}>${escapeHtml(w.name)} (${w.count})</option>`,
    ),
  ].join('');

  const modelsHtml = (d.models || []).length
    ? d.models
        .map((m) => {
          const color = colorMap.get(m.model) || '#3b82f6';
          const isSelected = state.model === m.model;
          return `
            <div class="bar-row clickable" data-filter-model="${escapeHtml(isSelected ? 'all' : m.model)}" title="Click to ${isSelected ? 'clear' : 'filter by'} model">
              <div class="bar-row-top">
                <span class="bar-name">
                  <span class="swatch" style="background:${color}"></span>
                  ${escapeHtml(m.label)}
                  <span class="badge ${cacheBadgeClass(m.cacheHitRate)}">${m.cacheHitRate}% cache</span>
                </span>
                <span class="bar-stats">
                  <span>${m.turns} turns</span>
                  <strong>${fmtTokens(m.totalTokens)}</strong>
                  <span>${m.sharePct}%</span>
                </span>
              </div>
              <div class="track">
                <div class="fill" style="width:${Math.max(2, m.sharePct)}%;background:${color}"></div>
              </div>
            </div>
          `;
        })
        .join('')
    : '<div class="empty-state">No model activity in this range.</div>';

  const maxToolCount = Math.max(1, ...(d.tools || []).map((t) => t.count));
  const toolsHtml = (d.tools || []).length
    ? d.tools
        .slice(0, 10)
        .map(
          (t) => `
          <div class="bar-row">
            <div class="bar-row-top">
              <span class="bar-name mono">${escapeHtml(t.name)}</span>
              <span class="bar-stats">
                <strong>${fmtExact(t.count)}</strong>
                <span>${t.sharePct}%</span>
              </span>
            </div>
            <div class="track">
              <div class="fill" style="width:${Math.max(3, (t.count / maxToolCount) * 100)}%;background:var(--accent)"></div>
            </div>
          </div>
        `,
        )
        .join('')
    : '<div class="empty-state">No tool calls recorded in this range.</div>';

  const sortedConvs = getSortedConversations(d.conversations);
  const convRowsHtml = sortedConvs.length
    ? sortedConvs
        .map(
          (c) => `
          <tr>
            <td>
              <div class="conv-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
              <div class="conv-sub">
                <span class="badge badge-neutral">${escapeHtml(c.workspace)}</span>
                ${c.isSubagent ? '<span class="badge badge-neutral">subagent</span>' : ''}
                <span class="mono">${escapeHtml(c.id.slice(0, 8))}</span>
              </div>
            </td>
            <td>${escapeHtml(c.primaryModelLabel)}</td>
            <td class="num">${fmtExact(c.turns)}</td>
            <td class="num" title="Fresh: ${fmtExact(c.freshInput)} | Cache: ${fmtExact(c.cacheRead)}">${fmtTokens(c.freshInput + c.cacheRead)}</td>
            <td class="num">${fmtTokens(c.output)}</td>
            <td class="num"><span class="badge ${cacheBadgeClass(c.cacheHitRate)}">${c.cacheHitRate}%</span></td>
            <td class="num"><strong>${fmtTokens(c.totalTokens)}</strong></td>
            <td class="num" title="${escapeHtml(c.lastActiveAt)}">${escapeHtml(fmtRelativeTime(c.lastActiveAt))}</td>
          </tr>
        `,
        )
        .join('')
    : `<tr><td colspan="8"><div class="empty-state"><p>No conversations match the current filters.</p><button class="btn-icon" id="resetFiltersBtn">Reset Filters</button></div></td></tr>`;

  const historyCardHtml = d.sessionHistory?.dbFound
    ? `
      <section class="card">
        <div class="card-header">
          <div>
            <div class="card-title">All-Time Session History</div>
            <div class="card-subtitle">From local conversation_summaries.db · ${fmtExact(d.sessionHistory.totalSessions)} sessions · ${fmtExact(d.sessionHistory.totalSteps)} total steps (${fmtExact(d.sessionHistory.sessionsInRange)} sessions in range)</div>
          </div>
        </div>
        <div class="ws-chips">
          ${(d.sessionHistory.topWorkspaces || [])
            .map(
              (w) => `
              <div class="ws-chip">
                <strong>${escapeHtml(w.workspace)}</strong>
                <span>${fmtExact(w.sessions)} sessions · ${fmtExact(w.steps)} steps</span>
              </div>
            `,
            )
            .join('')}
        </div>
      </section>
    `
    : '';

  root.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="brand-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3v18h18"/><path d="M7 16v-4"/><path d="M12 16V8"/><path d="M17 16v-6"/>
          </svg>
        </div>
        <div>
          <div class="brand-title">Antigravity Usage</div>
          <div class="brand-sub">Updated ${escapeHtml(updatedTime)} · ${d.sources.transcriptFilesCount} transcript${d.sources.transcriptFilesCount === 1 ? '' : 's'} scanned</div>
        </div>
      </div>
      <div class="controls">
        <div class="segmented" role="group" aria-label="Time range">
          ${['24h', '7d', '30d', 'all']
            .map(
              (r) =>
                `<button data-range="${r}" class="${state.range === r ? 'active' : ''}">${r === 'all' ? 'All' : r.toUpperCase()}</button>`,
            )
            .join('')}
        </div>
        <select id="modelSelect" class="ctrl-select" aria-label="Filter by model">${modelOptions}</select>
        <select id="wsSelect" class="ctrl-select" aria-label="Filter by workspace">${wsOptions}</select>
        <button id="refreshBtn" class="btn-icon" ${state.loading ? 'disabled' : ''}>
          <svg class="${state.loading ? 'spin' : ''}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>
          </svg>
          Refresh
        </button>
      </div>
    </header>

    ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}

    ${renderQuotaCard()}

    <section class="kpi-grid">
      <div class="card kpi-card">
        <div class="kpi-label">Total Tokens</div>
        <div class="kpi-value" title="${fmtExact(s.totalTokens)} tokens">${fmtTokens(s.totalTokens)}</div>
        <div class="split-bar" title="Cache ${cachePctOfTotal.toFixed(1)}% · Fresh ${freshPctOfTotal.toFixed(1)}% · Output ${outPctOfTotal.toFixed(1)}%">
          <div class="split-seg" style="width:${cachePctOfTotal}%;background:var(--c-cache)"></div>
          <div class="split-seg" style="width:${freshPctOfTotal}%;background:var(--c-fresh)"></div>
          <div class="split-seg" style="width:${outPctOfTotal}%;background:var(--c-output)"></div>
        </div>
        <div class="kpi-meta">${fmtTokens(s.freshInputTokens)} fresh · ${fmtTokens(s.cacheReadTokens)} cached · ${fmtTokens(s.outputTokens)} out</div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-label">
          KV-Cache Hit Rate
          <span class="badge ${cacheBadgeClass(s.cacheHitRate)}">${s.cacheHitRate >= 70 ? 'Healthy' : s.cacheHitRate >= 35 ? 'Moderate' : 'Low'}</span>
        </div>
        <div class="kpi-value">${s.cacheHitRate}%</div>
        <div class="kpi-meta">${fmtTokens(s.cacheReadTokens)} of ${fmtTokens(s.totalInputTokens)} input tokens served from cache</div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-label">Output &amp; Turns</div>
        <div class="kpi-value">${fmtTokens(s.outputTokens)}</div>
        <div class="kpi-meta">${fmtExact(s.turns)} turns · avg ${fmtTokens(s.avgTokensPerTurn)}/turn · peak ${fmtTokens(s.peakContextTokens)} ctx</div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-label">Tools &amp; Conversations</div>
        <div class="kpi-value">${fmtExact(s.toolCalls)}</div>
        <div class="kpi-meta">tool calls across ${fmtExact(s.telemetryConversations)} active chats${s.totalDbConversations ? ` · ${fmtExact(s.totalDbConversations)} total history` : ''}</div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Usage Over Time</div>
          <div class="card-subtitle">${state.range === '24h' ? 'Hourly buckets (last 24 hours)' : state.range === 'all' ? 'Daily buckets (all available transcripts)' : `Daily buckets (last ${state.range})`}</div>
        </div>
        <div class="segmented" role="group" aria-label="Chart mode">
          <button data-chart-mode="split" class="${state.chartMode === 'split' ? 'active' : ''}">Token Split</button>
          <button data-chart-mode="model" class="${state.chartMode === 'model' ? 'active' : ''}">By Model</button>
          <button data-chart-mode="turns" class="${state.chartMode === 'turns' ? 'active' : ''}">Turns</button>
        </div>
      </div>
      ${renderChart(d, colorMap)}
    </section>

    <section class="two-col">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Model Breakdown</div>
            <div class="card-subtitle">Click any model to toggle filter</div>
          </div>
        </div>
        <div class="bar-list">${modelsHtml}</div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Top Tools</div>
            <div class="card-subtitle">Most invoked agent tools</div>
          </div>
        </div>
        <div class="bar-list">${toolsHtml}</div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Conversations (${sortedConvs.length})</div>
          <div class="card-subtitle">Token telemetry per conversation</div>
        </div>
        <div class="controls">
          <input id="searchInput" class="ctrl-input" type="search" placeholder="Search conversations…" value="${escapeHtml(state.search)}" />
          <select id="sortSelect" class="ctrl-select" aria-label="Sort conversations">
            <option value="recent"${state.sortBy === 'recent' ? ' selected' : ''}>Sort: Recent</option>
            <option value="tokens"${state.sortBy === 'tokens' ? ' selected' : ''}>Sort: Most Tokens</option>
            <option value="cache"${state.sortBy === 'cache' ? ' selected' : ''}>Sort: Best Cache %</option>
            <option value="turns"${state.sortBy === 'turns' ? ' selected' : ''}>Sort: Most Turns</option>
          </select>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Conversation</th>
              <th>Model</th>
              <th class="num">Turns</th>
              <th class="num">Input</th>
              <th class="num">Output</th>
              <th class="num">Cache %</th>
              <th class="num">Total</th>
              <th class="num">Active</th>
            </tr>
          </thead>
          <tbody>${convRowsHtml}</tbody>
        </table>
      </div>
    </section>

    ${historyCardHtml}

    <footer class="footnote">
      <span>100% local telemetry from Antigravity transcripts &amp; SQLite metadata.</span>
      <span>Live quota runs official <code>agy --print /usage</code> on demand (0 tokens).</span>
    </footer>
  `;

  bindEvents(d);
}

function bindEvents(data) {
  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      fetchUsage();
    });
  });

  document.querySelectorAll('[data-chart-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.chartMode = btn.dataset.chartMode;
      render();
    });
  });

  document.querySelectorAll('[data-filter-model]').forEach((el) => {
    el.addEventListener('click', () => {
      state.model = el.dataset.filterModel;
      fetchUsage();
    });
  });

  const modelSel = document.getElementById('modelSelect');
  if (modelSel) {
    modelSel.addEventListener('change', (e) => {
      state.model = e.target.value;
      fetchUsage();
    });
  }

  const wsSel = document.getElementById('wsSelect');
  if (wsSel) {
    wsSel.addEventListener('change', (e) => {
      state.workspace = e.target.value;
      fetchUsage();
    });
  }

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchUsage());
  }

  const checkQuotaBtn = document.getElementById('checkQuotaBtn');
  if (checkQuotaBtn) {
    checkQuotaBtn.addEventListener('click', () => fetchLiveQuota());
  }

  const sortSel = document.getElementById('sortSelect');
  if (sortSel) {
    sortSel.addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      render();
    });
  }

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    let timer;
    searchInput.addEventListener('input', (e) => {
      state.search = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(() => fetchUsage(), 220);
    });
  }

  const resetBtn = document.getElementById('resetFiltersBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      state.range = 'all';
      state.model = 'all';
      state.workspace = 'all';
      state.search = '';
      fetchUsage();
    });
  }

  // Interactive chart tooltips
  const tooltip = document.getElementById('tooltip');
  const timeline = data.timeline || [];
  document.querySelectorAll('.chart-col').forEach((col) => {
    col.addEventListener('mouseenter', (ev) => {
      const b = timeline[Number(col.dataset.bucketIdx)];
      if (!b) return;
      const totIn = b.freshInput + b.cacheRead;
      const hit = totIn > 0 ? ((b.cacheRead / totIn) * 100).toFixed(1) : '0.0';
      tooltip.innerHTML = `
        <div class="tooltip-title">${escapeHtml(b.bucket)}</div>
        <div class="tooltip-row"><span>Total</span><strong>${fmtTokens(b.totalTokens)}</strong></div>
        <div class="tooltip-row"><span>Cache Read</span><strong>${fmtTokens(b.cacheRead)} (${hit}%)</strong></div>
        <div class="tooltip-row"><span>Fresh Input</span><strong>${fmtTokens(b.freshInput)}</strong></div>
        <div class="tooltip-row"><span>Output</span><strong>${fmtTokens(b.output)}</strong></div>
        <div class="tooltip-row"><span>Turns</span><strong>${fmtExact(b.turns)}</strong></div>
      `;
      tooltip.classList.add('visible');
      positionTooltip(ev, tooltip);
    });
    col.addEventListener('mousemove', (ev) => positionTooltip(ev, tooltip));
    col.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
  });
}

function positionTooltip(ev, el) {
  const pad = 12;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const rect = el.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = ev.clientY - rect.height - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

// Register handlers BEFORE connect() so no host notification is missed.
app.ontoolinput = ({ arguments: args }) => {
  if (args?.range) state.range = args.range;
  if (args?.model) state.model = args.model;
  if (args?.workspace) state.workspace = args.workspace;
  state.loading = true;
  render();
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    state.data = result.structuredContent;
    if (state.data.quota && !state.quota) {
      state.quota = state.data.quota;
    }
    syncFiltersFromData(state.data);
    state.error = null;
  } else if (result?.isError) {
    state.error = result.content?.[0]?.text || 'Failed to load usage telemetry.';
  }
  state.loading = false;
  render();
};

app.onhostcontextchanged = (ctx) => {
  applyTheme(ctx);
};

async function init() {
  try {
    await app.connect();
    state.connected = true;
    applyTheme(app.getHostContext());
    // If no tool result arrives immediately, fetch directly via app-only tool.
    setTimeout(() => {
      if (!state.data && state.connected) {
        fetchUsage();
      }
    }, 350);
  } catch (err) {
    state.error = `Failed to connect to host: ${err?.message || err}`;
    state.loading = false;
    render();
  }
}

init();
