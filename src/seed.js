'use strict';
/**
 * seed.js — 首次启动时写入示例政策数据（仅当库为空），便于本地预览与功能演示。
 * 示例数据均标注「演示数据」，正式使用请通过「采集→审核」流程入库真实政策。
 */
const db = require('./db');

function p(partial) {
  const base = {
    status: 'published', // draft/published/repealed/expired
    securityLevel: '公开',
    keywords: [],
    sourceUrl: '',
    sourceType: 'manual',
    indicators: [],
    viewCount: 0,
    createdAt: db.nowIso(),
    updatedAt: db.nowIso(),
    currentVersion: 1,
  };
  return { ...base, ...partial };
}

function ind(name, value, extra = {}) {
  return { name, value, unit: '', ...extra };
}

function seedIfEmpty() {
  const d = db.getDb();
  if (d.policies.length > 0) return false;

  const now = new Date();
  const iso = (offsetDays) => {
    const x = new Date(now);
    x.setDate(x.getDate() + offsetDays);
    return x.toISOString();
  };

  const policies = [
    p({
      id: db.uid('pol'), title: '深圳市最低工资标准调整通知（示例·演示数据）',
      documentNumber: '深府函〔2025〕XXX 号（示例）', org: '深圳市人力资源和社会保障局',
      type: '规范性文件', category: '最低工资', region: '深圳', city: '深圳市',
      releaseDate: '2025-02-20', effectiveDate: '2025-03-01', expirationDate: '',
      effectivenessStatus: '有效',
      summary: '自 2025 年 3 月 1 日起，深圳市全日制就业劳动者月最低工资标准调整为 2420 元/月，非全日制就业劳动者小时最低工资标准调整为 23.7 元/小时。（演示数据，请以官方原文为准）',
      content: '一、自 2025 年 3 月 1 日起，深圳市全日制就业劳动者月最低工资标准调整为 2420 元/月。\n二、非全日制就业劳动者小时最低工资标准调整为 23.7 元/小时。\n三、最低工资标准不包括：延长工作时间工资；中班、夜班、高温、低温、井下、有毒有害等特殊工作环境、条件下的津贴；法律法规和国家规定的劳动者福利待遇等。\n四、用人单位支付给劳动者的工资不得低于当地最低工资标准。',
      keywords: ['最低工资', '深圳', '2420'],
      indicators: [
        ind('月最低工资标准', '2420', { unit: '元/月', effectiveDate: '2025-03-01', note: '全日制' }),
        ind('小时最低工资标准', '23.7', { unit: '元/小时', effectiveDate: '2025-03-01', note: '非全日制' }),
        ind('是否含社保', '不含', { note: '按广东省口径，最低工资不含个人依法缴纳的社会保险费' }),
      ],
      sourceUrl: 'http://hrss.sz.gov.cn/example', viewCount: 312,
    }),
    p({
      id: db.uid('pol'), title: '深圳市最低工资标准（旧版存档·演示数据）',
      documentNumber: '深府函〔2021〕XXX 号（示例）', org: '深圳市人力资源和社会保障局',
      type: '规范性文件', category: '最低工资', region: '深圳', city: '深圳市',
      releaseDate: '2021-11-26', effectiveDate: '2022-01-01', expirationDate: '2025-02-28',
      effectivenessStatus: '已废止', status: 'repealed',
      summary: '2022-2025 年执行的旧版最低工资标准，已被新版替代。（演示数据）',
      content: '自 2022 年 1 月 1 日起，深圳市月最低工资标准为 2360 元/月，小时最低工资标准为 22.2 元/小时。',
      keywords: ['最低工资', '深圳', '2360', '废止'],
      indicators: [ind('月最低工资标准', '2360', { unit: '元/月', effectiveDate: '2022-01-01', expirationDate: '2025-02-28' })],
      sourceUrl: 'http://hrss.sz.gov.cn/example-old', viewCount: 87,
    }),
    p({
      id: db.uid('pol'), title: '上海市调整最低工资标准的通知（示例·演示数据）',
      documentNumber: '沪人社规〔2023〕XX 号（示例）', org: '上海市人力资源和社会保障局',
      type: '规范性文件', category: '最低工资', region: '上海', city: '上海市',
      releaseDate: '2023-06-20', effectiveDate: '2023-07-01', expirationDate: '',
      effectivenessStatus: '有效',
      summary: '自 2023 年 7 月 1 日起，上海月最低工资标准 2690 元/月，小时最低工资 24 元/小时。最低工资不含个人依法缴纳的社保与公积金。（演示数据）',
      content: '一、月最低工资标准从 2590 元调整到 2690 元。\n二、小时最低工资标准从 23 元调整到 24 元。\n三、月最低工资标准不包括个人依法缴纳的社会保险费和住房公积金，由用人单位另行支付。',
      keywords: ['最低工资', '上海', '2690'],
      indicators: [ind('月最低工资标准', '2690', { unit: '元/月', effectiveDate: '2023-07-01' })],
      sourceUrl: 'http://rsj.sh.gov.cn/example', viewCount: 268,
    }),
    p({
      id: db.uid('pol'), title: '北京市住房公积金缴存基数上下限通知（示例·演示数据）',
      documentNumber: '京房公积金发〔2025〕XX 号（示例）', org: '北京住房公积金管理中心',
      type: '业务通知', category: '公积金', region: '北京', city: '北京市',
      releaseDate: '2025-06-30', effectiveDate: '2025-07-01', expirationDate: '2026-06-30',
      effectivenessStatus: '有效',
      summary: '2025 住房公积金年度缴存基数上限 35283 元，下限 2420 元，缴存比例 5%-12%。（演示数据）',
      content: '一、2025 住房公积金年度（2025 年 7 月 1 日至 2026 年 6 月 30 日）缴存基数上限为 35283 元。\n二、缴存基数下限为 2420 元。\n三、单位和职工缴存比例均不得低于 5%，不得高于 12%。',
      keywords: ['公积金', '缴存基数', '北京', '上限'],
      indicators: [
        ind('缴存基数上限', '35283', { unit: '元', effectiveDate: '2025-07-01', expirationDate: '2026-06-30' }),
        ind('缴存基数下限', '2420', { unit: '元', effectiveDate: '2025-07-01' }),
        ind('缴存比例范围', '5%-12%', { note: '单位和职工一致' }),
      ],
      sourceUrl: 'http://gjj.beijing.gov.cn/example', viewCount: 421,
    }),
    p({
      id: db.uid('pol'), title: '个人所得税专项附加扣除暂行办法要点整理（示例·演示数据）',
      documentNumber: '', org: '国家税务总局（示例整理）',
      type: '法规整理', category: '个税', region: '全国', city: '',
      releaseDate: '2023-08-31', effectiveDate: '2023-01-01', expirationDate: '',
      effectivenessStatus: '有效',
      summary: '子女教育、继续教育、大病医疗、住房贷款利息、住房租金、赡养老人、婴幼儿照护等七项专项附加扣除要点。（演示整理，请以官方原文为准）',
      content: '一、子女教育：每个子女每月 2000 元定额扣除（2023 年起）。\n二、继续教育：学历（学位）教育期间每月 400 元，职业资格取得当年 3600 元。\n三、大病医疗：每年限额 80000 元，据实扣除。\n四、住房贷款利息：首套住房贷款利息每月 1000 元，最长 240 个月。\n五、住房租金：按城市每月 1500/1100/800 元三档。\n六、赡养老人：独生子女每月 3000 元，非独生子女分摊不超过 1500 元/月。\n七、婴幼儿照护：每个婴幼儿每月 2000 元。',
      keywords: ['个税', '专项附加扣除', '子女教育', '赡养老人', '大病医疗'],
      indicators: [
        ind('子女教育扣除', '2000', { unit: '元/月/子女' }),
        ind('大病医疗扣除上限', '80000', { unit: '元/年' }),
        ind('赡养老人扣除', '3000', { unit: '元/月', note: '独生子女' }),
        ind('婴幼儿照护扣除', '2000', { unit: '元/月/婴幼儿' }),
      ],
      sourceUrl: 'http://www.chinatax.gov.cn/example', viewCount: 1903,
    }),
    p({
      id: db.uid('pol'), title: '上海市育儿假与生育假实施办法（示例·演示数据）',
      documentNumber: '沪府令〔2021〕XX 号（示例）', org: '上海市人民政府',
      type: '地方性法规/规章', category: '假期', region: '上海', city: '上海市',
      releaseDate: '2021-11-25', effectiveDate: '2021-11-25', expirationDate: '',
      effectivenessStatus: '有效',
      summary: '女方除享受国家规定的产假外，另享受生育假 60 天；子女满 3 周岁前，夫妻双方每年各享受育儿假 5 天。（演示数据）',
      content: '一、女方除享受国家规定的产假（98 天）外，另享受生育假六十天。\n二、男方享受陪产假十天。\n三、子女年满三周岁之前，夫妻双方每年可以各享受育儿假五天。育儿假按照自然年度计算。',
      keywords: ['育儿假', '生育假', '产假', '上海', '陪产假'],
      indicators: [
        ind('产假天数', '98', { unit: '天', note: '国家规定基础' }),
        ind('生育假天数', '60', { unit: '天', note: '上海地方奖励' }),
        ind('陪产假天数', '10', { unit: '天' }),
        ind('育儿假天数', '5', { unit: '天/年/人', note: '子女3周岁前，夫妻各享' }),
      ],
      sourceUrl: 'http://www.shanghai.gov.cn/example', viewCount: 754,
    }),
    p({
      id: db.uid('pol'), title: '广东省高温津贴发放标准通知（示例·演示数据）',
      documentNumber: '粤人社规〔2021〕XX 号（示例）', org: '广东省人力资源和社会保障厅',
      type: '规范性文件', category: '高温津贴', region: '广东', city: '',
      releaseDate: '2021-05-20', effectiveDate: '2021-06-01', expirationDate: '2026-09-30',
      effectivenessStatus: '有效',
      summary: '每年 6 月至 10 月，广东省高温津贴标准为每人每月 300 元；用人单位安排劳动者在 35℃ 以上高温天气从事室外露天作业等应发放。（示例数据）',
      content: '一、每年 6 月至 10 月期间，用人单位安排劳动者从事高温作业的，应当按月发放高温津贴，标准为每人每月 300 元。\n二、需发放高温津贴的岗位包括：室外露天作业、以及不能采取有效措施将工作场所温度降低到 33℃ 以下的室内作业。\n三、正常工作时间工资及最低工资标准不包含高温津贴。',
      keywords: ['高温津贴', '广东', '300元', '6-10月'],
      indicators: [
        ind('高温津贴标准', '300', { unit: '元/月', effectiveDate: '2021-06-01', expirationDate: '2026-09-30', note: '发放月份 6-10 月' }),
        ind('发放月份', '6-10 月'),
        ind('适用条件', '室外露天作业或室内 33℃ 以上且无法有效降温', { note: '高温天气 35℃+' }),
      ],
      sourceUrl: 'http://hrss.gd.gov.cn/example', viewCount: 1280,
    }),
    p({
      id: db.uid('pol'), title: '职工带薪年休假条例要点整理（示例·演示数据）',
      documentNumber: '国务院令第 514 号（示例整理）', org: '国务院',
      type: '行政法规整理', category: '假期', region: '全国', city: '',
      releaseDate: '2007-12-14', effectiveDate: '2008-01-01', expirationDate: '',
      effectivenessStatus: '有效',
      summary: '职工累计工作满 1 年不满 10 年的，年休假 5 天；满 10 年不满 20 年的 10 天；满 20 年的 15 天。（示例整理）',
      content: '一、职工累计工作已满 1 年不满 10 年的，年休假 5 天；已满 10 年不满 20 年的，年休假 10 天；已满 20 年的，年休假 15 天。\n二、国家法定休假日、休息日不计入年休假的假期。\n三、单位确因工作需要不能安排职工休年休假的，经职工本人同意，可以不安排休年休假，对职工应休未休的年休假天数，单位应当按照该职工日工资收入的 300% 支付年休假工资报酬。',
      keywords: ['年休假', '带薪年假', '全国'],
      indicators: [
        ind('年休假 1-10 年工龄', '5', { unit: '天' }),
        ind('年休假 10-20 年工龄', '10', { unit: '天' }),
        ind('年休假 20 年以上工龄', '15', { unit: '天' }),
        ind('未休年假补偿', '300%', { unit: '日工资', note: '应休未休天数' }),
      ],
      sourceUrl: 'http://www.gov.cn/example', viewCount: 2210,
    }),
    p({
      id: db.uid('pol'), title: '广东省人力资源和社会保障厅关于公布 2025 年度全省全口径城镇单位就业人员平均工资的通知（示例·演示数据）',
      documentNumber: '粤人社发〔2026〕XX 号（示例）', org: '广东省人力资源和社会保障厅',
      type: '数据公报', category: '平均工资', region: '广东', city: '',
      releaseDate: '2026-06-15', effectiveDate: '2026-07-01', expirationDate: '',
      effectivenessStatus: '有效',
      summary: '2025 年度广东省全口径城镇单位就业人员月平均工资为 8800 元（示例），作为 2026 社保年度缴费基数上下限的核算依据。（演示数据）',
      content: '根据广东省统计局数据，2025 年度全省全口径城镇单位就业人员月平均工资为 8800 元（演示数据）。\n各地级以上市以此为基准确定 2026 社保年度企业职工基本养老保险缴费基数上下限。',
      keywords: ['平均工资', '广东', '缴费基数', '社平工资'],
      indicators: [ind('全口径月平均工资', '8800', { unit: '元/月', note: '2025 年度，演示数据' })],
      sourceUrl: 'http://hrss.gd.gov.cn/example-avg', viewCount: 66,
    }),
  ];

  d.policies = policies;
  d.versions = [];
  d.audits = [];
  d.crawlRuns = [];
  d.feedbacks = [];
  d.subscriptions = [];
  d.intakes = [];
  d.modifications = [];

  // 版本链（含一条「修订」示例，便于演示版本差异）
  const ver = (pol, version, changeType, changes, extra = {}) => ({
    id: db.uid('ver'),
    policyId: pol.id,
    version,
    changeType,
    changes,
    operator: { id: 'sys', name: '系统导入', role: '系统' },
    opinion: changeType === '新增' ? '示例数据初始化' : '示例数据初始化（修订演示）',
    createdAt: pol.updatedAt,
    ...extra,
  });
  const szOld = policies[1];
  const szNew = policies[0];
  d.versions.push(
    ver(szOld, 1, '新增', [
      { field: 'indicators.月最低工资标准', label: '月最低工资标准', old: null, new: '2360 元/月', risk: 'high' },
    ]),
  );
  d.versions.push(ver(szNew, 1, '新增', [
    { field: 'indicators.月最低工资标准', label: '月最低工资标准', old: null, new: '2420 元/月', risk: 'high' },
  ]));
  // 把深圳 2360→2420 当作「修订 v2」版本演示：version=2, changeType 修订
  d.versions.push({
    id: db.uid('ver'), policyId: szNew.id, version: 2, changeType: '修订',
    changes: [
      { field: 'indicators.月最低工资标准', label: '月最低工资标准', old: '2360 元/月', new: '2420 元/月', risk: 'high', note: '较旧版上调 60 元/月' },
      { field: 'indicators.小时最低工资标准', label: '小时最低工资标准', old: '22.2 元/小时', new: '23.7 元/小时', risk: 'high' },
      { field: 'effectiveDate', label: '生效日期', old: '2022-01-01', new: '2025-03-01', risk: 'high' },
    ],
    operator: { id: 'u_mgr', name: '李经理', role: '经理' },
    opinion: '经审核新版文件后确认调整（演示）',
    createdAt: szNew.updatedAt,
    createdBy: { id: 'u_emp', name: '陈科宇', role: '员工' },
    aiReview: { score: 96, riskLevel: '高', suggestion: '建议通过（已核原文）' },
  });
  d.meta.updatedAt = db.nowIso();
  db.save();
  return true;
}

module.exports = { seedIfEmpty };
