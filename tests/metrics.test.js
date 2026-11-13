/**
 * 指标引擎业务规则测试
 * 运行：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 以经典脚本方式加载 metrics.js + sample-data.js（与 index.html 同一加载路径） */
const sandbox = { window: {}, globalThis: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'js', 'sample-data.js'), 'utf8'), sandbox);
vm.runInContext(readFileSync(join(ROOT, 'js', 'metrics.js'), 'utf8'), sandbox);
const QAM = sandbox.QAMetrics;
const dataset = sandbox.window.QA_SAMPLE;

/** vm 沙箱产出的数组/对象原型与主 realm 不同，结构断言用 JSON 归一化 */
const deepEq = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

const idx = QAM.buildIndex(dataset);

/** 手算期望值（生成器场景表逐一核对，见 tools/generate-sample.mjs） */
const EXPECTED = {
  'B-1028-A-01': { total: 10, evaluable: 10, fpy: 0.6, finalYield: 0.9, reworks: 5, scrap: 1, defects: 4 },
  'B-1029-A-02': { total: 10, evaluable: 7, fpy: 5 / 7, finalYield: 1, reworks: 2, scrap: 0, defects: 2 },
  'B-1030-A-03': { total: 10, evaluable: 10, fpy: 0.7, finalYield: 0.8, reworks: 2, scrap: 2, defects: 3 },
  'B-1030-B-04': { total: 12, evaluable: 12, fpy: 0.75, finalYield: 1, reworks: 4, scrap: 0, defects: 4 },
  'B-1031-B-05': { total: 12, evaluable: 11, fpy: 8 / 11, finalYield: 9 / 11, reworks: 5, scrap: 2, defects: 5 },
  'B-1101-A-06': { total: 10, evaluable: 10, fpy: 0.8, finalYield: 0.9, reworks: 2, scrap: 1, defects: 3 },
  'B-1102-A-07': { total: 10, evaluable: 7, fpy: 5 / 7, finalYield: 6 / 7, reworks: 2, scrap: 1, defects: 2 },
  'B-1103-B-08': { total: 12, evaluable: 12, fpy: 11 / 12, finalYield: 1, reworks: 1, scrap: 0, defects: 1 },
  'B-1104-A-09': { total: 10, evaluable: 10, fpy: 0.9, finalYield: 1, reworks: 1, scrap: 0, defects: 1 },
};

test('所有批次的手算口径与引擎输出一致', () => {
  for (const [batchId, e] of Object.entries(EXPECTED)) {
    const b = QAM.evaluateBatch(dataset, idx, batchId);
    assert.equal(b.totals.totalUnits, e.total, `${batchId} 总数`);
    assert.equal(b.totals.evaluableUnits, e.evaluable, `${batchId} 可评估数`);
    assert.ok(Math.abs(b.rates.fpy - e.fpy) < 1e-12, `${batchId} FPY`);
    assert.ok(Math.abs(b.rates.finalYield - e.finalYield) < 1e-12, `${batchId} 最终良率`);
    assert.equal(b.totals.reworkCount, e.reworks, `${batchId} 返工数`);
    assert.equal(b.totals.scrapCount, e.scrap, `${batchId} 报废数`);
    assert.equal(b.totals.defectEventCount, e.defects, `${batchId} 缺陷事件数`);
  }
});

test('同一件产品多次复检不重复计入产量（B-1028-A-01 / U03 两轮返工三次检验）', () => {
  const b = QAM.evaluateBatch(dataset, idx, 'B-1028-A-01');
  assert.equal(b.totals.totalUnits, 10);
  const u3 = b.unitResults.find((u) => u.serialId === 'B-1028-A-01-U03');
  assert.equal(u3.isFirstPass, false);
  assert.equal(u3.finalStatus, 'pass'); // 两次返工后复检通过
  assert.equal(u3.reworkCount, 2);
  const insp = dataset.inspections
    .filter((i) => i.serialId === 'B-1028-A-01-U03' && i.opId === 'OP30')
    .sort((a, b2) => a.seqNo - b2.seqNo);
  // 首检失败 → 复检仍失败 → 二次复检通过（同一工序内 seqNo 1/2/3）
  deepEq(insp.map((i) => [i.seqNo, i.result]),
    [[1, 'fail'], [2, 'fail'], [3, 'pass']]);
  // 该序列号在产量中只出现一次
  assert.equal(dataset.units.filter((u) => u.serialId === 'B-1028-A-01-U03').length, 1);
});

