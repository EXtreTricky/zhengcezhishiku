'use strict';

/**
 * 十类政策专题表元数据 —— 与 policy-kb bitable.service.ts POLICY_SOURCES 逐字段一致
 * （category/appToken/tableId/viewId + 标题拼接用的 label/valueFields/dateFields）。
 * 这是 policy-api 数据层的地基：所有记录聚合、分类注入、标题兜底都依赖它。
 */

const POLICY_SOURCES = [
  {
    category: '最低工资',
    label: '最低工资标准',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tbl6zo6GH73o7HCo',
    viewId: 'vewYtzY205',
    valueFields: ['最低工资', '就高标准'],
    dateFields: ['生效日期'],
  },
  {
    category: '平均工资',
    label: '平均工资标准',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblYOIHK197irNrU',
    viewId: 'vewYtzY205',
    valueFields: ['平均工资', '经济补偿金免税上限'],
    dateFields: ['发文日期', '生效月'],
  },
  {
    category: '公积金',
    label: '公积金缴存基数上限',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblkBIk3hsAJI2f1',
    viewId: 'vewYtzY205',
    valueFields: ['公积金基数上限', '公积金免税上限'],
    dateFields: ['发文日期', '生效月'],
  },
  {
    category: '年金',
    label: '年金免税上限',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblCx9McD76MMuHM',
    viewId: 'vewYtzY205',
    valueFields: ['年金免税上限'],
    dateFields: ['生效月'],
  },
  {
    category: '大病医疗',
    label: '大病医疗扣除',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblRusUfXr3l9H3f',
    viewId: 'vewTypk3EJ',
    valueFields: ['金额', '大病医疗个人是否允许税前扣除'],
    dateFields: ['发文日期'],
  },
  {
    category: '高温津贴',
    label: '高温津贴标准',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblibNKtoMEvDzLn',
    viewId: 'vewYtzY205',
    valueFields: ['高温津贴政策', '发放月份'],
    dateFields: ['执行日期'],
  },
  {
    category: '残疾职工',
    label: '残疾职工减免',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tbloaPh7Ibkcya1F',
    viewId: 'vewYtzY205',
    valueFields: ['减免比例', '减免限额'],
    dateFields: ['生效日期', '有效期限'],
  },
  {
    category: '婚育相关',
    label: '婚育假期',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblrqb41cSWg5AAd',
    viewId: 'vewYtzY205',
    valueFields: ['天数-产假', '天数-婚假', '天数-陪产假', '天数-育儿假（夫妻双方各享）'],
    dateFields: ['周期'],
  },
  {
    category: '病假工资',
    label: '病假工资政策',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblPhHiWxKkMUl28',
    viewId: 'vewYtzY205',
    valueFields: ['病假工资政策'],
    dateFields: ['发文日期'],
  },
  {
    category: '薪酬月刊',
    label: '薪酬月刊',
    appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe',
    tableId: 'tblW6cBMQNXgbISR',
    viewId: 'vewDfXjRIJ',
    valueFields: ['目录'],
    dateFields: ['年份', '月份'],
  },
];

module.exports = { POLICY_SOURCES };
