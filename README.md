# 生产质量分析页面

把**工单、工序报工、检验结果、返工/复检、报废记录**串成一条可追溯链路的单页应用。
按产品、产线、班次查看一次通过率（FPY）、最终良率与返工/报废成本；
展开批次可定位缺陷出现在哪道工序、返工后是否通过复检；点击序列号查看单件全流程追溯。

零依赖、零构建、可离线运行：直接用浏览器打开 `index.html` 即可（数据通过经典脚本
`js/sample-data.js` 挂载，无需 HTTP 服务、无外部 CDN）。

## 快速开始

```bash
# 重新生成样例数据（含引用完整性审计）
node tools/generate-sample.mjs

# 运行全部测试（32 个：13 业务口径 + 10 页面 DOM + 9 SVG 几何）
node --test tests/metrics.test.js
node --test tests/dom.smoke.test.cjs    # 需 jsdom，见 tests 说明
node --test tests/svg.geometry.test.cjs # 需 jsdom

# 浏览页面
# 直接双击 index.html，或：
python3 -m http.server 8000
```

## 目录结构

```
index.html               页面骨架（过滤栏 / KPI / 4 张图卡 / 批次表 / 追溯抽屉）
css/styles.css           角色化 CSS 变量，明/暗双主题
js/sample-data.js        生成器产出的样例（window.QA_SAMPLE），可 file:// 直接加载
js/metrics.js            纯函数指标引擎（口径全在这里，浏览器与 Node 共用）
js/charts.js             手写 SVG 图表（无图表库），带 tooltip/键盘焦点/表格孪生
js/app.js                页面控制器：筛选 → summarize → 渲染
data/sample-data.json    样例的机器可读孪生数据
tools/generate-sample.mjs 样例数据生成器 + 引用完整性审计
tests/                   node:test 测试（业务口径、DOM 冒烟、SVG 几何）
```

## 数据模型与追溯链

```
products / lines / shifts / defectTypes      主数据
routes                                       工艺路线（带版本与生效区间）
workOrders ──绑定── routeId                  工单创建时锁定路线版本
units                                        序列号花名册（产量去重的唯一锚点）
operationReports (batchId, opId, serialIds)  工序报工：哪些序列号经过了哪道工序
inspections (serialId, opId, seqNo,          检验：seqNo=1 首检，>=2 复检，
              parentInspectionId, result)          parentInspectionId 串起复检链
reworkRecords (sourceInspectionId, 工时/辅料成本, status)
scrapRecords (sourceInspectionId, 主料损失/加工费)
```

任意汇总数字都能沿 `批次 → 序列号 → 检验链(parentInspectionId) → 返工单/报废单`
逐级下钻到原始记录 id，页面底部抽屉即按此链路渲染。

## 统计口径（业务规则）

1. **产量按序列号去重**。`units` 花名册是唯一产量锚点；同一序列号经历多少次首检/复检
   都只算一件，复检不产生新序列号。
2. **一次通过率 FPY** = 可评估序列号中「所有检验点首检即合格（无任何 seqNo=1 失败记录）」
   的占比。
3. **最终良率** = 可评估序列号中最终状态为合格的占比。返工后复检通过计入合格；报废不计入。
4. **可评估序列号**：报工/检验记录覆盖到应到工序，且有终态结论。下列情况判为
   **追踪不完整**并从 FPY/良率分母剔除（页面显式标记，不静默丢弃）：
   - 序列号缺失某道应到工序的报工（连同该工序检验一起缺失）；
   - 返工单 `status=open`，尚无复检结论（工单未关闭）。
   报废视同已有终态结论，仍属可评估。
5. **返工成本与报废成本分别归集，互不混入**：
   - 返工成本 = 返工工时费（工时 × 产线小时费率）+ 辅料费；
   - 报废成本 = 主料损失 + 已投入工序的累计标准加工费；
   - **先返工后报废**的序列号，两笔成本各自保留、分别汇总（不会互相冲抵）。
6. **缺陷分布按首检失败事件计数**；同一序列号的复检失败不重复计入缺陷类型分布。
7. **历史路线快照**：每张工单在创建时绑定 `routeId`。此后该批次的工序顺序、检验点、
   缺陷工序归属一律按绑定版本解释。路线升级（如 RT-A-v1 → v2 新增 OP15/OP50）后，
   旧批次仍按 v1 解释，**不套用新工序顺序重算**。

## 样例场景覆盖

生成器（`tools/generate-sample.mjs`）用显式场景表构造，每个序列号的事件均可人工审计，
落库前自动跑引用完整性审计（外键可解析、复检有父检验、成本勾稽、报废与未关闭返工不冲突）。

| 场景 | 所在批次 |
|---|---|
| 多次复检去重（两轮返工、三次检验后合格） | B-1028-A-01 / U03 |
| 返工后复检通过 / 返工后仍失败报废 / 直接报废 | B-1028-A-01、B-1030-A-03 |
| 同一序列号在两道工序分别返工 | B-1030-B-04 / U03 |
| 缺失工序报工 → 追踪不完整并标记缺失序列号 | B-1029-A-02（OP40）、B-1102-A-07（OP15） |
| 返工未关闭、工单未关闭 | B-1031-B-05 / U04 |
| 路线 v1/v2 变更，旧数据按旧路线解释 | 10 月批次(v1) vs B-1101/B-1102(v2) |
| 新路线新增检验点出现新缺陷（OP50 老化 D07） | B-1101-A-06 |

## 设计与可访问性

- 手写 SVG，遵循 dataviz 规范：条形 ≤24px、数据端 4px 圆角基线端直角、2px 表面间隙、
  1px 实线网格、文字走文本令牌不穿系列色。
- 双序列固定蓝/橙且颜色跟随实体（筛选不重排颜色）；调色板已通过官方校验脚本的
  明暗双模式 CVD/对比度检查。
- 每个标记有 ≥24px 命中区、hover 与键盘 focus 同一 tooltip；每张图都有**表格视图孪生**，
  tooltip 不承担唯一读数通道。
- 明/暗主题手动切换并记忆（`localStorage`），默认跟随系统 `prefers-color-scheme`。
- 状态色（合格/警告/严重/报废）一律图标点 + 文字徽标，不依赖颜色 alone。

## 测试说明

`dom.smoke.test.js` 与 `svg.geometry.test.js` 依赖 jsdom（业务口径测试
`metrics.test.js` 零依赖）。本地安装：

```bash
npm install --no-save jsdom   # 或安装到任意目录，测试会按候选路径解析
```

测试覆盖：手算口径逐批次核对、复检去重、成本分离、完整性剔除、历史路线绑定、
筛选切片一致性、抽屉追溯、空结果兜底、SVG 几何与令牌约束、筛选后不重色等。