test('报废与返工成本分别归集；先返工后报废的序列号两笔成本都保留', () => {
  const b = QAM.evaluateBatch(dataset, idx, 'B-1028-A-01');
  assert.ok(b.costs.rework.total > 0);
  assert.ok(b.costs.scrap.total > 0);
  assert.ok(
    Math.abs(b.costs.total - (b.costs.rework.total + b.costs.scrap.total)) < 1e-9,
    '总成本 = 返工 + 报废',
  );
  // U05：rework-scrap，同时出现在返工和报废中
  const rw = dataset.reworkRecords.find((r) => r.serialId === 'B-1028-A-01-U05');
  const sc = dataset.scrapRecords.find((s) => s.serialId === 'B-1028-A-01-U05');
  assert.ok(rw && sc);
  assert.ok(Math.abs(rw.totalCost - (rw.laborCost + rw.materialCost)) < 1e-9);
  assert.ok(Math.abs(sc.materialLossCost + sc.processingCost
    - (b.costs.scrap.materialLoss + b.costs.scrap.processing)) < 1e-9);
  // 返工成本手算：D06 密封失效 40 分钟 × 65 元/时 + 35 辅料
  assert.equal(rw.laborMinutes, 40);
  assert.equal(rw.laborCost, Math.round((40 / 60) * 65 * 100) / 100);
  assert.equal(rw.materialCost, 35);
});

test('缺失工序记录 → 追踪不完整：剔除评估分母并显式标记缺失工序', () => {
  const b2 = QAM.evaluateBatch(dataset, idx, 'B-1029-A-02');
  assert.equal(b2.totals.incompleteUnits, 3);
  assert.equal(b2.rates.completeness, 0.7);
  const missing = b2.missingOpReport.find((m) => m.opId === 'OP40');
  assert.ok(missing, 'OP40 缺失被显式列出');
  deepEq(missing.serialIds,
    ['B-1029-A-02-U08', 'B-1029-A-02-U09', 'B-1029-A-02-U10']);
  for (const sn of missing.serialIds) {
    const u = b2.unitResults.find((x) => x.serialId === sn);
    assert.equal(u.evaluable, false);
    deepEq(u.missingOps, ['OP40']);
  }
  // 不完整批次仍可算良率，分母只用 7 个可评估序列号
  assert.equal(b2.rates.finalYield, 1);

  const b7 = QAM.evaluateBatch(dataset, idx, 'B-1102-A-07');
  deepEq(b7.missingOpReport.map((m) => m.opId), ['OP15']);
});

test('未关闭返工 → 追踪不完整（B-1031-B-05 / U04）', () => {
  const b = QAM.evaluateBatch(dataset, idx, 'B-1031-B-05');
  const u4 = b.unitResults.find((u) => u.serialId === 'B-1031-B-05-U04');
  assert.equal(u4.finalStatus, 'rework-open');
  assert.equal(u4.evaluable, false);
  assert.equal(b.totals.openReworkCount, 1);
});

test('工艺路线变更后按生产当时路线解释旧数据（v1 批次不含 OP15/OP50）', () => {
  const oldBatch = QAM.evaluateBatch(dataset, idx, 'B-1028-A-01');
  const newBatch = QAM.evaluateBatch(dataset, idx, 'B-1101-A-06');
  assert.equal(oldBatch.route.routeId, 'RT-A-v1');
  assert.equal(newBatch.route.routeId, 'RT-A-v2');
  deepEq(oldBatch.route.operations.map((o) => o.opId),
    ['OP10', 'OP20', 'OP30', 'OP40']);
  deepEq(newBatch.route.operations.map((o) => o.opId),
    ['OP10', 'OP15', 'OP20', 'OP30', 'OP40', 'OP50']);
  // 旧批次的检验/报工中绝不出现新工序
  const oldOpIds = new Set(oldBatch.route.operations.map((o) => o.opId));
  for (const ins of dataset.inspections.filter((i) => i.batchId === 'B-1028-A-01')) {
    assert.ok(oldOpIds.has(ins.opId));
  }
  // 工序级 FPY 按各自路线的工序名解释
  deepEq(oldBatch.operationFpy.map((o) => o.opId), ['OP30', 'OP40']);
  deepEq(newBatch.operationFpy.map((o) => o.opId), ['OP30', 'OP40', 'OP50']);
  // OP50 老化测试是 v2 新增缺陷来源
  const op50 = newBatch.operationFpy.find((o) => o.opId === 'OP50');
  assert.equal(op50.firstFailed, 2);
});

