const { execSync } = require('child_process');

const PROVINCE = process.argv[2] || '河北';
const PAGES = parseInt(process.argv[3] || '10', 10);

function abEval(js) {
  try {
    const out = execSync(`agent-browser eval "${js.replace(/"/g, '\\"')}"`, { timeout: 15000, encoding: 'utf8' });
    // agent-browser returns: "result\n" with quotes
    return JSON.parse(JSON.parse(out));
  } catch (e) {
    console.error('eval error:', e.message?.slice(0, 100));
    return null;
  }
}

function abCmd(cmd) {
  try { return execSync(`agent-browser ${cmd}`, { timeout: 20000, encoding: 'utf8' }); }
  catch (e) { return e.stdout || e.message; }
}

(async () => {
  if (PROVINCE === '河北') {
    // 河北：Ant Design Vue SPA，zxdtChild?isId=1006&id=1
    const baseUrl = 'https://rst.hebei.gov.cn/zxdtChild?isId=1006&id=1';
    console.log(`[browser-crawl] 河北 ${PAGES}页 starting...`);
    abCmd(`open "${baseUrl}"`);
    await new Promise(r => setTimeout(r, 3000));

    const allItems = [];
    for (let p = 1; p <= PAGES; p++) {
      if (p > 1) {
        abEval(`document.querySelector('.ant-pagination-item-${p}')?.click()`);
        await new Promise(r => setTimeout(r, 2500));
      }
      const js = `JSON.stringify([...document.querySelectorAll('table tbody tr')].map(tr=>{var c=tr.querySelectorAll('td');return{t:c[0]?c[0].textContent.trim():'',d:c[1]?c[1].textContent.trim():'',k:tr.dataset.rowKey||''}}).filter(r=>r.t&&r.k))`;
      const items = abEval(js) || [];
      for (const it of items) {
        if (!it.t || it.t.length < 5) continue;
        const date = (it.d || '').split(' ')[0];
        allItems.push({
          url: `https://rst.hebei.gov.cn/pageWarp?isId=${it.k}&id=1`,
          title: it.t,
          publishDate: date.match(/^\d{4}-\d{2}-\d{2}$/) ? date : '',
          province: '河北省',
          channel: '省人社厅·通知公告',
        });
      }
      console.log(`  第${p}页: ${items.length}条, 累计${allItems.length}`);
    }
    abCmd('close');
    // 输出 JSON
    const outPath = '.workbuddy/_browser-crawl-河北.json';
    require('fs').writeFileSync(outPath, JSON.stringify(allItems, null, 1));
    console.log(`[browser-crawl] 完成: ${allItems.length}条 → ${outPath}`);
    // 分类统计
    try {
      const { classifyCategory } = require('./policy-api/src/crawl-api');
      const byCat = {};
      for (const it of allItems) {
        const c = classifyCategory(it.title);
        if (c && c !== '薪酬月刊') byCat[c] = (byCat[c] || 0) + 1;
      }
      const hitN = Object.values(byCat).reduce((a, b) => a + b, 0);
      console.log(`白名单命中: ${hitN}`, JSON.stringify(byCat));
    } catch (e) { /* classifyCategory 可能需要 dotenv */ }
  } else if (PROVINCE === '四川') {
    // 四川：JS渲染壳页
    const url = 'https://rst.sc.gov.cn/rst/gsgg/zfxxgkpage.shtml';
    console.log(`[browser-crawl] 四川 starting...`);
    const r = abCmd(`open "${url}"`);
    console.log('open result:', r.trim());
    if (r.includes('ERR_EMPTY_RESPONSE') || r.includes('failed')) {
      console.log('四川网络不可达，跳过');
      abCmd('close');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 4000));
    // 提取列表数据
    const js = `JSON.stringify([...document.querySelectorAll('li, tr, .list-item')].map(e=>({t:e.textContent?.trim()?.slice(0,50),h:e.querySelector('a')?.href||''})).filter(e=>e.t&&e.t.length>5).slice(0,20))`;
    const items = abEval(js) || [];
    console.log(`四川渲染后找到 ${items.length} 个元素`);
    for (const it of items.slice(0, 10)) console.log('  ', it.t?.slice(0, 50), '|', it.h?.slice(0, 60));
    abCmd('close');
  }
})();
