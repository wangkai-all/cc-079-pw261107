/**
 * 生产质量分析 —— 本地样例数据生成器（零依赖）
 *
 * 运行：node tools/generate-sample.mjs
 * 产出：
 *   js/sample-data.js    经典脚本（window.QA_SAMPLE），index.html 可直接 file:// 打开
 *   data/sample-data.json 机器可读孪生数据
 *
 * 设计原则：
 *  1. 每个批次的每个序列号事件都在下面的场景表里显式声明，数字可人工审计；
 *  2. 成本在生成时按费率表计算并落库为显式字段，页面只做加总，不重算；
 *  3. 生成后执行引用完整性审计（所有外键必须可解析）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* 主数据                                                              */
/* ------------------------------------------------------------------ */

const products = [
  { id: 'P-A', name: '精密伺服电机 SV-200', sku: 'SV-200' },
  { id: 'P-B', name: '工业控制板 CB-88', sku: 'CB-88' },
];

const lines = [
  { id: 'L1', name: '一号总装线', laborRatePerHour: 65 },
  { id: 'L2', name: 'SMT电子线', laborRatePerHour: 55 },
];

const shifts = [
  { id: 'S1', name: '早班', startTime: '06:00', endTime: '14:00' },
  { id: 'S2', name: '中班', startTime: '14:00', endTime: '22:00' },
  { id: 'S3', name: '夜班', startTime: '22:00', endTime: '06:00' },
];

/** 缺陷类型：reworkMinutes/materialCost 为该缺陷典型返工耗时与辅料成本 */
const defectTypes = [
  { code: 'D01', name: '尺寸超差', category: '机加工', reworkMinutes: 20, materialCost: 10 },
  { code: 'D02', name: '表面划伤', category: '外观', reworkMinutes: 15, materialCost: 6 },
  { code: 'D03', name: '装配不良', category: '装配', reworkMinutes: 25, materialCost: 12 },
  { code: 'D04', name: '焊接虚焊', category: '焊接', reworkMinutes: 18, materialCost: 8 },
  { code: 'D05', name: '电气参数异常', category: '电气', reworkMinutes: 30, materialCost: 15 },
  { code: 'D06', name: '密封失效', category: '装配', reworkMinutes: 40, materialCost: 35 },
  { code: 'D07', name: '老化性能衰减', category: '老化', reworkMinutes: 50, materialCost: 40 },
];

/** 产品报废时的主料损失 */
const scrapMaterialLoss = { 'P-A': 240, 'P-B': 95 };

/**
 * 工艺路线（带版本与生效区间）。
 * 工单在创建时绑定 routeId，之后该批次的所有解释均以绑定版本为准——
 * 路线升级不重算历史批次（见 README「历史路线快照」）。
 */