test('全量汇总：去重分母、FPY/最终良率、成本分离', () => {
  const s = QAM.summarize(dataset, {});
  assert.equal(s.totals.totalUnits, 96);
  assert.equal(s.totals.evaluableUnits, 89); // 96 - 6 缺报工 - 1 未关闭返工
  assert.equal(s.totals.incompleteUnits, 7);
  assert.equal(s.totals.scrapCount, 7);
  assert.equal(s.totals.reworkCount, 24);
  assert.equal(s.totals.defectEventCount, 25); // 仅首检失败；复检失败不重复计
  assert.ok(Math.abs(s.rates.fpy - 68 / 89) < 1e-12);
  assert.ok(Math.abs(s.rates.finalYield - 82 / 89) < 1e-12);
  assert.ok(Math.abs(s.rates.completeness - 89 / 96) < 1e-12);
  assert.ok(
    Math.abs(s.costs.total - (s.costs.rework.total + s.costs.scrap.total)) < 1e-9,
  );
  // 缺陷分布计数之和 = 首检缺陷事件总数（复检失败不重复计入）
  assert.equal(s.defectDistribution.reduce((x, d) => x + d.count, 0), 25);
});

test('按产品/产线/班次过滤后所有视图使用同一切片', () => {
  const motor = QAM.summarize(dataset, { productId: 'P-A' });
  assert.equal(motor.totals.batchCount, 6);
  assert.equal(motor.totals.totalUnits, 60);
  assert.ok(motor.batches.every((b) => b.workOrder.productId === 'P-A'));

  const night = QAM.summarize(dataset, { shiftId: 'S3' });
  assert.equal(night.totals.batchCount, 3);
  deepEq(night.shiftComparison.map((x) => x.shiftId), ['S3']);

  const line2 = QAM.summarize(dataset, { lineId: 'L2' });
  assert.equal(line2.totals.totalUnits, 36);
});

test('日期过滤：11 月数据只包含 v2 电机批次与 B 产品批次', () => {
  const nov = QAM.summarize(dataset, { dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  deepEq(nov.batches.map((b) => b.batchId).sort(),
    ['B-1101-A-06', 'B-1102-A-07', 'B-1103-B-08', 'B-1104-A-09']);
});

test('班次对比结构：FPY/最终良率与成本两类度量分图、不共用双轴', () => {
  const s = QAM.summarize(dataset, {});
  const ids = s.shiftComparison.map((x) => x.shiftId).sort();
  deepEq(ids, ['S1', 'S2', 'S3']);
  for (const row of s.shiftComparison) {
    for (const k of ['fpy', 'finalYield', 'reworkCost', 'scrapCost']) {
      assert.ok(row[k] !== undefined);
    }
  }
});

test('追溯时间线：序列号沿绑定路线展开，缺记录/报废/复检状态正确', () => {
  const tl = QAM.unitTimeline(dataset, idx, 'B-1028-A-01-U03');
  assert.equal(tl.route.routeId, 'RT-A-v1');
  assert.equal(tl.finalStatus, 'pass');
  const op30 = tl.steps.find((s2) => s2.op.opId === 'OP30');
  assert.equal(op30.state, 'reworked-pass');
  assert.equal(op30.inspections.length, 3);
  assert.equal(op30.reworks.length, 2);

  const scrap5 = QAM.unitTimeline(dataset, idx, 'B-1028-A-01-U05');
  assert.equal(scrap5.finalStatus, 'scrap');
  assert.ok(scrap5.scrapCost > 0);
  const op40 = scrap5.steps.find((s2) => s2.op.opId === 'OP40');
  assert.equal(op40.state, 'scrap');

  const missing = QAM.unitTimeline(dataset, idx, 'B-1029-A-02-U08');
  const missingStep = missing.steps.find((s2) => s2.op.opId === 'OP40');
  assert.equal(missingStep.state, 'missing');
  assert.equal(missing.evaluable, false);
});

test('返工成本与报废成本不交叉：报废记录不计入返工合计字段', () => {
  const s = QAM.summarize(dataset, {});
  const reworkSum = dataset.reworkRecords.reduce((x, r) => x + r.totalCost, 0);
  const scrapSum = dataset.scrapRecords.reduce((x, r) => x + r.materialLossCost + r.processingCost, 0);
  assert.ok(Math.abs(s.costs.rework.total - Math.round(reworkSum * 100) / 100) < 1e-9);
  assert.ok(Math.abs(s.costs.scrap.total - Math.round(scrapSum * 100) / 100) < 1e-9);
});

test('空过滤结果返回零值结构而不是抛错', () => {
  const empty = QAM.summarize(dataset, { dateFrom: '2030-01-01', dateTo: '2030-12-31' });
  assert.equal(empty.totals.batchCount, 0);
  assert.equal(empty.totals.totalUnits, 0);
  assert.equal(empty.rates.fpy, null);
  assert.equal(empty.costs.total, 0);
});
