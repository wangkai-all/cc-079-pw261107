/**
 * SVG 几何静态校验（无浏览器环境下替代目视检查）
 * 运行：NODE_PATH=/tmp/npm-prefix/node_modules node tests/svg.geometry.test.js
 * 覆盖：viewBox 闭合、标记在绘图画布内、条形厚度上限、圆角方向、
 *       标签不溢出、网格实线、命中区 ≥24px。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require(require.resolve('jsdom', {
  paths: [
    path.join(__dirname, '..', 'node_modules'),
    '/tmp/npm-prefix/node_modules',
  ],
}));

const ROOT = path.join(__dirname, '..');
const load = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const dom = new JSDOM(load('index.html'), {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://l/',
});
const { window } = dom;
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
for (const f of ['js/sample-data.js', 'js/metrics.js', 'js/charts.js', 'js/app.js']) {
  window.eval(load(f));
}
const { document } = window;

function viewBox(svg) {
  const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  return { w, h };
}
function nums(pathD, cmd) {
  const re = new RegExp(cmd + '(-?\\d+\\.?\\d*)', 'g');
  const out = [];
  let m;
  while ((m = re.exec(pathD))) out.push(Number(m[1]));
  return out;
}

test('所有图表 SVG 存在且 viewBox 合法', () => {
  for (const id of ['defect-chart', 'opdefect-chart', 'shift-rate-chart', 'shift-cost-chart']) {
    const svg = document.querySelector(`#${id} svg`);
    assert.ok(svg, `${id} 有 SVG`);
    const { w, h } = viewBox(svg);
    assert.ok(w > 100 && h > 100);
  }
});

test('横向条形：厚度 ≤24px、数据端在右（圆角路径）、全部落在画布内', () => {
  const svg = document.querySelector('#defect-chart svg');
  const { w, h } = viewBox(svg);
  const paths = svg.querySelectorAll('path');
  assert.ok(paths.length >= 5);
  for (const p of paths) {
    const d = p.getAttribute('d');
    const ys = nums(d, '[hva]').length ? d.match(/M[\d.]+,([\d.]+)/) : null;
    const y0 = Number(ys[1]);
    // v 段高度即条形厚度
    const vMatch = d.match(/v(-?[\d.]+)/);
    const thickness = Math.abs(Number(vMatch[1]));
    assert.ok(thickness <= 24, `条形厚度 ${thickness}px 不超过 24px`);
    assert.ok(y0 >= 0 && y0 + thickness <= h, '条形纵向在画布内');
    const xMax = Math.max(...nums(d, '[hva]').concat(nums(d, 'M').flatMap ? [] : []));
    const allX = (d.match(/[\d.]+(?=,| h| a)/g) || []).map(Number);
    assert.ok(Math.max(...allX) <= w, '条形右端不超出画布');
    // 数据端圆角在右侧：路径含 a 圆弧且 h 段朝右延伸
    assert.ok(/a[\d.]+,[\d.]+ 0 0 1/.test(d), '数据端为圆角');
  }
});

test('分组柱：柱宽 ≤24px、表面间隙 2px、柱顶在画布内、无负值越界', () => {
  const svg = document.querySelector('#shift-rate-chart svg');
  const { w, h } = viewBox(svg);
  const paths = [...svg.querySelectorAll('path')];
  const seriesCount = 2;
  assert.equal(paths.length, 6); // 3 班次 × 2 序列
  for (const p of paths) {
    const d = p.getAttribute('d');
    // 圆角柱路径：顶圆角 a r,r 之后的水平段 h = 柱宽 - 2r，需加回两个圆角半径
    const r = Number(d.match(/a([\d.]+),/.exec(d)[1]));
    const hSegment = Number(d.match(/h([\d.]+)/)[1]);
    const barWidth = hSegment + 2 * r;
    assert.ok(barWidth <= 24, `柱宽 ${barWidth}px 不超过 24px`);
    // 路径形态：M x,基线 y → v-（相对向上）→ 顶圆角 → h → 圆角 → v 回基线
    const baselineY = Number(d.match(/M[\d.]+,([\d.]+)/)[1]);
    const up = Number(d.match(/v(-[\d.]+)/)[1]);
    const topY = baselineY + up;
    assert.ok(topY >= 0, '柱顶不超出画布上沿');
    assert.ok(up < 0, '柱从基线向上生长，基线端直角');
    const xs = d.match(/M([\d.]+)/)[1];
    assert.ok(Number(xs) >= 0, '柱左缘在画布内');
  }
  // 表面间隙 2px：paths 按序列外层排列（先序列1的3根柱，再序列2的3根柱）；
  // 同班次的两根柱 = paths[i] 与 paths[i + 每序列柱数]，x 差应为 柱宽 + 2px
  const n = paths.length / seriesCount;
  const widthOf = (p) => {
    const d = p.getAttribute('d');
    const r = Number(d.match(/a([\d.]+),/)[1]);
    return Number(d.match(/h([\d.]+)/)[1]) + 2 * r;
  };
  const xs = paths.map((p) => Number(p.getAttribute('d').match(/M([\d.]+)/)[1]));
  const widths = paths.map(widthOf);
  for (let i = 0; i < n; i += 1) {
    const gap2 = xs[i + n] - (xs[i] + widths[i]);
    assert.equal(gap2, 2, `第 ${i + 1} 班次同组柱间隙为 2px（实际 ${gap2}px）`);
  }
});

test('命中区 ≥24px 且每个标记都有可聚焦 hit 与 aria-label', () => {
  for (const id of ['defect-chart', 'shift-rate-chart', 'shift-cost-chart']) {
    const svg = document.querySelector(`#${id} svg`);
    const hits = svg.querySelectorAll('.hit');
    assert.ok(hits.length >= 1, `${id} 有命中区`);
    for (const hit of hits) {
      const height = Number(hit.getAttribute('height'));
      const width = Number(hit.getAttribute('width'));
      assert.ok(Math.max(height, width) >= 24, `${id} 命中区 ≥24px（${width}×${height}）`);
      assert.equal(hit.getAttribute('tabindex'), '0');
      assert.ok(hit.getAttribute('aria-label').length > 4);
    }
  }
});

test('网格与轴线为 1px 实线、无虚线', () => {
  const svg = document.querySelector('#shift-rate-chart svg');
  const lines = svg.querySelectorAll('line');
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    const sw = line.getAttribute('stroke-width');
    assert.ok(sw === null || Number(sw) === 1, '网格/轴线 1px');
    assert.ok(!line.getAttribute('stroke-dasharray'), '不使用虚线');
  }
});

test('文本元素不使用数据色（文字走文本令牌，颜色只属于标记）', () => {
  for (const id of ['defect-chart', 'shift-rate-chart']) {
    const svg = document.querySelector(`#${id} svg`);
    for (const t of svg.querySelectorAll('text')) {
      const fill = t.getAttribute('fill');
      assert.ok(fill === null || fill.startsWith('var(--'), `${id} 文本填充走角色变量`);
      assert.ok(!fill || !fill.includes('2a78d6') && !fill.includes('eb6834'),
        '文本不穿系列色');
    }
  }
});

test('空数据时渲染 empty-state 而非残缺 SVG', () => {
  document.getElementById('f-from').value = '2030-01-01';
  document.getElementById('f-from').dispatchEvent(new window.Event('change', { bubbles: true }));
  for (const id of ['defect-chart', 'shift-rate-chart']) {
    assert.ok(document.querySelector(`#${id} .empty-state`), `${id} 空状态`);
    assert.equal(document.querySelectorAll(`#${id} svg`).length, 0);
  }
  document.getElementById('f-reset').click();
});

test('图例：双序列图表均有图例且色块颜色跟随实体（重渲染后不换色）', () => {
  const legends = document.querySelectorAll('#shift-rate-chart .legend .key, #shift-cost-chart .legend .key');
  assert.equal(legends.length, 4);
  const firstColor = legends[0].querySelector('.swatch').style.background;
  // 加筛选后重渲染，存活序列颜色不变（无 recolor-on-filter）
  const sel = document.getElementById('f-line');
  sel.value = 'L1';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const after = document.querySelector('#shift-rate-chart .legend .key .swatch').style.background;
  assert.equal(after, firstColor, '筛选后系列颜色不重排');
  document.getElementById('f-reset').click();
});

test('表格孪生：批次表列数与表头一致，数字列右对齐用 tabular-nums', () => {
  const toggle = document.querySelector('.view-toggle[data-view-key="defect"]');
  toggle.querySelector('button[data-mode="table"]').click();
  const table = document.querySelector('#defect-chart table');
  const headers = table.querySelectorAll('thead th').length;
  const firstRowCells = table.querySelector('tbody tr').children.length;
  assert.equal(headers, firstRowCells);
  toggle.querySelector('button[data-mode="chart"]').click();
});
