import { chromium } from 'playwright-core';
const CASE='6af8e2a424afc297fb28bb25', BASE='http://localhost:5173';
const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const ctx=await b.newContext({viewport:{width:1440,height:810},deviceScaleFactor:4/3});
const p=await ctx.newPage();
await p.goto(BASE+'/login');
await p.fill('input[type=email]','ananya.demo@tracevault.test');
await p.fill('input[type=password]','tracevault-demo-password');
await p.click('button:has-text("Sign in")');
await p.waitForURL('**/cases**');
const tidy=()=>{
  document.querySelectorAll('*').forEach(h=>{if(h.children.length===0&&!['SCRIPT','STYLE'].includes(h.tagName))h.textContent=h.textContent.replace(/\s*\(demo \d{4}[^)]*\)/,'');});
  document.querySelectorAll('h1').forEach(h=>{h.textContent=h.textContent.replace(/\s*\(demo[^)]*\)/,'');});
  document.querySelectorAll('*').forEach(e=>{
    const s=getComputedStyle(e); if(s.position!=='fixed'&&s.position!=='sticky') return;
    const r=e.getBoundingClientRect();
    if(r.top>400||/Quick exit|Discreet|English/.test(e.textContent)&&r.height<80&&r.top>400){e.style.display='none';return;}
  });
  document.querySelectorAll('*').forEach(e=>{const s=getComputedStyle(e);if(s.position==='fixed'){const r=e.getBoundingClientRect();if(r.top>600)e.style.display='none';}});
};
async function shot(name,url,wait=2500,pre){
  await p.evaluate(u=>{history.pushState({},'',u);dispatchEvent(new PopStateEvent('popstate'));},url); await p.waitForTimeout(wait);
  if(pre) await pre(); await p.evaluate(()=>scrollTo(0,0)); await p.evaluate(tidy); await p.waitForTimeout(300);
  await p.screenshot({path:`public/${name}.png`,fullPage:true});
  console.log(name,await p.evaluate(()=>document.body.scrollHeight));
}
const only=process.argv.slice(2); const want=(n)=>!only.length||only.includes(n);
const CASEURL=`/cases/${CASE}`;
if(want('dashboard')) await shot('dashboard','/cases',3500);
if(want('settings')) await shot('settings',`${CASEURL}/settings`);
await b.close();