const routes = [
  {
    routeId: 'RT-A-v1',
    productId: 'P-A',
    version: 'v1',
    validFrom: '2026-10-01T00:00:00+08:00',
    validTo: '2026-10-31T23:59:59+08:00',
    changeNote: '初版路线：冲压 → 机加工 → 装配(检) → 终检(检)。',
    operations: [
      { opId: 'OP10', seq: 10, name: '冲压', inspectionPoint: false, standardCost: 18 },
      { opId: 'OP20', seq: 20, name: '机加工', inspectionPoint: false, standardCost: 26 },
      { opId: 'OP30', seq: 30, name: '装配', inspectionPoint: true, standardCost: 20 },
      { opId: 'OP40', seq: 40, name: '终检', inspectionPoint: true, standardCost: 15 },
    ],
  },
  {
    routeId: 'RT-A-v2',
    productId: 'P-A',
    version: 'v2',
    validFrom: '2026-11-01T00:00:00+08:00',
    validTo: null,
    changeNote:
      'v2 变更：OP10 与 OP20 之间新增 OP15 CNC精加工；末段新增 OP50 老化测试(检)。历史批次仍按 v1 解释。',
    operations: [
      { opId: 'OP10', seq: 10, name: '冲压', inspectionPoint: false, standardCost: 18 },
      { opId: 'OP15', seq: 15, name: 'CNC精加工', inspectionPoint: false, standardCost: 22 },
      { opId: 'OP20', seq: 20, name: '机加工', inspectionPoint: false, standardCost: 26 },
      { opId: 'OP30', seq: 30, name: '装配', inspectionPoint: true, standardCost: 20 },
      { opId: 'OP40', seq: 40, name: '终检', inspectionPoint: true, standardCost: 15 },
      { opId: 'OP50', seq: 50, name: '老化测试', inspectionPoint: true, standardCost: 12 },
    ],
  },
  {
    routeId: 'RT-B-v1',
    productId: 'P-B',
    version: 'v1',
    validFrom: '2026-10-01T00:00:00+08:00',
    validTo: null,
    changeNote: '初版路线：SMT贴片(检) → 回流焊 → 功能测试(检) → 包装。',
    operations: [
      { opId: 'OP10', seq: 10, name: 'SMT贴片', inspectionPoint: true, standardCost: 24 },
      { opId: 'OP20', seq: 20, name: '回流焊', inspectionPoint: false, standardCost: 16 },
      { opId: 'OP30', seq: 30, name: '功能测试', inspectionPoint: true, standardCost: 20 },
      { opId: 'OP40', seq: 40, name: '包装', inspectionPoint: false, standardCost: 8 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* 批次场景表                                                          */
/* ------------------------------------------------------------------ */

/**
 * 事件 end 取值：
 *  rework-pass         首检失败 → 返工 → 复检通过
 *  rework-rework-pass  首检失败 → 返工 → 复检仍失败 → 再返工 → 二次复检通过
 *  rework-scrap        首检失败 → 返工 → 复检仍失败 → 报废
 *  scrap               首检失败 → 直接报废（无返工）
 *  rework-open         首检失败 → 返工中，尚无复检（批次未关闭）
 */
const batches = [
  {
    batchId: 'B-1028-A-01', productId: 'P-A', lineId: 'L1', shiftId: 'S1',
    date: '2026-10-28', routeId: 'RT-A-v1', qty: 10,
    purpose: '多次复检去重、返工后报废、返工后通过三种形态齐全',
    units: [
      { sn: 1, events: [] },
      { sn: 2, events: [{ op: 'OP30', defect: 'D03', end: 'rework-pass' }] },
      { sn: 3, events: [{ op: 'OP30', defect: 'D03', end: 'rework-rework-pass' }] },
      { sn: 4, events: [{ op: 'OP40', defect: 'D06', end: 'rework-pass' }] },
      { sn: 5, events: [{ op: 'OP40', defect: 'D06', end: 'rework-scrap' }] },
      { sn: 6, events: [] }, { sn: 7, events: [] }, { sn: 8, events: [] },
      { sn: 9, events: [] }, { sn: 10, events: [] },
    ],
  },
  {
    batchId: 'B-1029-A-02', productId: 'P-A', lineId: 'L1', shiftId: 'S3',
    date: '2026-10-29', routeId: 'RT-A-v1', qty: 10,
    purpose: '追踪不完整：U08-U10 缺失 OP40 报工与终检记录',
    missing: { OP40: [8, 9, 10] },
    units: [
      { sn: 1, events: [{ op: 'OP30', defect: 'D01', end: 'rework-pass' }] },
      { sn: 2, events: [{ op: 'OP40', defect: 'D06', end: 'rework-pass' }] },
      { sn: 3, events: [] }, { sn: 4, events: [] }, { sn: 5, events: [] },
      { sn: 6, events: [] }, { sn: 7, events: [] },
      { sn: 8, events: [] }, { sn: 9, events: [] }, { sn: 10, events: [] },
    ],
  },
  {
    batchId: 'B-1030-A-03', productId: 'P-A', lineId: 'L1', shiftId: 'S2',
    date: '2026-10-30', routeId: 'RT-A-v1', qty: 10,
    purpose: '直接报废与返工后报废并存',
    units: [
      { sn: 1, events: [{ op: 'OP30', defect: 'D02', end: 'rework-pass' }] },
      { sn: 2, events: [{ op: 'OP40', defect: 'D06', end: 'scrap' }] },
      { sn: 3, events: [{ op: 'OP30', defect: 'D01', end: 'rework-scrap' }] },
      { sn: 4, events: [] }, { sn: 5, events: [] }, { sn: 6, events: [] },
      { sn: 7, events: [] }, { sn: 8, events: [] }, { sn: 9, events: [] }, { sn: 10, events: [] },
    ],
  },
  {
    batchId: 'B-1030-B-04', productId: 'P-B', lineId: 'L2', shiftId: 'S1',
    date: '2026-10-30', routeId: 'RT-B-v1', qty: 12,
    purpose: '同一序列号在两道工序分别返工，均复检通过',
    units: [
      { sn: 1, events: [{ op: 'OP10', defect: 'D04', end: 'rework-pass' }] },
      { sn: 2, events: [{ op: 'OP30', defect: 'D05', end: 'rework-pass' }] },
      {
        sn: 3,
        events: [
          { op: 'OP10', defect: 'D04', end: 'rework-pass' },
          { op: 'OP30', defect: 'D05', end: 'rework-pass' },
        ],
      },
      ...range(4, 12).map((sn) => ({ sn, events: [] })),
    ],
  },
  {
    batchId: 'B-1031-B-05', productId: 'P-B', lineId: 'L2', shiftId: 'S3',
    date: '2026-10-31', routeId: 'RT-B-v1', qty: 12, open: true,
    purpose: '夜班高缺陷：报废 2、返工未关闭 1，工单未关闭',
    units: [
      { sn: 1, events: [{ op: 'OP10', defect: 'D04', end: 'rework-scrap' }] },
      {
        sn: 2,
        events: [
          { op: 'OP10', defect: 'D04', end: 'rework-pass' },
          { op: 'OP30', defect: 'D05', end: 'rework-scrap' },
        ],
      },
      { sn: 3, events: [{ op: 'OP30', defect: 'D05', end: 'rework-pass' }] },
      { sn: 4, events: [{ op: 'OP30', defect: 'D05', end: 'rework-open' }] },
      ...range(5, 12).map((sn) => ({ sn, events: [] })),
    ],
  },
  {
    batchId: 'B-1101-A-06', productId: 'P-A', lineId: 'L1', shiftId: 'S1',
    date: '2026-11-01', routeId: 'RT-A-v2', qty: 10,
    purpose: 'v2 新路线首单：OP50 老化测试出现新缺陷 D07',
    units: [
      {
        sn: 1,
        events: [
          { op: 'OP30', defect: 'D03', end: 'rework-pass' },
          { op: 'OP50', defect: 'D07', end: 'rework-pass' },
        ],
      },
      { sn: 2, events: [{ op: 'OP50', defect: 'D07', end: 'scrap' }] },
      ...range(3, 10).map((sn) => ({ sn, events: [] })),
    ],
  },
  {
    batchId: 'B-1102-A-07', productId: 'P-A', lineId: 'L1', shiftId: 'S3',
    date: '2026-11-02', routeId: 'RT-A-v2', qty: 10,
    purpose: '追踪不完整：U08-U10 缺失 v2 新增工序 OP15 的报工',
    missing: { OP15: [8, 9, 10] },
    units: [
      { sn: 1, events: [{ op: 'OP30', defect: 'D01', end: 'rework-pass' }] },
      { sn: 2, events: [{ op: 'OP40', defect: 'D06', end: 'rework-scrap' }] },
      { sn: 3, events: [] }, { sn: 4, events: [] }, { sn: 5, events: [] },
      { sn: 6, events: [] }, { sn: 7, events: [] },
      { sn: 8, events: [] }, { sn: 9, events: [] }, { sn: 10, events: [] },
    ],
  },
  {
    batchId: 'B-1103-B-08', productId: 'P-B', lineId: 'L2', shiftId: 'S2',
    date: '2026-11-03', routeId: 'RT-B-v1', qty: 12,
    purpose: '中班低缺陷基线',
    units: [
      { sn: 1, events: [{ op: 'OP10', defect: 'D04', end: 'rework-pass' }] },
      ...range(2, 12).map((sn) => ({ sn, events: [] })),
    ],
  },
  {
    batchId: 'B-1104-A-09', productId: 'P-A', lineId: 'L1', shiftId: 'S2',
    date: '2026-11-04', routeId: 'RT-A-v2', qty: 10,
    purpose: 'v2 路线稳定批次，仅 1 次外观返工',
    units: [
      { sn: 1, events: [{ op: 'OP30', defect: 'D02', end: 'rework-pass' }] },
      ...range(2, 10).map((sn) => ({ sn, events: [] })),
    ],
  },
];

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/* ------------------------------------------------------------------ */
/* 记录生成                                                            */
/* ------------------------------------------------------------------ */

const routeMap = new Map(routes.map((r) => [r.routeId, r]));
const defectMap = new Map(defectTypes.map((d) => [d.code, d]));
const lineMap = new Map(lines.map((l) => [l.id, l]));
const shiftMap = new Map(shifts.map((s) => [s.id, s]));

const workOrders = [];
const units = [];
const operationReports = [];
const inspections = [];
const reworkRecords = [];
const scrapRecords = [];

let insCounter = 0;
let rwCounter = 0;
let scCounter = 0;

function pad(n) { return String(n).padStart(2, '0'); }
function serialIdOf(batchId, sn) { return `${batchId}-U${pad(sn)}`; }
function round2(n) { return Math.round(n * 100) / 100; }

function shiftStartDate(date, shiftId) {
  const d = new Date(`${date}T00:00:00+08:00`);
  const startHour = Number(shiftMap.get(shiftId).startTime.split(':')[0]);
  d.setHours(startHour, 0, 0, 0);
  return d;
}

function isoAt(base, minuteOffset) {
  const d = new Date(base.getTime() + minuteOffset * 60000);
  // 固定 +08:00 输出，避免随运行环境时区漂移
  const local = new Date(d.getTime() + 8 * 3600000);
  const s = local.toISOString();
  return s.slice(0, 19) + '+08:00';
}

function reworkCost(lineId, defectCode) {
  const defect = defectMap.get(defectCode);
  const rate = lineMap.get(lineId).laborRatePerHour;
  const laborCost = round2((defect.reworkMinutes / 60) * rate);
  return {
    laborMinutes: defect.reworkMinutes,
    laborCost,
    materialCost: defect.materialCost,
    totalCost: round2(laborCost + defect.materialCost),
  };
}

function scrapProcessingCost(route, upToOpId) {
  const idx = route.operations.findIndex((o) => o.opId === upToOpId);
  return round2(route.operations.slice(0, idx + 1).reduce((s, o) => s + o.standardCost, 0));
}

for (const batch of batches) {
  const route = routeMap.get(batch.routeId);
  const base = shiftStartDate(batch.date, batch.shiftId);
  const missing = batch.missing ?? {};

  workOrders.push({
    id: `WO-${batch.batchId.slice(2)}`,
    batchId: batch.batchId,
    productId: batch.productId,
    lineId: batch.lineId,
    shiftId: batch.shiftId,
    routeId: batch.routeId,
    plannedQty: batch.qty,
    createdAt: isoAt(base, 0),
    closedAt: batch.open ? null : isoAt(base, 60 * 7 + 30),
    note: batch.purpose,
  });

  // 序列号花名册：产量去重的唯一锚点，复检不新增序列号
  for (const u of batch.units) {
    units.push({
      serialId: serialIdOf(batch.batchId, u.sn),
      batchId: batch.batchId,
      productId: batch.productId,
    });
  }

  /** 批次内每道工序的报工（含覆盖到的序列号清单） */
  const reportSerials = new Map(route.operations.map((o) => [o.opId, []]));
  /** 序列号 → 终止工序（报废/未关闭返工之后的工序不再期望有记录） */
  const terminalOp = new Map();

  for (const unit of batch.units) {
    const serialId = serialIdOf(batch.batchId, unit.sn);
    const eventsByOp = new Map(unit.events.map((e) => [e.op, e]));
    let clock = unit.sn * 2; // 序列号之间错开 2 分钟

    for (const op of route.operations) {
      if (terminalOp.has(serialId)) break;
      const isMissing = (missing[op.opId] ?? []).includes(unit.sn);

      if (!isMissing) reportSerials.get(op.opId).push(serialId);

      if (!op.inspectionPoint) {
        clock += 6;
        continue;
      }
      if (isMissing) {
        // 报工缺失时该工序检验同样缺失，留给引擎判定追踪不完整
        clock += 6;
        continue;
      }

      const event = eventsByOp.get(op.opId);
      if (!event) {
        insCounter += 1;
        inspections.push({
          id: `INS-${insCounter}`,
          batchId: batch.batchId,
          serialId,
          opId: op.opId,
          seqNo: 1,
          result: 'pass',
          defectCode: null,
          parentInspectionId: null,
          inspectorId: `QC-${lineMap.get(batch.lineId).id}`,
          inspectedAt: isoAt(base, clock),
        });
        clock += 6;
        continue;
      }

      /* 首检失败 */
      insCounter += 1;
      const failInspectionId = `INS-${insCounter}`;
      inspections.push({
        id: failInspectionId,
        batchId: batch.batchId,
        serialId,
        opId: op.opId,
        seqNo: 1,
        result: 'fail',
        defectCode: event.defect,
        parentInspectionId: null,
        inspectorId: `QC-${batch.lineId}`,
        inspectedAt: isoAt(base, clock),
      });
      clock += 8;

      const openRework = () => {
        rwCounter += 1;
        const c = reworkCost(batch.lineId, event.defect);
        reworkRecords.push({
          id: `RW-${rwCounter}`,
          batchId: batch.batchId,
          serialId,
          defectCode: event.defect,
          fromOpId: op.opId,
          reworkOpId: op.opId,
          sourceInspectionId: failInspectionId,
          status: 'open',
          ...c,
          createdAt: isoAt(base, clock),
          closedAt: null,
        });
        terminalOp.set(serialId, op.opId);
      };

      const doScrap = (parentInspectionId) => {
        scCounter += 1;
        scrapRecords.push({
          id: `SC-${scCounter}`,
          batchId: batch.batchId,
          serialId,
          defectCode: event.defect,
          fromOpId: op.opId,
          sourceInspectionId: parentInspectionId,
          materialLossCost: scrapMaterialLoss[batch.productId],
          processingCost: scrapProcessingCost(route, op.opId),
          scrappedAt: isoAt(base, clock + 5),
        });
        terminalOp.set(serialId, op.opId);
      };

      const doRework = () => {
        rwCounter += 1;
        const c = reworkCost(batch.lineId, event.defect);
        const rwId = `RW-${rwCounter}`;
        reworkRecords.push({
          id: rwId,
          batchId: batch.batchId,
          serialId,
          defectCode: event.defect,
          fromOpId: op.opId,
          reworkOpId: op.opId,
          sourceInspectionId: failInspectionId,
          status: 'closed',
          ...c,
          createdAt: isoAt(base, clock),
          closedAt: isoAt(base, clock + 45),
        });
        clock += 50;
        return rwId;
      };

      const reinspect = (parentId, result, defectCode, seqNo) => {
        insCounter += 1;
        inspections.push({
          id: `INS-${insCounter}`,
          batchId: batch.batchId,
          serialId,
          opId: op.opId,
          seqNo,
          result,
          defectCode,
          parentInspectionId: parentId,
          inspectorId: `QC-${batch.lineId}`,
          inspectedAt: isoAt(base, clock),
        });
      };

      switch (event.end) {
        case 'rework-pass': {
          doRework();
          reinspect(failInspectionId, 'pass', null, 2);
          break;
        }
        case 'rework-rework-pass': {
          doRework();
          reinspect(failInspectionId, 'fail', event.defect, 2);
          clock += 8;
          doRework();
          reinspect(failInspectionId, 'pass', null, 3);
          break;
        }
        case 'rework-scrap': {
          doRework();
          reinspect(failInspectionId, 'fail', event.defect, 2);
          clock += 5;
          doScrap(failInspectionId);
          break;
        }
        case 'scrap': {
          clock += 5;
          doScrap(failInspectionId);
          break;
        }
        case 'rework-open': {
          openRework();
          break;
        }
        default:
          throw new Error(`未知事件类型 ${event.end}`);
      }
      clock += 6;
    }
  }

  for (const op of route.operations) {
    const serialIds = reportSerials.get(op.opId);
    if (serialIds.length === 0) continue; // 整道工序缺失：不生成报工
    operationReports.push({
      id: `OPR-${batch.batchId}-${op.opId}`,
      batchId: batch.batchId,
      opId: op.opId,
      serialIds,
      reportedAt: isoAt(base, op.seq * 3),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 引用完整性审计                                                      */
/* ------------------------------------------------------------------ */

const audit = [];
function check(cond, message) {
  if (!cond) audit.push(message);
}

const idSets = {
  batch: new Set(batches.map((b) => b.batchId)),
  route: new Set(routes.map((r) => r.routeId)),
  product: new Set(products.map((p) => p.id)),
  line: new Set(lines.map((l) => l.id)),
  shift: new Set(shifts.map((s) => s.id)),
  serial: new Set(units.map((u) => u.serialId)),
  inspection: new Set(inspections.map((i) => i.id)),
  defect: new Set(defectTypes.map((d) => d.code)),
};

for (const wo of workOrders) {
  check(idSets.batch.has(wo.batchId), `工单 ${wo.id} 批次不存在`);
  check(idSets.route.has(wo.routeId), `工单 ${wo.id} 路线不存在`);
  check(idSets.product.has(wo.productId), `工单 ${wo.id} 产品不存在`);
  check(idSets.line.has(wo.lineId), `工单 ${wo.id} 产线不存在`);
  check(idSets.shift.has(wo.shiftId), `工单 ${wo.id} 班次不存在`);
  const route = routeMap.get(wo.routeId);
  check(route.productId === wo.productId, `工单 ${wo.id} 路线与产品不匹配`);
}
for (const u of units) check(idSets.batch.has(u.batchId), `序列号 ${u.serialId} 批次不存在`);
for (const r of operationReports) {
  check(idSets.batch.has(r.batchId), `报工 ${r.id} 批次不存在`);
  check(routeMap.get(workOrders.find((w) => w.batchId === r.batchId).routeId)
    .operations.some((o) => o.opId === r.opId), `报工 ${r.id} 工序不在绑定路线内`);
  for (const s of r.serialIds) check(idSets.serial.has(s), `报工 ${r.id} 引用未知序列号 ${s}`);
}
for (const i of inspections) {
  check(idSets.serial.has(i.serialId), `检验 ${i.id} 序列号不存在`);
  check(i.result === 'pass' || idSets.defect.has(i.defectCode), `检验 ${i.id} 缺陷码缺失`);
  check(i.parentInspectionId === null || idSets.inspection.has(i.parentInspectionId),
    `检验 ${i.id} 父检验不存在`);
  check(i.seqNo === 1 || i.parentInspectionId !== null, `复检 ${i.id} 缺少父检验`);
}
for (const r of reworkRecords) {
  check(idSets.inspection.has(r.sourceInspectionId), `返工 ${r.id} 来源检验不存在`);
  check(idSets.defect.has(r.defectCode), `返工 ${r.id} 缺陷码不存在`);
  check(r.totalCost === round2(r.laborCost + r.materialCost), `返工 ${r.id} 成本不平`);
}
for (const s of scrapRecords) {
  check(idSets.inspection.has(s.sourceInspectionId), `报废 ${s.id} 来源检验不存在`);
  check(s.materialLossCost > 0 && s.processingCost > 0, `报废 ${s.id} 成本字段缺失`);
}
// 同一序列号不能同时存在报废与未关闭返工
for (const s of scrapRecords) {
  check(!reworkRecords.some((r) => r.serialId === s.serialId && r.status === 'open'),
    `序列号 ${s.serialId} 同时报废与未关闭返工`);
}

if (audit.length) {
  console.error('引用完整性审计失败：');
  for (const a of audit) console.error(' -', a);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

const data = {
  meta: {
    dataset: 'production-quality-sample',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    currency: 'CNY',
    timezone: '+08:00',
    description:
      '本地可追溯样例：工单-工序报工-检验-返工/复检-报废全链路；产量按序列号去重；成本字段显式落库；批次绑定历史路线版本。',
  },
  products,
  lines,
  shifts,
  defectTypes,
  routes,
  workOrders,
  units,
  operationReports,
  inspections,
  reworkRecords,
  scrapRecords,
};

mkdirSync(join(ROOT, 'js'), { recursive: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });

const json = JSON.stringify(data, null, 2);
writeFileSync(join(ROOT, 'data', 'sample-data.json'), json + '\n');
writeFileSync(
  join(ROOT, 'js', 'sample-data.js'),
  '/* 本文件由 tools/generate-sample.mjs 自动生成，请勿手改。机器可读孪生数据见 data/sample-data.json */\n'
    + 'window.QA_SAMPLE = '
    + json
    + ';\n',
);

console.log('生成完成：');
console.log(`  工单/批次 ${workOrders.length}，序列号 ${units.length}，报工 ${operationReports.length}，`
  + `检验 ${inspections.length}，返工 ${reworkRecords.length}，报废 ${scrapRecords.length}`);
console.log('  引用完整性审计：全部通过');
