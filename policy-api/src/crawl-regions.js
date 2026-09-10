'use strict';

const PROVINCES = [
  { key: '北京', name: '北京市', root: 'https://www.beijing.gov.cn' },
  { key: '天津', name: '天津市', root: 'https://www.tj.gov.cn' },
  { key: '河北', name: '河北省', root: 'https://www.hebei.gov.cn' },
  { key: '山西', name: '山西省', root: 'https://www.shanxi.gov.cn' },
  { key: '内蒙古', name: '内蒙古自治区', root: 'https://www.nmg.gov.cn' },
  { key: '辽宁', name: '辽宁省', root: 'https://www.ln.gov.cn' },
  { key: '吉林', name: '吉林省', root: 'https://www.jl.gov.cn' },
  { key: '黑龙江', name: '黑龙江省', root: 'https://www.hlj.gov.cn' },
  { key: '上海', name: '上海市', root: 'https://www.shanghai.gov.cn' },
  { key: '江苏', name: '江苏省', root: 'https://www.jiangsu.gov.cn' },
  { key: '浙江', name: '浙江省', root: 'https://www.zj.gov.cn' },
  { key: '安徽', name: '安徽省', root: 'https://www.ah.gov.cn' },
  { key: '福建', name: '福建省', root: 'https://www.fujian.gov.cn' },
  { key: '江西', name: '江西省', root: 'https://www.jiangxi.gov.cn' },
  { key: '山东', name: '山东省', root: 'https://www.shandong.gov.cn' },
  { key: '河南', name: '河南省', root: 'https://www.henan.gov.cn' },
  { key: '湖北', name: '湖北省', root: 'https://www.hubei.gov.cn' },
  { key: '湖南', name: '湖南省', root: 'https://www.hunan.gov.cn' },
  { key: '广东', name: '广东省', root: 'https://www.gd.gov.cn' },
  { key: '广西', name: '广西壮族自治区', root: 'https://www.gxzf.gov.cn' },
  { key: '海南', name: '海南省', root: 'https://www.hainan.gov.cn' },
  { key: '重庆', name: '重庆市', root: 'https://www.cq.gov.cn' },
  { key: '四川', name: '四川省', root: 'https://www.sc.gov.cn' },
  { key: '贵州', name: '贵州省', root: 'https://www.guizhou.gov.cn' },
  { key: '云南', name: '云南省', root: 'https://www.yn.gov.cn' },
  { key: '西藏', name: '西藏自治区', root: 'https://www.xizang.gov.cn' },
  { key: '陕西', name: '陕西省', root: 'https://www.shaanxi.gov.cn' },
  { key: '甘肃', name: '甘肃省', root: 'https://www.gansu.gov.cn' },
  { key: '青海', name: '青海省', root: 'https://www.qinghai.gov.cn' },
  { key: '宁夏', name: '宁夏回族自治区', root: 'https://www.nx.gov.cn' },
  { key: '新疆', name: '新疆维吾尔自治区', root: 'https://www.xinjiang.gov.cn' },
];

const REGIONS = ['全国', ...PROVINCES.map((x) => x.key)];
const CATEGORY_KEYWORDS = [
  '最低工资标准', '平均工资 标准', '公积金 缴存基数', '企业年金 免税', '大病医疗 个税 扣除',
  '大病医疗 互助', '职工大病医保', '高温津贴 标准', '残疾人就业 减免', '残疾人 残保金',
  '残疾 就业保障金', '产假 育儿假 天数', '病假工资 标准',
];

const REGION_BATCHES = [
  { id: 'all', label: '全部', regions: REGIONS },
  { id: 'national', label: '全国专项', regions: ['全国'] },
  { id: 'north', label: '华北', regions: ['北京', '天津', '河北', '山西', '内蒙古'] },
  { id: 'northeast', label: '东北', regions: ['辽宁', '吉林', '黑龙江'] },
  { id: 'east', label: '华东', regions: ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东'] },
  { id: 'central', label: '华中', regions: ['河南', '湖北', '湖南'] },
  { id: 'south', label: '华南', regions: ['广东', '广西', '海南'] },
  { id: 'southwest', label: '西南', regions: ['重庆', '四川', '贵州', '云南', '西藏'] },
  { id: 'northwest', label: '西北', regions: ['陕西', '甘肃', '青海', '宁夏', '新疆'] },
];

const BATCH_BY_ID = new Map(REGION_BATCHES.map((x) => [x.id, x]));

function batchById(id) { return BATCH_BY_ID.get(String(id || 'all')) || BATCH_BY_ID.get('all'); }
function regionsForBatch(id) { return batchById(id).regions.slice(); }
function batchForRegion(region) {
  if (region === '全国') return BATCH_BY_ID.get('national');
  return REGION_BATCHES.find((x) => x.id !== 'all' && x.regions.includes(region)) || BATCH_BY_ID.get('all');
}

function provinceByKey(key) { return PROVINCES.find((x) => x.key === key) || null; }
function provinceByName(name) { return PROVINCES.find((x) => x.name === name) || null; }
function normalizeProvinceName(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const byKey = provinceByKey(s);
  if (byKey) return byKey.name;
  const byName = provinceByName(s);
  if (byName) return byName.name;
  return s;
}

module.exports = {
  PROVINCES, REGIONS, CATEGORY_KEYWORDS, REGION_BATCHES,
  provinceByKey, provinceByName, normalizeProvinceName,
  batchById, regionsForBatch, batchForRegion,
};
