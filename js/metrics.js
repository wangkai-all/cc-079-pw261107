/**
 * 生产质量指标引擎（纯函数、零依赖）
 *
 * 口径要点（与 README 一致）：
 *  1. 产量按序列号（serialId）去重：同一序列号多次首检/复检只算一个产品；
 *  2. 一次通过率 FPY = 评估口径内无任何首检失败记录的序列号 / 可评估序列号；
 *  3. 最终良率 = 最终状态为合格的序列号 / 可评估序列号；
 *  4. 报废成本与返工成本分别归集；先返工后报废的序列号，两笔成本各自保留；
 *  5. 报工/检验缺失、返工未关闭 → 追踪不完整，剔除出评估分母并显式标记；
 *  6. 工序解释一律取工单创建时绑定的 routeId 快照，不按现行路线重算历史批次。
 */
(function (root) {
  'use strict';

  const QAM = {};

  /* ---------------- 索引 ---------------- */

  function buildIndex(dataset) {
    const byId = (list, key = 'id') => new Map(list.map((x) => [x[key], x]));
    // 工单在引擎内一律按 batchId 索引（一个批次对应一张工单）
    const workOrders = new Map(dataset.workOrders.map((x) => [x.batchId, x]));
    const routes = byId(dataset.routes, 'routeId');
    const products = byId(dataset.products);
    const lines = byId(dataset.lines);
    const shifts = byId(dataset.shifts);
    const defects = byId(dataset.defectTypes, 'code');

    const unitsByBatch = new Map();
    const unitById = new Map();
    for (const u of dataset.units) {
      unitById.set(u.serialId, u);
      push(unitsByBatch, u.batchId, u);
    }

    const reportsByBatchOp = new Map(); // batchId|opId -> report
    const reportOpSerials = new Map();  // batchId|opId -> Set<serialId>
    for (const r of dataset.operationReports) {
      reportsByBatchOp.set(key(r.batchId, r.opId), r);
      reportOpSerials.set(key(r.batchId, r.opId), new Set(r.serialIds));
    }

    const inspectionsBySerial = new Map();
    for (const i of dataset.inspections) {
      push(inspectionsBySerial, i.serialId, i);
    }
    for (const list of inspectionsBySerial.values()) {
      list.sort((a, b) => {
        const ra = routeOf(dataset, a.batchId);
        const sa = ra.operations.find((o) => o.opId === a.opId).seq;
        const sb = ra.operations.find((o) => o.opId === b.opId).seq;
        return sa - sb || a.seqNo - b.seqNo || a.inspectedAt.localeCompare(b.inspectedAt);
      });
    }

    const reworksBySerial = new Map();
    const reworksByBatch = new Map();
    for (const r of dataset.reworkRecords) {
      push(reworksBySerial, r.serialId, r);
      push(reworksByBatch, r.batchId, r);
    }

    const scrapBySerial = new Map();
    const scrapByBatch = new Map();
    for (const s of dataset.scrapRecords) {
      scrapBySerial.set(s.serialId, s);
      push(scrapByBatch, s.batchId, s);
    }

    return {
      workOrders, routes, products, lines, shifts, defects,
      unitsByBatch, unitById, reportsByBatchOp, reportOpSerials,
      inspectionsBySerial, reworksBySerial, reworksByBatch,
      scrapBySerial, scrapByBatch,
    };
  }

  function push(map, k, v) {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }
  function key(batchId, opId) { return `${batchId}|${opId}`; }

  function routeOf(dataset, batchId) {
    const wo = dataset.workOrders.find((w) => w.batchId === batchId);
    return dataset.routes.find((r) => r.routeId === wo.routeId);
  }

  QAM.buildIndex = buildIndex;

  /* ---------------- 过滤 ---------------- */

  const DEFAULT_FILTERS = {
    productId: 'ALL',
    lineId: 'ALL',
    shiftId: 'ALL',
    dateFrom: null, // 'YYYY-MM-DD'（含）
    dateTo: null,   // 'YYYY-MM-DD'（含），按工单创建日期过滤
  };

  function filterWorkOrders(dataset, filters) {
    const f = { ...DEFAULT_FILTERS, ...filters };
    return dataset.workOrders.filter((wo) => {
      if (f.productId !== 'ALL' && wo.productId !== f.productId) return false;
      if (f.lineId !== 'ALL' && wo.lineId !== f.lineId) return false;
      if (f.shiftId !== 'ALL' && wo.shiftId !== f.shiftId) return false;
      const d = wo.createdAt.slice(0, 10);
      if (f.dateFrom && d < f.dateFrom) return false;
      if (f.dateTo && d > f.dateTo) return false;
      return true;
    });
  }
  QAM.filterWorkOrders = filterWorkOrders;

  /* ---------------- 单批次评估 ---------------- */

  function evaluateBatch(dataset, idx, batchId) {
    const wo = idx.workOrders.get(batchId);
    const route = idx.routes.get(wo.routeId); // 历史路线快照绑定
    const units = idx.unitsByBatch.get(batchId) ?? [];
    const unitResults = [];

    const missingOpReport = []; // {opId, serialIds[]}
    const opAgg = new Map(route.operations.map((o) => [o.opId, {
      opId: o.opId, name: o.name, seq: o.seq, inspectionPoint: o.inspectionPoint,
      firstInspected: 0, firstPassed: 0, firstFailed: 0,
    }]));

    let firstPassCount = 0;
    let finalPassCount = 0;
    let evaluableCount = 0;
    let incompleteCount = 0;
    let scrapCount = 0;
    let openReworkCount = 0;
    let reinspectionCount = 0;
    let reinspectionPassCount = 0;

    for (const unit of units) {
      const serialId = unit.serialId;
      const inspections = (idx.inspectionsBySerial.get(serialId) ?? [])
        .filter((x) => x.batchId === batchId);
      const scrap = idx.scrapBySerial.get(serialId) ?? null;
      const reworks = (idx.reworksBySerial.get(serialId) ?? [])
        .filter((x) => x.batchId === batchId);
      const openRework = reworks.find((r) => r.status === 'open') ?? null;

      // 终止工序：报废/未关闭返工之后的工序不再期望有记录
      const terminalOpId = scrap ? scrap.fromOpId : openRework ? openRework.fromOpId : null;
      const terminalSeq = terminalOpId
        ? route.operations.find((o) => o.opId === terminalOpId).seq
        : Infinity;

      const missingOps = [];
      for (const op of route.operations) {
        if (op.seq > terminalSeq) break;
        const set = idx.reportOpSerials.get(key(batchId, op.opId));
        if (!set || !set.has(serialId)) missingOps.push(op.opId);
      }
      if (missingOps.length) {
        for (const opId of missingOps) {
          let row = missingOpReport.find((m) => m.opId === opId);
          if (!row) { row = { opId, serialIds: [] }; missingOpReport.push(row); }
          row.serialIds.push(serialId);
        }
      }

      const firstFails = inspections.filter((x) => x.seqNo === 1 && x.result === 'fail');
      const isFirstPass = firstFails.length === 0;

      // 末道检验点是否有结论（报废视同已有终态结论；未关闭返工没有）
      const lastInspectionOp = [...route.operations].reverse().find((o) => o.inspectionPoint);
      let hasFinalInspection = false;
      if (scrap) {
        hasFinalInspection = true;
      } else if (!openRework) {
        const lastRecs = inspections.filter((x) => x.opId === lastInspectionOp.opId);
        hasFinalInspection = lastRecs.length > 0 && lastRecs[lastRecs.length - 1].result === 'pass';
      }

      const coverageComplete = missingOps.length === 0;
      const evaluable = coverageComplete && hasFinalInspection;

      let finalStatus;
      if (!coverageComplete || !hasFinalInspection) finalStatus = 'incomplete';
      else if (scrap) finalStatus = 'scrap';
      else finalStatus = 'pass';
      if (openRework && finalStatus === 'incomplete') finalStatus = 'rework-open';

      if (evaluable) {
        evaluableCount += 1;
        if (isFirstPass) firstPassCount += 1;
        if (finalStatus === 'pass') finalPassCount += 1;
      } else {
        incompleteCount += 1;
      }
      if (scrap) scrapCount += 1;
      if (openRework) openReworkCount += 1;

      // 工序级首检（仅统计有首检记录的序列号；缺记录的工序由完整性标记承担）
      for (const ins of inspections.filter((x) => x.seqNo === 1)) {
        const agg = opAgg.get(ins.opId);
        agg.firstInspected += 1;
        if (ins.result === 'pass') agg.firstPassed += 1;
        else agg.firstFailed += 1;
      }
      reinspectionCount += inspections.filter((x) => x.seqNo >= 2).length;
      reinspectionPassCount += inspections.filter((x) => x.seqNo >= 2 && x.result === 'pass').length;

      unitResults.push({
        serialId, evaluable, finalStatus, isFirstPass,
        missingOps, scrap: !!scrap, openRework: !!openRework,
        reworkCount: reworks.length,
        defectCount: firstFails.length,
      });
    }

    const batchReworks = idx.reworksByBatch.get(batchId) ?? [];
    const batchScraps = idx.scrapByBatch.get(batchId) ?? [];
    const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

    const costs = {
      rework: {
        labor: round2(sum(batchReworks, (r) => r.laborCost)),
        material: round2(sum(batchReworks, (r) => r.materialCost)),
        total: round2(sum(batchReworks, (r) => r.totalCost)),
      },
      scrap: {
        materialLoss: round2(sum(batchScraps, (s) => s.materialLossCost)),
        processing: round2(sum(batchScraps, (s) => s.processingCost)),
        total: round2(sum(batchScraps, (s) => s.materialLossCost + s.processingCost)),
      },
    };
    costs.total = round2(costs.rework.total + costs.scrap.total);

    const operationFpy = route.operations
      .filter((o) => o.inspectionPoint)
      .map((o) => {
        const a = opAgg.get(o.opId);
        return {
          opId: o.opId, name: o.name, seq: o.seq,
          firstInspected: a.firstInspected,
          firstPassed: a.firstPassed,
          firstFailed: a.firstFailed,
          fpy: a.firstInspected ? a.firstPassed / a.firstInspected : null,
        };
      });

    const pct = (n, d) => (d ? n / d : null);

    return {
      batchId,
      workOrder: wo,
      route,
      totals: {
        totalUnits: units.length,
        evaluableUnits: evaluableCount,
        incompleteUnits: incompleteCount,
        firstPassCount,
        finalPassCount,
        scrapCount,
        openReworkCount,
        reworkCount: batchReworks.length,
        defectEventCount: sum(unitResults, (u) => u.defectCount),
        reinspectionCount,
        reinspectionPassCount,
      },
      rates: {
        fpy: pct(firstPassCount, evaluableCount),
        finalYield: pct(finalPassCount, evaluableCount),
        completeness: pct(evaluableCount, units.length),
        reinspectionPassRate: pct(reinspectionPassCount, reinspectionCount),
      },
      costs,
      operationFpy,
      missingOpReport: missingOpReport
        .map((m) => ({
          opId: m.opId,
          name: route.operations.find((o) => o.opId === m.opId).name,
          serialIds: m.serialIds,
        }))
        .sort((a, b) => route.operations.find((o) => o.opId === a.opId).seq
          - route.operations.find((o) => o.opId === b.opId).seq),
      unitResults,
    };
  }
  QAM.evaluateBatch = evaluateBatch;

  /* ---------------- 总览汇总 ---------------- */

  function summarize(dataset, filters) {
    const idx = buildIndex(dataset);
    const wos = filterWorkOrders(dataset, filters);
    const batchIds = wos.map((w) => w.batchId);
    const batches = batchIds.map((id) => evaluateBatch(dataset, idx, id));

    const sumKey = (f) => batches.reduce((s, b) => s + f(b), 0);
    const t = (b) => b.totals;

    const totals = {
      batchCount: batches.length,
      totalUnits: sumKey((b) => t(b).totalUnits),
      evaluableUnits: sumKey((b) => t(b).evaluableUnits),
      incompleteUnits: sumKey((b) => t(b).incompleteUnits),
      firstPassCount: sumKey((b) => t(b).firstPassCount),
      finalPassCount: sumKey((b) => t(b).finalPassCount),
      scrapCount: sumKey((b) => t(b).scrapCount),
      openReworkCount: sumKey((b) => t(b).openReworkCount),
      reworkCount: sumKey((b) => t(b).reworkCount),
      defectEventCount: sumKey((b) => t(b).defectEventCount),
      reinspectionCount: sumKey((b) => t(b).reinspectionCount),
      reinspectionPassCount: sumKey((b) => t(b).reinspectionPassCount),
    };

    const costs = {
      rework: {
        labor: round2(sumKey((b) => b.costs.rework.labor)),
        material: round2(sumKey((b) => b.costs.rework.material)),
        total: round2(sumKey((b) => b.costs.rework.total)),
      },
      scrap: {
        materialLoss: round2(sumKey((b) => b.costs.scrap.materialLoss)),
        processing: round2(sumKey((b) => b.costs.scrap.processing)),
        total: round2(sumKey((b) => b.costs.scrap.total)),
      },
    };
    costs.total = round2(costs.rework.total + costs.scrap.total);

    const pct = (n, d) => (d ? n / d : null);
    const rates = {
      fpy: pct(totals.firstPassCount, totals.evaluableUnits),
      finalYield: pct(totals.finalPassCount, totals.evaluableUnits),
      completeness: pct(totals.evaluableUnits, totals.totalUnits),
      reinspectionPassRate: pct(totals.reinspectionPassCount, totals.reinspectionCount),
    };

    /* 缺陷分布：按首检失败事件计数（复检失败不重复计缺陷类型） */
    const idSet = new Set(batchIds);
    const defectDist = new Map();
    const opDefect = new Map();
    for (const ins of dataset.inspections) {
      if (!idSet.has(ins.batchId) || ins.seqNo !== 1 || ins.result !== 'fail') continue;
      const d = idx.defects.get(ins.defectCode);
      if (!defectDist.has(ins.defectCode)) {
        defectDist.set(ins.defectCode, {
          code: ins.defectCode, name: d.name, category: d.category, count: 0,
        });
      }
      defectDist.get(ins.defectCode).count += 1;

      const wo = idx.workOrders.get(ins.batchId);
      const route = idx.routes.get(wo.routeId);
      const op = route.operations.find((o) => o.opId === ins.opId);
      if (!opDefect.has(ins.opId)) {
        opDefect.set(ins.opId, {
          opId: ins.opId, namesByProduct: new Map(), seqs: [], count: 0,
        });
      }
      const row = opDefect.get(ins.opId);
      row.namesByProduct.set(wo.productId, op.name);
      row.seqs.push(op.seq);
      row.count += 1;
    }

    const defectDistribution = [...defectDist.values()].sort((a, b) => b.count - a.count);
    const operationDefectDistribution = [...opDefect.values()]
      .map((r) => ({
        opId: r.opId,
        names: [...r.namesByProduct.values()],
        minSeq: Math.min(...r.seqs),
        count: r.count,
      }))
      .sort((a, b) => a.minSeq - b.minSeq || a.opId.localeCompare(b.opId));

    /* 班次对比 */
    const shiftComparison = dataset.shifts.map((shift) => {
      const sb = batches.filter((b) => b.workOrder.shiftId === shift.id);
      const agg = {
        shiftId: shift.id,
        shiftName: shift.name,
        batchCount: sb.length,
        totalUnits: sb.reduce((s, b) => s + b.totals.totalUnits, 0),
        evaluableUnits: sb.reduce((s, b) => s + b.totals.evaluableUnits, 0),
        firstPassCount: sb.reduce((s, b) => s + b.totals.firstPassCount, 0),
        finalPassCount: sb.reduce((s, b) => s + b.totals.finalPassCount, 0),
        reworkCost: round2(sb.reduce((s, b) => s + b.costs.rework.total, 0)),
        scrapCost: round2(sb.reduce((s, b) => s + b.costs.scrap.total, 0)),
      };
      agg.fpy = pct(agg.firstPassCount, agg.evaluableUnits);
      agg.finalYield = pct(agg.finalPassCount, agg.evaluableUnits);
      return agg;
    }).filter((s) => s.batchCount > 0);

    return {
      filters,
      totals,
      rates,
      costs,
      batches,
      defectDistribution,
      operationDefectDistribution,
      shiftComparison,
      index: idx,
    };
  }
  QAM.summarize = summarize;

  /* ---------------- 序列号时间线（追溯抽屉） ---------------- */

  function unitTimeline(dataset, idx, serialId) {
    const unit = idx.unitById.get(serialId);
    if (!unit) throw new Error(`未知序列号 ${serialId}`);
    const batchId = unit.batchId;
    const wo = idx.workOrders.get(batchId);
    const route = idx.routes.get(wo.routeId);
    const inspections = (idx.inspectionsBySerial.get(serialId) ?? [])
      .filter((x) => x.batchId === batchId);
    const reworks = (idx.reworksBySerial.get(serialId) ?? [])
      .filter((x) => x.batchId === batchId);
    const scrap = idx.scrapBySerial.get(serialId) ?? null;

    const steps = route.operations.map((op) => {
      const reportSet = idx.reportOpSerials.get(key(batchId, op.opId));
      const hasReport = !!(reportSet && reportSet.has(serialId));
      const opInspections = inspections
        .filter((x) => x.opId === op.opId)
        .sort((a, b) => a.seqNo - b.seqNo);
      const opReworks = reworks.filter((r) => r.fromOpId === op.opId);
      const opScrap = scrap && scrap.fromOpId === op.opId ? scrap : null;

      let state;
      if (!hasReport) state = 'missing';
      else if (opScrap) state = 'scrap';
      else if (opReworks.some((r) => r.status === 'open')) state = 'rework-open';
      else if (opInspections.some((i) => i.result === 'fail')) state = 'reworked-pass';
      else if (op.inspectionPoint) state = 'pass';
      else state = 'done';

      return { op, hasReport, state, inspections: opInspections, reworks: opReworks, scrap: opScrap };
    });

    const evalResult = evaluateBatch(dataset, idx, batchId).unitResults
      .find((u) => u.serialId === serialId);

    return {
      unit,
      workOrder: wo,
      route,
      steps,
      scrap,
      finalStatus: evalResult.finalStatus,
      evaluable: evalResult.evaluable,
      missingOps: evalResult.missingOps,
      reworkCost: round2(reworks.reduce((s, r) => s + r.totalCost, 0)),
      scrapCost: scrap ? round2(scrap.materialLossCost + scrap.processingCost) : 0,
    };
  }
  QAM.unitTimeline = unitTimeline;

  function round2(n) { return Math.round(n * 100) / 100; }

  /* CommonJS（Node 测试）与浏览器全局双挂载 */
  if (typeof module !== 'undefined' && module.exports) module.exports = QAM;
  root.QAMetrics = QAM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
