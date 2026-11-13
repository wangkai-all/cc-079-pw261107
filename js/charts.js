/**
 * 手写 SVG 图表（零依赖）
 *
 * 规范遵循 dataviz：
 *  - 条形 ≤24px 厚，数据端 4px 圆角、基线端直角；
 *  - 2px 表面色间隙；网格/轴线 1px 实线、退居底色；
 *  - 单序列统一用 series-1，不按数值排名上色；双序列固定蓝/橙，颜色跟随实体；
 *  - 每个标记有 ≥24px 命中区 + tooltip，且支持键盘 focus；
 *  - 所有图表另有表格视图孪生，tooltip 不承担唯一读数通道。
 */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const Charts = {};

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    return el;
  }

  function niceMax(value) {
    if (value <= 0) return 1;
    const exp = Math.floor(Math.log10(value));
    const base = 10 ** exp;
    const f = value / base;
    const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return step * base;
  }

  /** 全局 tooltip（一个实例，所有图表共用） */
  const tooltip = (() => {
    let el = null;
    function ensure() {
      if (!el) {
        el = document.createElement('div');
        el.className = 'tooltip';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
      }
      return el;
    }
    function show(x, y, rows) {
      const node = ensure();
      node.replaceChildren();
      const title = document.createElement('div');
      title.className = 'tt-title';
      title.textContent = rows.title;
      node.appendChild(title);
      for (const r of rows.items) {
        const row = document.createElement('div');
        row.className = 'tt-row';
        if (r.color) {
          const key = document.createElement('span');
          key.className = 'line-key';
          key.style.background = r.color;
          row.appendChild(key);
        }
        const name = document.createElement('span');
        name.textContent = r.name;
        const val = document.createElement('span');
        val.className = 'tt-val';
        val.textContent = r.value;
        row.append(name, val);
        node.appendChild(row);
      }
      node.classList.add('show');
      const rect = node.getBoundingClientRect();
      const px = Math.min(x + 14, window.innerWidth - rect.width - 10);
      const py = Math.max(8, Math.min(y - rect.height - 12, window.innerHeight - rect.height - 10));
      node.style.left = `${Math.max(8, px)}px`;
      node.style.top = `${py}px`;
    }
    function hide() { if (el) el.classList.remove('show'); }
    return { show, hide };
  })();

  function bindHit(hit, rows) {
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('role', 'img');
    const label = `${rows.title}，${rows.items.map((r) => `${r.name} ${r.value}`).join('，')}`;
    hit.setAttribute('aria-label', label);
    hit.addEventListener('pointermove', (e) => tooltip.show(e.clientX, e.clientY, rows));
    hit.addEventListener('pointerleave', tooltip.hide);
    hit.addEventListener('focus', () => {
      const r = hit.getBoundingClientRect();
      tooltip.show(r.left + r.width / 2, r.top + r.height / 2, rows);
    });
    hit.addEventListener('blur', tooltip.hide);
  }

  /**
   * 横向排名条形（单序列、单色相）
   * rows: [{ label, value, display, tooltipExtra? }]
   */
  Charts.horizontalBars = function (container, rows, opts = {}) {
    container.replaceChildren();
    if (!rows.length) { empty(container, opts.emptyText || '当前筛选下没有数据'); return; }
    const W = 560;
    const labelW = opts.labelW ?? 132;
    const valueW = opts.valueW ?? 64;
    const barH = Math.min(22, opts.barH ?? 22);
    const rowH = 38;
    const padT = 6;
    const H = padT + rows.length * rowH + 8;
    const plotX = labelW;
    const plotW = W - labelW - valueW - 8;
    const maxV = Math.max(...rows.map((r) => r.value));
    const color = cssVar('--series-1');
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group' });

    rows.forEach((r, i) => {
      const y = padT + i * rowH + (rowH - barH) / 2;
      const w = maxV > 0 ? Math.max(2, (r.value / maxV) * plotW) : 0;

      // 类别名
      const label = svgEl('text', { x: labelW - 10, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'cat-label' });
      label.textContent = r.label.length > 9 ? `${r.label.slice(0, 8)}…` : r.label;
      svg.appendChild(label);

      // 轨道（同色系浅轨，meter 语义）
      svg.appendChild(svgEl('rect', {
        x: plotX, y, width: plotW, height: barH, rx: 4,
        fill: cssVar('--surface-2'),
      }));
      // 数据条：数据端圆角、基线端直角 → path
      const bar = svgEl('path', {
        d: roundedRightPath(plotX, y, w, barH, 4),
        fill: color,
        class: 'mark',
      });
      svg.appendChild(bar);

      const val = svgEl('text', { x: plotX + w + 7, y: y + barH / 2 + 4, class: 'bar-label' });
      val.textContent = r.display;
      svg.appendChild(val);

      const hit = svgEl('rect', { x: 0, y: padT + i * rowH, width: W, height: rowH, class: 'hit' });
      bindHit(hit, {
        title: r.label,
        items: [{ name: opts.measureName || '数量', value: r.display, color }, ...(r.tooltipExtra || [])],
      });
      svg.appendChild(hit);
    });

    container.appendChild(svg);
  };

  function roundedRightPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2);
    return `M${x},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr} z`;
  }

  /**
   * 分组柱状图（最多 2 序列，颜色固定跟随实体）
   * categories: [{ label, hint? }]
   * series: [{ key, name, colorVar, values: number[], displays: string[] }]
   */
  Charts.groupedColumns = function (container, categories, series, opts = {}) {
    container.replaceChildren();
    if (!categories.length) { empty(container, '当前筛选下没有数据'); return; }
    const W = 560;
    const H = 300;
    const m = { top: 18, right: 12, bottom: 46, left: 48 };
    const plotW = W - m.left - m.right;
    const plotH = H - m.top - m.bottom;
    const isPercent = opts.percent !== false;
    const maxV = isPercent ? 1 : niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group' });

    // 网格 + y 轴刻度
    const ticks = isPercent ? [0, 0.25, 0.5, 0.75, 1] : 4;
    const tickVals = isPercent ? ticks : Array.from({ length: ticks + 1 }, (_, i) => (maxV / ticks) * i);
    for (const tv of tickVals) {
      const y = m.top + plotH - (tv / maxV) * plotH;
      svg.appendChild(svgEl('line', {
        x1: m.left, x2: m.left + plotW, y1: y, y2: y, class: 'grid-line',
      }));
      const t = svgEl('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick-label' });
      t.textContent = isPercent ? `${Math.round(tv * 100)}%` : compact(tv);
      svg.appendChild(t);
    }
    svg.appendChild(svgEl('line', {
      x1: m.left, x2: m.left, y1: m.top, y2: m.top + plotH, class: 'axis-line',
    }));

    const band = plotW / categories.length;
    // 柱宽先按 band 比例求并限制 ≤24px；实际组宽由柱宽反推，
    // 保证同组柱始终以 2px 表面间隙紧贴、整组在 band 内居中
    const gap = 2;
    const wantedGroupW = band * 0.62;
    const barW = Math.min(24, (wantedGroupW - gap * (series.length - 1)) / series.length);
    const groupW = barW * series.length + gap * (series.length - 1);

    // 先画完全部柱（序列外层、班次内层），保证同班次的同组柱在 DOM 中相邻；
    // 命中区之后单独叠加，避免打断同组柱
    series.forEach((sr, si) => {
      categories.forEach((cat, ci) => {
        const cx = m.left + band * ci + band / 2;
        const v = sr.values[ci] ?? 0;
        const h = maxV > 0 ? (v / maxV) * plotH : 0;
        const x = cx - groupW / 2 + si * (barW + gap);
        const color = cssVar(sr.colorVar);
        if (v !== null && h > 0) {
          // 柱：顶端 4px 圆角，基线端直角
          const rr = Math.min(4, barW / 2, h);
          svg.appendChild(svgEl('path', {
            d: `M${x},${m.top + plotH} v-${h - rr} a${rr},${rr} 0 0 1 ${rr},-${rr} h${barW - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} z`,
            fill: color,
            class: 'mark',
          }));
        }
      });
    });

    // 命中区与类别标签按班次叠加（每个 band 一个命中区，覆盖整组柱）
    categories.forEach((cat, ci) => {
      const cx = m.left + band * ci + band / 2;
      const hit = svgEl('rect', {
        x: cx - band / 2, y: m.top, width: band, height: plotH, class: 'hit',
      });
      bindHit(hit, {
        title: cat.label + (cat.hint ? `（${cat.hint}）` : ''),
        items: series.map((s2) => ({
          name: s2.name,
          value: s2.displays[ci] ?? '—',
          color: cssVar(s2.colorVar),
        })),
      });
      svg.appendChild(hit);

      const t = svgEl('text', {
        x: cx, y: m.top + plotH + 18, 'text-anchor': 'middle', class: 'cat-label',
      });
      t.textContent = cat.label;
      svg.appendChild(t);
      if (cat.hint) {
        const t2 = svgEl('text', {
          x: cx, y: m.top + plotH + 33, 'text-anchor': 'middle', class: 'tick-label',
        });
        t2.textContent = cat.hint;
        svg.appendChild(t2);
      }
    });

    container.appendChild(svg);

    // 图例（≥2 序列必备）
    if (series.length >= 2) {
      const legend = document.createElement('div');
      legend.className = 'legend';
      for (const sr of series) {
        const key = document.createElement('span');
        key.className = 'key';
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = cssVar(sr.colorVar);
        const name = document.createElement('span');
        name.textContent = sr.name;
        key.append(sw, name);
        legend.appendChild(key);
      }
      container.appendChild(legend);
    }
  };

  /**
   * 成本分组柱（金额单轴，单位元；返工/报废双序列）
   */
  Charts.costColumns = function (container, categories, reworkValues, scrapValues, opts = {}) {
    const fmt = (n) => `¥${compact(n)}`;
    return Charts.groupedColumns(container, categories, [
      {
        key: 'rework', name: '返工成本', colorVar: '--series-1',
        values: reworkValues, displays: reworkValues.map(fmt),
      },
      {
        key: 'scrap', name: '报废成本', colorVar: '--series-2',
        values: scrapValues, displays: scrapValues.map(fmt),
      },
    ], { percent: false, ...opts });
  };

  function compact(n) {
    const abs = Math.abs(n);
    if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
    if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
    if (Number.isInteger(n)) return n.toLocaleString('zh-CN');
    return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  }

  function empty(container, text) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = text;
    container.appendChild(div);
  }

  Charts.tooltip = tooltip;
  root.QACharts = Charts;
})(typeof globalThis !== 'undefined' ? globalThis : this);
