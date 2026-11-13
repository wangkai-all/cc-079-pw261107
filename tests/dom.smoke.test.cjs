/**
 * 页面级 DOM 冒烟测试（jsdom，无浏览器环境）
 * 运行：NODE_PATH=/tmp/npm-prefix/node_modules node tests/dom.smoke.test.js
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
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const load = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/index.html',
});
const { window } = dom;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
window.HTMLCanvasElement;
window.eval(load('js/sample-data.js'));
window.eval(load('js/metrics.js'));
window.eval(load('js/charts.js'));
window.eval(load('js/app.js'));
const { document } = window;

test('启动后 KPI 与图表全部渲染，无空状态', () => {
  const kpis = document.querySelectorAll('#kpi-row .kpi');
  assert.equal(kpis.length, 6);
  const fpy = kpis[1].querySelector('.kpi-value').textContent;
  assert.equal(fpy, `${(68 / 89 * 100).toFixed(1)}%`);
  assert.ok(document.querySelectorAll('#defect-chart svg').length === 1);
  assert.ok(document.querySelectorAll('#opdefect-chart svg').length === 1);
  assert.ok(document.querySelectorAll('#shift-rate-chart svg').length === 1);
  assert.ok(document.querySelectorAll('#shift-cost-chart svg').length === 1);
  assert.equal(document.querySelectorAll('#batch-tbody tr.batch-row').length, 9);
});

test('筛选产品后所有视图使用同一切片', () => {
  const sel = document.getElementById('f-product');
  sel.value = 'P-A';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelectorAll('#batch-tbody tr.batch-row').length, 6);
  const kpiNote = document.querySelectorAll('#kpi-row .kpi .kpi-note')[0].textContent;
  assert.match(kpiNote, /6 个批次/);
  // 重置
  document.getElementById('f-reset').click();
  assert.equal(document.querySelectorAll('#batch-tbody tr.batch-row').length, 9);
});

test('展开批次：工序流、缺陷汇总、成本拆分、序列号芯片渲染', () => {
  const firstRow = document.querySelector('#batch-tbody tr.batch-row');
  const batchId = firstRow.getAttribute('aria-label').replace('展开批次 ', '');
  firstRow.click();
  // 点击后整表重绘，重新查询当前 DOM 中的同一行
  const row = [...document.querySelectorAll('#batch-tbody tr.batch-row')]
    .find((r) => r.getAttribute('aria-label').includes(batchId));
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  const detail = document.querySelector('.batch-detail');
  assert.ok(detail);
  assert.ok(detail.querySelectorAll('.op-node').length >= 4);
  assert.ok(detail.querySelectorAll('.cost-block').length === 2);
  const chips = detail.querySelectorAll('.unit-chip');
  assert.equal(chips.length, 10);
  // 报废芯片带 scrap 样式
  assert.ok([...chips].some((c) => c.classList.contains('scrap')));
});

test('缺失工序的批次显示虚线工序节点与严重徽标', () => {
  const rows = () => [...document.querySelectorAll('#batch-tbody tr.batch-row')];
  // 先收起仍展开的 B-1028
  const open = rows().find((r) => r.getAttribute('aria-expanded') === 'true');
  if (open) open.click();
  const b1029 = rows().find((r) => r.getAttribute('aria-label').includes('B-1029-A-02'));
  b1029.click();
  const detail = document.querySelector('.batch-detail');
  const missingNode = detail.querySelector('.op-node.missing');
  assert.ok(missingNode, 'OP40 缺失节点存在');
  assert.match(missingNode.textContent, /缺失 3 件/);
  const badge = [...document.querySelectorAll('#batch-tbody .badge.serious')]
    .find((x) => x.textContent.includes('缺工序记录'));
  assert.ok(badge);
  rows().find((r) => r.getAttribute('aria-label').includes('B-1029-A-02')).click();
});

test('点击序列号打开追溯抽屉，时间线含检验/返工/报废记录，Esc 关闭', () => {
  const rows = [...document.querySelectorAll('#batch-tbody tr.batch-row')];
  rows.find((r) => r.getAttribute('aria-label').includes('B-1028-A-01')).click();
  const chip = [...document.querySelectorAll('.unit-chip')]
    .find((c) => c.title === 'B-1028-A-01-U03');
  chip.click();
  const drawer = document.getElementById('drawer');
  assert.ok(drawer.classList.contains('open'));
  assert.equal(document.getElementById('drawer-title').textContent, 'B-1028-A-01-U03');
  const steps = drawer.querySelectorAll('.tl-step');
  assert.equal(steps.length, 4); // v1 路线 4 道工序
  const op30 = steps[2];
  assert.match(op30.textContent, /首检/);
  assert.match(op30.textContent, /第 1 次复检/);
  assert.match(op30.textContent, /第 2 次复检/);
  assert.equal(op30.querySelectorAll('.record-list li').length, 5); // 3 检验 + 2 返工
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.ok(!drawer.classList.contains('open'));
});

test('报废序列号的抽屉显示报废单与两笔成本', () => {
  const chip = [...document.querySelectorAll('.unit-chip')]
    .find((c) => c.title === 'B-1028-A-01-U05');
  chip.click();
  const drawer = document.getElementById('drawer');
  assert.match(drawer.textContent, /报废单 SC-/);
  assert.match(drawer.textContent, /主料损失/);
  assert.match(drawer.textContent, /返工单 RW-/); // 先返工后报废两笔都在
  document.getElementById('drawer-close').click();
});

test('v2 批次抽屉沿新路线展开 6 道工序，含 OP50 老化测试', () => {
  document.querySelector('#batch-tbody tr.batch-row').click(); // 收起
  const rows = [...document.querySelectorAll('#batch-tbody tr.batch-row')];
  rows.find((r) => r.getAttribute('aria-label').includes('B-1101-A-06')).click();
  const chip = [...document.querySelectorAll('.unit-chip')]
    .find((c) => c.title === 'B-1101-A-06-U01');
  chip.click();
  const steps = document.querySelectorAll('#drawer .tl-step');
  assert.equal(steps.length, 6);
  assert.match(document.getElementById('drawer-meta').textContent, /RT-A-v2/);
  document.getElementById('drawer-close').click();
});

test('图表/表格视图切换：表格孪生包含同样数据', () => {
  // 收起展开的批次
  const expanded = document.querySelector('#batch-tbody tr.batch-row[aria-expanded="true"]');
  if (expanded) expanded.click();
  const toggle = document.querySelector('.view-toggle[data-view-key="defect"]');
  toggle.querySelector('button[data-mode="table"]').click();
  const table = document.querySelector('#defect-chart table');
  assert.ok(table);
  assert.equal(table.querySelectorAll('tbody tr').length, 7); // 7 种缺陷
  toggle.querySelector('button[data-mode="chart"]').click();
  assert.ok(document.querySelector('#defect-chart svg'));
});

test('空筛选结果显示无数据而不是抛错', () => {
  document.getElementById('f-from').value = '2030-01-01';
  document.getElementById('f-from').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelectorAll('#batch-tbody tr.batch-row').length, 0);
  assert.equal(document.querySelectorAll('#kpi-row .kpi-value.empty').length, 6);
  document.getElementById('f-reset').click();
  assert.equal(document.querySelectorAll('#batch-tbody tr.batch-row').length, 9);
});

test('主题切换写入 data-theme 并可重绘', () => {
  const btn = document.getElementById('theme-toggle');
  btn.click();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.ok(document.querySelector('#defect-chart svg'));
  btn.click();
  assert.equal(document.documentElement.dataset.theme, 'light');
});
