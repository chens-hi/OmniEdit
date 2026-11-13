import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE='http://127.0.0.1:8899';
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const D='D:\\Workspaces\\OmniEdit\\preview-test\\large\\';
fs.writeFileSync(D+'fg.js','function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n');
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await (await browser.newContext({viewport:{width:800,height:400}})).newPage();
await page.goto(BASE+'/app/omniedit/?path='+encodeURIComponent(D+'fg.js'), {waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__omnieditView?.state?.doc?.length>0,{timeout:20000});
await new Promise(r=>setTimeout(r,1500));

const probe = (label) => page.evaluate((lbl) => {
  const sc = document.querySelector('.cm-scroller');
  const gutters = [...document.querySelectorAll('.cm-gutters > .cm-gutter')];
  const gutBox = document.querySelector('.cm-gutters').getBoundingClientRect();
  const scR = sc.getBoundingClientRect();
  // 滚动条：offsetWidth - clientWidth（叠加式=0，占位式=宽度值）
  const sbReserve = sc.offsetWidth - sc.clientWidth;
  // 是否有可滚动内容
  const scrollable = sc.scrollHeight > sc.clientHeight;
  // 文字区（cm-content）左缘
  const content = document.querySelector('.cm-content');
  const cR = content.getBoundingClientRect();
  return {
    场景: lbl,
    gutter列表: gutters.map(g => {
      const r = g.getBoundingClientRect();
      return { cls: g.className.replace('cm-gutter ',''), w: Math.round(r.width) };
    }),
    gutter总宽: Math.round(gutBox.width),
    滚动条占位宽: sbReserve,
    可滚动: scrollable,
    content左缘距scroller左: Math.round(cR.left - scR.left),
    content右缘距scroller右: Math.round(scR.right - cR.right),
  };
}, label);

// 1) 行号开启
const withLn = await probe('行号开启');
console.log('【行号开启】', JSON.stringify(withLn, null, 1));

// 2) 关闭行号
await page.evaluate(()=>{
  const p=document.querySelector('#app').__vue_app__?.config?.globalProperties?.$pinia;
  p?._s?.get('editor').setShowLineNumbers(false);
});
await new Promise(r=>setTimeout(r,800));
const noLn = await probe('行号关闭');
console.log('【行号关闭】', JSON.stringify(noLn, null, 1));

// 3) 造出长内容让滚动条出现
const longLines = Array.from({length:300},(_,i)=>`line ${i+1} padding content here to fill`).join('\n');
await page.evaluate((txt)=>{ const v=window.__omnieditView; v.dispatch({changes:{from:0,to:v.state.doc.length,insert:txt}}); }, longLines);
await new Promise(r=>setTimeout(r,600));

const withScroll = await page.evaluate(()=>{
  const sc=document.querySelector('.cm-scroller');
  const gutters=[...document.querySelectorAll('.cm-gutters > .cm-gutter')];
  const gutBox=document.querySelector('.cm-gutters').getBoundingClientRect();
  const cR=document.querySelector('.cm-content').getBoundingClientRect();
  const scR=sc.getBoundingClientRect();
  const sbReserve = sc.offsetWidth - sc.clientWidth;
  const scrollable = sc.scrollHeight > sc.clientHeight;
  return {
    场景:'行号关闭+有滚动条',
    gutter列表: gutters.map(g=>({cls:g.className.replace('cm-gutter ',''),w:Math.round(g.getBoundingClientRect().width)})),
    gutter总宽: Math.round(gutBox.width),
    滚动条占位宽: sbReserve,
    可滚动: scrollable,
    content左缘距左: Math.round(cR.left - scR.left),
    content右缘距右: Math.round(scR.right - cR.right),
  };
});
console.log('【行号关闭+有滚动条】', JSON.stringify(withScroll, null, 1));

// 4) 行号开启 + 有滚动条
await page.evaluate(()=>{
  const p=document.querySelector('#app').__vue_app__?.config?.globalProperties?.$pinia;
  p?._s?.get('editor').setShowLineNumbers(true);
});
await new Promise(r=>setTimeout(r,800));
const withBoth = await page.evaluate(()=>{
  const sc=document.querySelector('.cm-scroller');
  const gutters=[...document.querySelectorAll('.cm-gutters > .cm-gutter')];
  const gutBox=document.querySelector('.cm-gutters').getBoundingClientRect();
  const cR=document.querySelector('.cm-content').getBoundingClientRect();
  const scR=sc.getBoundingClientRect();
  const sbReserve = sc.offsetWidth - sc.clientWidth;
  const scrollable = sc.scrollHeight > sc.clientHeight;
  return {
    场景:'行号开启+有滚动条',
    gutter列表: gutters.map(g=>({cls:g.className.replace('cm-gutter ',''),w:Math.round(g.getBoundingClientRect().width)})),
    gutter总宽: Math.round(gutBox.width),
    滚动条占位宽: sbReserve,
    可滚动: scrollable,
    content左缘距左: Math.round(cR.left - scR.left),
    content右缘距右: Math.round(scR.right - cR.right),
  };
});
console.log('【行号开启+有滚动条】', JSON.stringify(withBoth, null, 1));

await browser.close();
try{fs.unlinkSync(D+'fg.js');}catch{}
