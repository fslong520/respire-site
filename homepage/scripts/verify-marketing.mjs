import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';

const dist=resolve(process.env.VITE_SITE_OUT_DIR || '../site/dist/client');
const base=process.env.VITE_SITE_BASE || '/';
const screenshots=process.env.SITE_SCREENSHOTS;
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(!url.pathname.startsWith(base)){res.writeHead(404).end();return;}
  let name=decodeURIComponent(url.pathname.slice(base.length));
  if(!name || name.endsWith('/'))name+='index.html';
  const file=resolve(dist,name);
  if(!file.startsWith(dist+sep) || !existsSync(file)){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':types[extname(file)] || 'application/octet-stream'}).end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});
const errors=[];
try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+base);
  await page.getByRole('heading',{level:1}).waitFor();
  assert.match(await page.locator('h1').innerText(),/Memory as/);
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.getByRole('link',{name:'Sign in',exact:true}).getAttribute('href'),process.env.VITE_DASHBOARD_URL || 'https://dash.rsrs.rs');
  assert.ok((await page.locator('body').innerText()).includes('npm i -g @rsrsai/cli'));
  assert.doesNotMatch(await page.locator('body').innerText(),/DESIGN PREVIEW|No live services|proprietary components/);
  await page.locator('[data-memory-body]').waitFor();
  await page.waitForFunction(()=>['ready','fallback','unavailable','setup-error'].includes(document.querySelector('[data-gpu-status]')?.dataset.gpuStatus));
  const gpuStatus=await page.locator('[data-gpu-status]').getAttribute('data-gpu-status');
  assert.notEqual(gpuStatus,'setup-error');
  const sculpture=page.getByRole('group',{name:/Slowly breathing memory fibers/});
  await sculpture.focus();await sculpture.press('p');
  assert.equal(await page.locator('[data-memory-body]').getAttribute('data-paused'),'true');
  await sculpture.press('p');
  assert.equal(await page.locator('[data-memory-body]').getAttribute('data-paused'),'false');
  if(screenshots){mkdirSync(screenshots,{recursive:true});await page.screenshot({path:resolve(screenshots,'desktop.png'),fullPage:true});}
  await page.getByRole('button',{name:'How do I get started?',exact:true}).click();
  assert.ok(await page.getByText('Install @rsrsai/cli with npm, run rsrs doctor,',{exact:false}).isVisible());
  await page.getByRole('button',{name:'中文',exact:true}).click();
  assert.equal(new URL(page.url()).pathname,base+'zh/');
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  await page.reload();
  assert.match(await page.locator('h1').innerText(),/记忆/);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  const menu=page.getByRole('button',{name:'切换导航',exact:true});
  await menu.click();assert.equal(await menu.getAttribute('aria-expanded'),'true');
  await page.keyboard.press('Escape');assert.equal(await menu.getAttribute('aria-expanded'),'false');
  if(screenshots)await page.screenshot({path:resolve(screenshots,'mobile-zh.png'),fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload();
  await page.locator('.narrative-strand-ink').waitFor({state:'attached'});
  await page.waitForFunction(()=>document.querySelector('.narrative-strand-ink')?.style.strokeDashoffset==='0');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,base,gpu_status:gpuStatus,checks:['English rendering','production links','installation','no demo notices','animation pause/resume','FAQ','Chinese URL and reload','mobile overflow/menu','reduced motion','no page errors']}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
