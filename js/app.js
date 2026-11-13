/**
 * 页面主控制器：筛选 → QAMetrics.summarize → 渲染所有视图
 * 所有数值来自指标引擎，页面只做展示与格式化，不重算口径。
 */
(function () {
  'use strict';

  const dataset = window.QA_SAMPLE;
  const QAM = window.QAMetrics;
  const Charts = window.QACharts;
  // 样例数据不可变，索引只建一次
  const INDEX = QAM.buildIndex(dataset);

  const state = {
    filters: { productId: 'ALL', lineId: 'ALL', shiftId: 'ALL', dateFrom: null, dateTo: null },
    viewModes: { defect: 'chart', opdefect: 'chart', shiftrate: 'chart', shiftcost: 'chart', batch: 'chart' },
    expanded: new Set(),
  };

  const $ = (id) => document.getElementById(id);
  const pctText = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
  const money = (n) => `¥${Math.round(n).toLocaleString('zh-CN')}`;
  const nameOf = (list, id, key = 'id') => list.find((x) => x[key] === id)?.name ?? id;

  /* ---------------- 主题 ---------------- */

  function initTheme() {
    const saved = localStorage.getItem('qa-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
    $('theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('qa-theme', next);
      applyTheme(next);
      render(); // CSS 变量换值后重绘 SVG
    });
  }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = $('theme-toggle');
    btn.textContent = theme === 'dark' ? '☀️ 浅色' : '🌙 暗色';
  }

  /* ---------------- 过滤器 ---------------- */

  function initFilters() {
    fillSelect('f-product', dataset.products);
    fillSelect('f-line', dataset.lines);
    fillSelect('f-shift', dataset.shifts);

    const dates = dataset.workOrders.map((w) => w.createdAt.slice(0, 10)).sort();
    $('f-from').min = dates[0];
    $('f-from').max = dates[dates.length - 1];
    $('f-to').min = dates[0];
    $('f-to').max = dates[dates.length - 1];

    $('f-product').addEventListener('change', (e) => { state.filters.productId = e.target.value; render(); });
    $('f-line').addEventListener('change', (e) => { state.filters.lineId = e.target.value; render(); });
    $('f-shift').addEventListener('change', (e) => { state.filters.shiftId = e.target.value; render(); });
    $('f-from').addEventListener('change', (e) => { state.filters.dateFrom = e.target.value || null; render(); });
    $('f-to').addEventListener('change', (e) => { state.filters.dateTo = e.target.value || null; render(); });
    $('f-reset').addEventListener('click', () => {
      state.filters = { productId: 'ALL', lineId: 'ALL', shiftId: 'ALL', dateFrom: null, dateTo: null };
      $('f-product').value = 'ALL';
      $('f-line').value = 'ALL';
      $('f-shift').value = 'ALL';
      $('f-from').value = '';
      $('f-to').value = '';
      state.expanded.clear();
      render();
    });

    document.querySelectorAll('.view-toggle').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        state.viewModes[group.dataset.viewKey] = btn.dataset.mode;
        render();
      });
    });

    $('dataset-meta').textContent =
      `（样例 v${dataset.meta.version} · ${dataset.meta.timezone} · 金额单位 ${dataset.meta.currency}）`;
  }

  function fillSelect(id, list) {
    const sel = $(id);
    for (const item of list) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.name;
      sel.appendChild(opt);
    }
  }

  /* ---------------- 渲染入口 ---------------- */

  function render() {
    const summary = QAM.summarize(dataset, state.filters);
    renderKpis(summary);
    renderDefectCharts(summary);
    renderShiftCharts(summary);
    renderBatchTable(summary);
  }

  /* ---------------- KPI ---------------- */

  function renderKpis(s) {
    const t = s.totals;
    const tiles = [
      {
        label: '产量（序列号去重）',
        value: t.totalUnits ? t.totalUnits.toLocaleString('zh-CN') : null,
        note: `${t.batchCount} 个批次`,
      },
      {
        label: '一次通过率 FPY',
        value: s.rates.fpy === null ? null : pctText(s.rates.fpy),
        note: `${t.firstPassCount}/${t.evaluableUnits} 件首检全合格`,
      },
      {
        label: '最终良率',
        value: s.rates.finalYield === null ? null : pctText(s.rates.finalYield),
        note: `${t.finalPassCount}/${t.evaluableUnits} 件最终合格`,
      },
      {
        label: '返工成本',
        value: t.totalUnits ? money(s.costs.rework.total) : null,
        note: `工时 ${money(s.costs.rework.labor)} · 辅料 ${money(s.costs.rework.material)}`,
      },
      {
        label: '报废成本',
        value: t.totalUnits ? money(s.costs.scrap.total) : null,
        note: `主料损失 ${money(s.costs.scrap.materialLoss)} · 加工费 ${money(s.costs.scrap.processing)}`,
      },
      {
        label: '追踪完整性',
        value: s.rates.completeness === null ? null : pctText(s.rates.completeness),
        note: t.incompleteUnits
          ? { html: true, text: `${t.incompleteUnits} 件追踪不完整`, warn: true }
          : '全部记录完整',
      },
    ];

    const row = $('kpi-row');
    row.replaceChildren();
    for (const tile of tiles) {
      const card = document.createElement('div');
      card.className = 'kpi';
      const label = document.createElement('div');
      label.className = 'kpi-label';
      label.textContent = tile.label;
      const value = document.createElement('div');
      value.className = tile.value === null ? 'kpi-value empty' : 'kpi-value';
      value.textContent = tile.value ?? '无数据';
      const note = document.createElement('div');
      note.className = 'kpi-note';
      if (typeof tile.note === 'object' && tile.note.html) {
        const span = document.createElement('span');
        span.className = tile.note.warn ? 'warn' : '';
        span.textContent = tile.note.text;
        note.appendChild(span);
      } else {
        note.textContent = tile.note;
      }
      card.append(label, value, note);
      row.appendChild(card);
    }
  }

  /* ---------------- 缺陷分布 ---------------- */

  function renderDefectCharts(s) {
    // 缺陷类型
    if (state.viewModes.defect === 'chart') {
      Charts.horizontalBars($('defect-chart'), s.defectDistribution.map((d) => ({
        label: d.name,
        value: d.count,
        display: `${d.count} 起`,
        tooltipExtra: [{ name: '类别', value: d.category }],
      })), { measureName: '首检失败' });
    } else {
      renderTable($('defect-chart'),
        ['缺陷代码', '缺陷名称', '类别', '首检失败次数'],
        s.defectDistribution.map((d) => [d.code, d.name, d.category, { num: d.count }]));
    }

    // 缺陷工序
    if (state.viewModes.opdefect === 'chart') {
      Charts.horizontalBars($('opdefect-chart'), s.operationDefectDistribution.map((o) => ({
        label: `${o.opId} ${o.names.join('/')}`,
        value: o.count,
        display: `${o.count} 起`,
        tooltipExtra: [{ name: '工序号', value: o.opId }],
      })), { measureName: '首检失败', labelW: 160 });
    } else {
      renderTable($('opdefect-chart'),
        ['工序号', '工序名称（按产品路线）', '首检失败次数'],
        s.operationDefectDistribution.map((o) => [o.opId, o.names.join(' / '), { num: o.count }]));
    }
  }

  /* ---------------- 班次对比 ---------------- */

  function renderShiftCharts(s) {
    const rows = s.shiftComparison;
    const cats = rows.map((r) => ({ label: r.shiftName, hint: `${r.totalUnits}件` }));

    if (state.viewModes.shiftrate === 'chart') {
      Charts.groupedColumns($('shift-rate-chart'), cats, [
        {
          key: 'fpy', name: '一次通过率', colorVar: '--series-1',
          values: rows.map((r) => r.fpy ?? 0),
          displays: rows.map((r) => pctText(r.fpy)),
        },
        {
          key: 'yield', name: '最终良率', colorVar: '--series-2',
          values: rows.map((r) => r.finalYield ?? 0),
          displays: rows.map((r) => pctText(r.finalYield)),
        },
      ]);
    } else {
      renderTable($('shift-rate-chart'),
        ['班次', '批次', '产量', '可评估', '一次通过率', '最终良率'],
        rows.map((r) => [
          r.shiftName, { num: r.batchCount }, { num: r.totalUnits },
          { num: r.evaluableUnits }, { num: pctText(r.fpy) }, { num: pctText(r.finalYield) },
        ]));
    }

    if (state.viewModes.shiftcost === 'chart') {
      Charts.costColumns($('shift-cost-chart'), cats,
        rows.map((r) => r.reworkCost), rows.map((r) => r.scrapCost));
    } else {
      renderTable($('shift-cost-chart'),
        ['班次', '返工成本', '报废成本', '质量成本合计'],
        rows.map((r) => [
          r.shiftName, { num: money(r.reworkCost) }, { num: money(r.scrapCost) },
          { num: money(r.reworkCost + r.scrapCost) },
        ]));
    }
  }

  /* ---------------- 批次明细 ---------------- */

  function renderBatchTable(s) {
    syncToggleButtons();
    const tbody = $('batch-tbody');
    const tableView = $('batch-table-view');
    $('batch-table').hidden = state.viewModes.batch === 'table';
    tableView.hidden = state.viewModes.batch !== 'table';
    if (state.viewModes.batch === 'table') {
      renderTable(tableView,
        ['批次/工单', '产品', '产线', '班次', '路线', '产量', '可评估', '不完整', 'FPY', '最终良率', '返工成本', '报废成本'],
        s.batches.map((b) => [
          b.batchId,
          nameOf(dataset.products, b.workOrder.productId),
          nameOf(dataset.lines, b.workOrder.lineId),
          nameOf(dataset.shifts, b.workOrder.shiftId),
          b.route.version,
          { num: b.totals.totalUnits }, { num: b.totals.evaluableUnits },
          { num: b.totals.incompleteUnits },
          { num: pctText(b.rates.fpy) }, { num: pctText(b.rates.finalYield) },
          { num: money(b.costs.rework.total) }, { num: money(b.costs.scrap.total) },
        ]));
      return;
    }

    tbody.replaceChildren();
    for (const b of s.batches) {
      const tr = document.createElement('tr');
      tr.className = 'batch-row';
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', state.expanded.has(b.batchId) ? 'true' : 'false');
      tr.setAttribute('aria-label', `展开批次 ${b.batchId}`);

      tr.append(
        td(`<span class="expand-icon">▶</span>`),
        td(`${b.batchId}<br><span style="color:var(--text-muted);font-size:12px">${b.workOrder.id}</span>`, true),
        td(nameOf(dataset.products, b.workOrder.productId)),
        td(nameOf(dataset.lines, b.workOrder.lineId)),
        td(nameOf(dataset.shifts, b.workOrder.shiftId)),
        td(routeBadge(b.route)),
        tdNum(b.totals.totalUnits),
        tdNum(pctText(b.rates.fpy)),
        tdNum(pctText(b.rates.finalYield)),
        tdNum(money(b.costs.rework.total)),
        tdNum(money(b.costs.scrap.total)),
        td(trackingBadge(b)),
      );
      tr.addEventListener('click', () => toggleBatch(b.batchId));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBatch(b.batchId); }
      });
      tbody.appendChild(tr);

      if (state.expanded.has(b.batchId)) {
        const detailTr = document.createElement('tr');
        detailTr.className = 'batch-detail-row';
        const detailTd = document.createElement('td');
        detailTd.colSpan = 12;
        detailTd.appendChild(buildBatchDetail(b, s.index));
        detailTr.appendChild(detailTd);
        tbody.appendChild(detailTr);
      }
    }
  }

  function toggleBatch(batchId) {
    if (state.expanded.has(batchId)) state.expanded.delete(batchId);
    else state.expanded.add(batchId);
    renderBatchTable(QAM.summarize(dataset, state.filters));
  }

  function buildBatchDetail(b, idx) {
    const wrap = document.createElement('div');
    wrap.className = 'batch-detail';

    // 1. 工艺路线工序流（绑定版本，含各检验点 FPY 与缺失标记）
    wrap.appendChild(sectionTitle('工艺路线与检验点（按工单绑定版本 '
      + `${b.route.routeId} 解释）${b.route.changeNote ? `— ${b.route.changeNote}` : ''}`));
    const flow = document.createElement('div');
    flow.className = 'op-flow';
    b.route.operations.forEach((op, i) => {
      const node = document.createElement('div');
      const missing = b.missingOpReport.find((m) => m.opId === op.opId);
      node.className = `op-node${missing ? ' missing' : ''}`;
      const fpyRow = b.operationFpy.find((f) => f.opId === op.opId);

      const name = document.createElement('div');
      name.className = 'op-name';
      const nm = document.createElement('span');
      nm.textContent = `${op.opId} ${op.name}`;
      name.appendChild(nm);
      if (op.inspectionPoint) {
        const dot = document.createElement('span');
        dot.className = 'inspect-dot';
        dot.textContent = '检验点';
        name.appendChild(dot);
      }
      node.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'op-meta';
      if (fpyRow) {
        meta.textContent = `首检 ${fpyRow.firstPassed}/${fpyRow.firstInspected} 合格`;
        const fpy = document.createElement('div');
        fpy.className = 'op-fpy';
        fpy.textContent = `工序 FPY ${pctText(fpyRow.fpy)}`;
        node.append(meta, fpy);
      } else {
        meta.textContent = op.inspectionPoint ? '无检验记录' : '加工工序';
        node.appendChild(meta);
      }
      if (missing) {
        const warn = document.createElement('div');
        warn.className = 'op-fpy';
        warn.style.color = 'var(--serious)';
        warn.textContent = `缺失 ${missing.serialIds.length} 件报工/检验`;
        node.appendChild(warn);
      }

      flow.appendChild(node);
      if (i < b.route.operations.length - 1) {
        const arrow = document.createElement('span');
        arrow.className = 'op-arrow';
        arrow.textContent = '→';
        flow.appendChild(arrow);
      }
    });
    wrap.appendChild(flow);

    // 2. 缺陷在工序的分布（本批次）
    const batchDefects = batchDefectRows(b, idx);
    if (batchDefects.length) {
      wrap.appendChild(sectionTitle('缺陷出现位置与返工复检结论'));
      const list = document.createElement('div');
      list.className = 'table-scroll';
      renderTable(list,
        ['工序', '缺陷', '涉及序列号', '首检失败', '复检通过', '返工后报废'],
        batchDefects);
      wrap.appendChild(list);
    }

    // 3. 成本拆分
    wrap.appendChild(sectionTitle('质量成本拆分（返工 / 报废分别归集）'));
    const split = document.createElement('div');
    split.className = 'cost-split';
    split.append(
      costBlock('rework', '返工成本', b.costs.rework.total,
        `工时费 ${money(b.costs.rework.labor)} · 辅料 ${money(b.costs.rework.material)} · ${b.totals.reworkCount} 次返工`),
      costBlock('scrap', '报废成本', b.costs.scrap.total,
        `主料损失 ${money(b.costs.scrap.materialLoss)} · 加工费 ${money(b.costs.scrap.processing)} · ${b.totals.scrapCount} 件报废`),
    );
    wrap.appendChild(split);

    // 4. 序列号清单（点击进追溯抽屉）
    wrap.appendChild(sectionTitle('序列号清单（点击查看单件全流程追溯）'));
    const chips = document.createElement('div');
    chips.className = 'unit-mini';
    const evalMap = new Map(b.unitResults.map((u) => [u.serialId, u]));
    for (const serialId of (idx.unitsByBatch.get(b.batchId) ?? []).map((u) => u.serialId)) {
      const u = evalMap.get(serialId);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `unit-chip ${u.finalStatus === 'scrap' ? 'scrap' : ''} ${u.finalStatus === 'rework-open' ? 'open' : ''} ${u.finalStatus === 'incomplete' ? 'incomplete' : ''}`;
      chip.textContent = `${serialId.split('-U')[1]} · ${statusLabel(u.finalStatus)}`;
      chip.title = serialId;
      chip.addEventListener('click', () => openDrawer(serialId));
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);

    return wrap;
  }

  function batchDefectRows(b, idx) {
    const map = new Map(); // opId|defect -> row
    for (const ins of dataset.inspections.filter((i) => i.batchId === b.batchId && i.result === 'fail')) {
      const k = `${ins.opId}|${ins.defectCode}`;
      if (!map.has(k)) {
        const op = b.route.operations.find((o) => o.opId === ins.opId);
        map.set(k, {
          opId: ins.opId,
          op: `${ins.opId} ${op.name}`,
          defect: `${ins.defectCode} ${idx.defects.get(ins.defectCode).name}`,
          serials: new Set(),
          first: 0, rePass: 0, reScrap: 0,
        });
      }
      const row = map.get(k);
      row.serials.add(ins.serialId);
      if (ins.seqNo === 1) row.first += 1;
    }
    // 复检结论按序列号-工序汇总：看该序列号在该工序的最后一条检验记录
    for (const [, row] of map) {
      for (const serialId of row.serials) {
        const recs = dataset.inspections
          .filter((i) => i.serialId === serialId && i.opId === row.opId)
          .sort((a, c) => a.seqNo - c.seqNo);
        const last = recs[recs.length - 1];
        const scrap = dataset.scrapRecords.find(
          (s) => s.serialId === serialId && s.fromOpId === row.opId,
        );
        if (scrap) row.reScrap += 1;
        else if (recs.length >= 2 && last.result === 'pass') row.rePass += 1;
      }
    }
    return [...map.values()].map((r) => [
      r.op, r.defect, `${r.serials.size} 件：${[...r.serials].map((x) => x.split('-U')[1]).join('、')}`,
      { num: r.first }, { num: r.rePass }, { num: r.reScrap },
    ]);
  }

  /* ---------------- 单件追溯抽屉 ---------------- */

  function openDrawer(serialId) {
    const tl = QAM.unitTimeline(dataset, INDEX, serialId);

    $('drawer-title').textContent = serialId;
    const meta = $('drawer-meta');
    meta.replaceChildren();
    meta.append(
      text(`${tl.workOrder.batchId} · ${nameOf(dataset.products, tl.workOrder.productId)} · `),
      text(`${nameOf(dataset.lines, tl.workOrder.lineId)} · ${nameOf(dataset.shifts, tl.workOrder.shiftId)} · `),
      text(`路线 ${tl.route.routeId}（${tl.route.version}）`),
    );

    const body = $('drawer-body');
    body.replaceChildren();

    const summary = document.createElement('div');
    summary.className = 'drawer-summary';
    const kv = (k, v) => {
      const div = document.createElement('div');
      div.className = 'kv';
      const kEl = document.createElement('div');
      kEl.className = 'k';
      kEl.textContent = k;
      const vEl = document.createElement('div');
      vEl.className = 'v';
      vEl.textContent = v;
      div.append(kEl, vEl);
      return div;
    };
    summary.append(
      kv('最终状态', statusLabel(tl.finalStatus)),
      kv('是否可评估', tl.evaluable ? '是' : '否（追踪不完整）'),
      kv('累计返工成本', money(tl.reworkCost)),
      kv('累计报废成本', tl.scrapCost ? money(tl.scrapCost) : '—'),
    );
    body.appendChild(summary);

    if (tl.missingOps.length) {
      const warn = document.createElement('div');
      warn.className = 'badge serious';
      warn.style.marginBottom = '14px';
      warn.textContent = `缺失工序记录：${tl.missingOps.join('、')}`;
      body.appendChild(warn);
    }

    // 时间线：沿绑定路线逐道工序
    for (const step of tl.steps) {
      const row = document.createElement('div');
      row.className = 'tl-step';
      const dot = document.createElement('div');
      dot.className = `tl-dot ${step.state}`;
      const card = document.createElement('div');
      card.className = 'tl-card';

      const title = document.createElement('div');
      title.className = 'tl-title';
      const t = document.createElement('span');
      t.textContent = `${step.op.opId} ${step.op.name}`;
      title.appendChild(t);
      title.appendChild(statusBadge(step.state, step));
      card.appendChild(title);

      const sub = document.createElement('div');
      sub.className = 'tl-sub';
      sub.textContent = step.hasReport
        ? `工序序号 ${step.op.seq}${step.op.inspectionPoint ? ' · 检验点' : ' · 加工工序'}`
        : `工序序号 ${step.op.seq} · 无报工/检验记录（追踪缺口）`;
      card.appendChild(sub);

      // 检验记录（首检 + 复检链）
      if (step.inspections.length) {
        const ul = document.createElement('ul');
        ul.className = 'record-list';
        for (const ins of step.inspections) {
          const li = document.createElement('li');
          const head = document.createElement('div');
          head.className = 'rec-head';
          const left = document.createElement('span');
          left.textContent = ins.seqNo === 1 ? '首检' : `第 ${ins.seqNo - 1} 次复检`;
          const right = document.createElement('span');
          right.textContent = ins.result === 'pass' ? '✓ 合格' : `✗ 不合格 · ${ins.defectCode}`;
          right.style.color = ins.result === 'pass' ? 'var(--good-text)' : 'var(--critical)';
          head.append(left, right);
          const sub2 = document.createElement('div');
          sub2.className = 'rec-sub';
          sub2.textContent = `${ins.id} · ${ins.inspectedAt.replace('T', ' ').slice(0, 16)} · 检验员 ${ins.inspectorId}`;
          li.append(head, sub2);
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }

      // 返工记录
      for (const rw of step.reworks) {
        const ul = document.createElement('ul');
        ul.className = 'record-list';
        const li = document.createElement('li');
        const head = document.createElement('div');
        head.className = 'rec-head';
        const left = document.createElement('span');
        left.textContent = `返工单 ${rw.id}（${rw.status === 'open' ? '未关闭' : '已关闭'}）`;
        const right = document.createElement('span');
        right.textContent = money(rw.totalCost);
        head.append(left, right);
        const sub2 = document.createElement('div');
        sub2.className = 'rec-sub';
        sub2.textContent = `工时 ${rw.laborMinutes} 分钟 ${money(rw.laborCost)} · 辅料 ${money(rw.materialCost)} · 缺陷 ${idx_defectName(rw.defectCode)}`;
        li.append(head, sub2);
        ul.appendChild(li);
        card.appendChild(ul);
      }

      // 报废记录
      if (step.scrap) {
        const sc = step.scrap;
        const ul = document.createElement('ul');
        ul.className = 'record-list';
        const li = document.createElement('li');
        const head = document.createElement('div');
        head.className = 'rec-head';
        const left = document.createElement('span');
        left.textContent = `报废单 ${sc.id}`;
        const right = document.createElement('span');
        right.textContent = money(sc.materialLossCost + sc.processingCost);
        right.style.color = 'var(--critical)';
        head.append(left, right);
        const sub2 = document.createElement('div');
        sub2.className = 'rec-sub';
        sub2.textContent = `主料损失 ${money(sc.materialLossCost)} · 已投入加工费 ${money(sc.processingCost)} · ${sc.scrappedAt.replace('T', ' ').slice(0, 16)}`;
        li.append(head, sub2);
        ul.appendChild(li);
        card.appendChild(ul);
      }

      row.append(dot, card);
      body.appendChild(row);
    }

    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    const backdrop = $('drawer-backdrop');
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('open'));
    $('drawer-close').focus();
  }

  function idx_defectName(code) {
    return dataset.defectTypes.find((d) => d.code === code)?.name ?? code;
  }

  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    const backdrop = $('drawer-backdrop');
    backdrop.classList.remove('open');
    setTimeout(() => { backdrop.hidden = true; }, 180);
  }

  /* ---------------- 小组件 ---------------- */

  function sectionTitle(text) {
    const div = document.createElement('div');
    div.className = 'detail-section-title';
    div.textContent = text;
    return div;
  }
  function costBlock(kind, label, value, sub) {
    const div = document.createElement('div');
    div.className = `cost-block ${kind}`;
    const l = document.createElement('div');
    l.className = 'cost-sub';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'cost-num';
    v.textContent = money(value);
    const s = document.createElement('div');
    s.className = 'cost-sub';
    s.textContent = sub;
    div.append(l, v, s);
    return div;
  }
  function statusLabel(status) {
    return {
      pass: '合格',
      scrap: '已报废',
      incomplete: '追踪不完整',
      'rework-open': '返工未关闭',
    }[status] ?? status;
  }
  function statusBadge(state, step) {
    const span = document.createElement('span');
    const map = {
      pass: ['good', '首检合格'],
      'reworked-pass': ['warning', '返工后复检合格'],
      scrap: ['critical', '报废'],
      missing: ['serious', '记录缺失'],
      'rework-open': ['warning', '返工未关闭'],
      done: ['muted', '已加工'],
    };
    const [cls, label] = map[state] ?? ['neutral', state];
    span.className = `badge ${cls}`;
    span.textContent = label;
    return span;
  }
  function trackingBadge(b) {
    const wrap = document.createElement('span');
    if (!b.totals.incompleteUnits) {
      const ok = document.createElement('span');
      ok.className = 'badge good';
      ok.textContent = '完整';
      return ok;
    }
    const parts = [];
    if (b.totals.openReworkCount) parts.push(`${b.totals.openReworkCount} 件返工未关闭`);
    const missingUnits = b.totals.incompleteUnits - b.totals.openReworkCount;
    if (missingUnits) parts.push(`${missingUnits} 件缺工序记录`);
    const warn = document.createElement('span');
    warn.className = 'badge serious';
    warn.textContent = parts.join('；');
    return warn;
  }
  function routeBadge(route) {
    const span = document.createElement('span');
    span.className = 'badge neutral';
    span.textContent = `${route.version}`;
    span.title = route.changeNote;
    return span;
  }

  function td(content, isHtml = false) {
    const cell = document.createElement('td');
    if (content instanceof Node) cell.appendChild(content);
    else if (isHtml) cell.innerHTML = content;
    else cell.textContent = content;
    return cell;
  }
  function tdNum(content) {
    const cell = td(content);
    cell.className = 'num';
    return cell;
  }
  function text(s) { return document.createTextNode(s); }

  /** 通用表格视图（图表的可访问孪生） */
  function renderTable(container, headers, rows) {
    container.replaceChildren();
    const table = document.createElement('table');
    table.className = 'table-view';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    headers.forEach((h, i) => {
      const th = document.createElement('th');
      if (rows.some((r) => r[i] && typeof r[i] === 'object' && 'num' in r[i])) th.className = 'num';
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const t = document.createElement('td');
        if (cell && typeof cell === 'object' && 'num' in cell) {
          t.className = 'num';
          t.textContent = String(cell.num);
        } else {
          t.textContent = String(cell);
        }
        tr.appendChild(t);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    container.appendChild(table);
  }

  function syncToggleButtons() {
    document.querySelectorAll('.view-toggle').forEach((group) => {
      const key = group.dataset.viewKey;
      group.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === state.viewModes[key]);
      });
    });
  }

  /* ---------------- 启动 ---------------- */

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('drawer').classList.contains('open')) closeDrawer();
  });

  initTheme();
  initFilters();
  render();
})();
