// Drives the real UI in Edge over the DevTools Protocol to prove it runs without JS errors.
// Zero dependencies: Node 24 has a native WebSocket.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
const BASE = 'http://127.0.0.1:7701';
const OUT = process.argv[2] ?? 'data/ui';

const profile = mkdtempSync(join(tmpdir(), 'jarvis-edge-'));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Edge DevTools endpoint did not come up');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
    return r.result?.value;
  }
}

const log = (...a) => console.log(...a);

async function main() {
  const cdp = await Cdp.connect(await target());
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const problems = [];
  const collect = () => {
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        problems.push('EXCEPTION: ' + (e.params.exceptionDetails?.exception?.description
          ?? e.params.exceptionDetails?.text ?? '').split('\n')[0]);
      }
      if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
        problems.push(`CONSOLE.${e.params.type}: ` +
          e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 220));
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'
          && !/status of 4\d\d/.test(e.params.entry.text ?? '')) {
        problems.push('LOG: ' + e.params.entry.text.slice(0, 220));
      }
      if (e.method === 'Network.loadingFailed') {
        problems.push(`NETWORK FAIL: ${e.params.errorText}`);
      }
      // A 4xx from a GATE is the product working, not a defect: every control here is a
      // refusal, and the browser logs each one as a failed resource load. Only 5xx and
      // transport failures indicate something broken.
      if (e.method === 'Log.entryAdded' && /status of 5\d\d/.test(e.params.entry.text ?? '')) {
        problems.push('SERVER ERROR: ' + e.params.entry.text.slice(0, 200));
      }
    }
    cdp.events.length = 0;
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}-${name}.png`, Buffer.from(r.data, 'base64'));
    log(`   screenshot → ${OUT}-${name}.png`);
  };

  log('--- load landing');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);
  collect();

  const title = await cdp.eval(`document.querySelector('h1')?.textContent ?? '(none)'`);
  const agents = await cdp.eval(`document.querySelectorAll('.card-selectable').length`);
  const stages = await cdp.eval(`document.querySelectorAll('.stage-chip').length`);
  const lifecycle = await cdp.eval(`document.querySelectorAll('.lifecycle span').length`);
  log(`   hero="${title}" · agent cards=${agents} · stage chips=${stages} · lifecycle chips=${lifecycle}`);
  await shot('01-landing');

  // FR-NAV-008: all 11 stage chips must render, none truncated away.
  log(`   FR-NAV-008 stage rail: ${stages === 11 ? 'all 11 present' : `ONLY ${stages} — FAIL`}`);

  log('--- Action mode (search)');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Action mode').click()`);
  await sleep(400);
  await cdp.eval(`
    const i = document.getElementById('skill-search');
    i.value = 'pull request';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(500);
  const found = await cdp.eval(`document.querySelectorAll('#action-results .card-selectable').length`);
  const badge = await cdp.eval(`[...document.querySelectorAll('.chip')].map(c=>c.textContent).filter(t=>t.includes('approval required'))[0] ?? '(none)'`);
  log(`   search "pull request" → ${found} skill(s) · write badge: "${badge}"`);
  collect();
  await shot('02-action-mode');

  log('--- Workflow mode');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='SDLC Workflow mode').click()`);
  await sleep(400);
  const stageCards = await cdp.eval(`document.querySelectorAll('.grid-3 .card').length`);
  log(`   stage cards: ${stageCards}`);
  collect();
  await shot('03-workflow-mode');

  log('--- Agent mode → Product → Generate PRD form (gate G1)');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Agent mode').click()`);
  await sleep(300);
  await cdp.eval(`[...document.querySelectorAll('.card-selectable')].find(c=>c.textContent.includes('Product')).click()`);
  await sleep(400);
  await cdp.eval(`[...document.querySelectorAll('.card-selectable')].find(c=>c.textContent.includes('Generate PRD')).click()`);
  await sleep(1800);
  collect();

  const formOpen = await cdp.eval(`!!document.querySelector('.modal')`);
  const fields = await cdp.eval(`document.querySelectorAll('.modal .field').length`);
  const estimate = await cdp.eval(`
    [...document.querySelectorAll('.modal .chip')].map(c=>c.textContent).find(t=>t.includes('premium requests')) ?? '(no estimate)'
  `);
  const startDisabled = await cdp.eval(`document.querySelector('.modal .btn-primary')?.disabled`);
  log(`   form open=${formOpen} · fields=${fields} · estimate="${estimate}" · Generate disabled=${startDisabled}`);
  await shot('04-g1-input-form');

  log('--- fill required fields and start the run');
  await cdp.eval(`
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return 'missing:' + id;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    };
    set('in-ideaSource', 'Cryptographic cart-hash assurance for agentic intent flows');
    set('in-supportingMaterial', 'Merchants report disputes where the agent-submitted cart cannot be proven unchanged at authorisation.');
    set('in-epicUrl', 'MCSE-731');
    // Turn ON the optional accuracy scorecard so the G4 gate is exercised in this run.
    const sc = document.querySelector('.modal input[type=checkbox]');
    if (sc && !sc.checked) { sc.checked = true; sc.dispatchEvent(new Event('change', { bubbles: true })); }
  `);
  await sleep(1400);
  const canStart = await cdp.eval(`!document.querySelector('.modal .btn-primary')?.disabled`);
  log(`   Continue enabled=${canStart}`);
  await shot('05-g1-filled');

  // Two-step flow: Continue opens the generator at the Configure tab.
  await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Continue')).click()`);
  await sleep(2500);
  collect();
  const cfgSelects = await cdp.eval(`document.querySelectorAll('#cfg-writer-model, #cfg-captain-model').length`);
  const genBtn = await cdp.eval(`!![...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Generate document'))`);
  log(`--- Configure tab: model selects=${cfgSelects} · Generate button=${genBtn}`);
  await shot('05b-configure');
  // Pick a writer model and a Captain model, then Generate.
  await cdp.eval(`
    const w = document.getElementById('cfg-writer-model');
    if (w && w.options.length > 1) { w.selectedIndex = Math.min(1, w.options.length-1); w.dispatchEvent(new Event('change',{bubbles:true})); }
  `);
  await sleep(800);
  await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Generate document')).click()`);
  log('   generation started — waiting…');

  let state = '';
  for (let i = 0; i < 70; i++) {
    await sleep(1000);
    state = await cdp.eval(`
      (() => {
        const head = document.querySelector('.modal-head');
        return head ? head.textContent.replace(/\\s+/g,' ').slice(0,120) : '(no modal)';
      })()
    `);
    if (i === 3) await shot('06-generating');
    const reviews = await cdp.eval(`document.body.textContent.includes('reviews')`);
    if (state.includes('Verdict ready')) break;
    if (i % 5 === 0) log(`   …${state}`);
  }
  log(`   modal head: ${state}`);
  collect();

  log('--- Self & Peer Eval tab (council runs only)');
  const hasPeer = await cdp.eval(`!![...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('Self & Peer'))`);
  if (hasPeer) {
    await cdp.eval(`[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('Self & Peer')).click()`);
    await sleep(900);
    const matrixCells = await cdp.eval(`document.querySelectorAll('table[role="grid"] tbody td').length`);
    const selfBadges = await cdp.eval(`[...document.querySelectorAll('.badge-self')].length`);
    const contested = await cdp.eval(`[...document.querySelectorAll('.chip')].filter(c=>c.textContent.includes('Contested')).length`);
    const consensus = await cdp.eval(`document.body.textContent.includes('Common concerns')`);
    log(`   matrix cells=${matrixCells} · Self badges=${selfBadges} · contested chips=${contested} · consensus panel=${consensus}`);
    collect();
    await shot('07-peer-eval');
  } else {
    log('   solo run — single writer, so the Captain reviews one draft (no peer evaluation tab)');
  }

  log('--- Evaluation tab (Captain score, solo runs)');
  const hasEval = await cdp.eval(`!![...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Evaluation')`);
  if (hasEval) {
    await cdp.eval(`[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Evaluation').click()`);
    await sleep(900);
    const meters = await cdp.eval(`document.querySelectorAll('#council-body .meter').length`);
    const scoreTile = await cdp.eval(`!!document.querySelector('#council-body .score-tile')`);
    log(`   score tile=${scoreTile} · rubric meters=${meters}`);
    collect();
    await shot('07b-evaluation');
    // Proceed to the Captain's Review from the Evaluation screen.
    await cdp.eval(`[...document.querySelectorAll('#council-body .btn')].find(b=>b.textContent.includes("Proceed to Captain"))?.click()`);
    await sleep(700);
  }

  log('--- Compare tab');
  const hasCompare = await cdp.eval(`!![...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Compare')`);
  if (hasCompare) {
    await cdp.eval(`[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Compare').click()`);
    await sleep(900);
    const panes = await cdp.eval(`document.querySelectorAll('.compare-pane-wrap').length`);
    const phWarn = await cdp.eval(`!![...document.querySelectorAll('.banner-danger')].find(b=>b.textContent.includes('placeholder'))`);
    log(`   panes=${panes} · placeholder warning shown=${phWarn}`);
    collect();
    await shot('08-compare');
  }

  log("--- Captain's Pick");
  await cdp.eval(`[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes("Captain")).click()`);
  await sleep(900);
  const sugs = await cdp.eval(`document.querySelectorAll('.check-opt').length`);
  const bases = await cdp.eval(`document.querySelectorAll('input[name="base"]').length`);
  const winnerBadge = await cdp.eval(`!![...document.querySelectorAll('.badge-winner')].length`);
  const primaryLabel = await cdp.eval(`
    [...document.querySelectorAll('.btn-primary')].map(b=>b.textContent.trim()).find(t=>t.startsWith('Build')||t.startsWith('Use')) ?? '(none)'
  `);
  const analysis = await cdp.eval(`!![...document.querySelectorAll('details summary')].find(s=>s.textContent.includes('full analysis'))`);
  log(`   base radios=${bases} · suggestions=${sugs} · winner badge=${winnerBadge} · full analysis disclosure=${analysis}`);
  log(`   primary action: "${primaryLabel}"`);
  collect();
  await shot('09-captains-pick');

  log('--- apply the decision (cherry-pick improvements if the Captain offered any)');
  const hasSuggestions = await cdp.eval(`document.querySelectorAll('.check-opt input[type=checkbox]').length > 0`);
  if (hasSuggestions) {
    await cdp.eval(`
      const boxes = [...document.querySelectorAll('.check-opt input[type=checkbox]')].slice(0,2);
      boxes.forEach(b => { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); });
    `);
    await sleep(600);
    const countLabel = await cdp.eval(`
      [...document.querySelectorAll('.small')].map(s=>s.textContent).find(t=>/\\d+\\/\\d+ selected/.test(t)) ?? '(none)'
    `);
    log(`   selection count: "${countLabel}"`);
  } else {
    log('   solo review — no cherry-pick suggestions; using the reviewed draft unchanged');
  }
  await shot('10-cherry-picked');

  // Primary action is "Build … with N improvements" on a council, or "Use … unchanged" on a solo review.
  await cdp.eval(`
    [...document.querySelectorAll('.btn-primary')].find(b=>/^(Build|Use)\\b/.test(b.textContent.trim())).click()
  `);
  await sleep(3500);
  collect();

  const gateTitle = await cdp.eval(`document.querySelector('.modal-head h2')?.textContent ?? '(none)'`);
  log(`   → next gate: "${gateTitle}"`);
  await shot('11-g4-scorecard');

  const rows = await cdp.eval(`document.querySelectorAll('.modal tbody tr').length`);
  const continueDisabled = await cdp.eval(`
    [...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Continue to approval'))?.disabled
  `);
  log(`   scorecard rows=${rows} · "Continue to approval" disabled=${continueDisabled} (must be true while unscored)`);

  log('--- score every section');
  await cdp.eval(`
    (async () => {
      const rows = [...document.querySelectorAll('.modal tbody tr')];
      for (const r of rows) {
        const nums = r.querySelectorAll('input[type=number]');
        const sel = r.querySelector('select');
        if (nums.length < 3 || !sel) continue;
        nums[0].value = '4'; nums[0].dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(x => setTimeout(x, 90));
        nums[1].value = '1'; nums[1].dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(x => setTimeout(x, 90));
        nums[2].value = '78'; nums[2].dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(x => setTimeout(x, 90));
        sel.value = 'minor_rework'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(x => setTimeout(x, 260));
      }
    })()
  `);
  await sleep(2500);
  collect();
  const nowEnabled = await cdp.eval(`
    !([...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Continue to approval'))?.disabled)
  `);
  const agg = await cdp.eval(`
    [...document.querySelectorAll('.modal .chip')].map(c=>c.textContent).filter(t=>t.includes('accuracy')||t.includes('saving')).join(' · ')
  `);
  log(`   all scored → Continue enabled=${nowEnabled} · aggregates: ${agg}`);
  await shot('12-g4-complete');

  log('--- G5 approval gate');
  await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Continue to approval')).click()`);
  await sleep(3000);
  collect();

  // FR-GEN-005 blocks publication when the chosen draft admits a gap, and the block surfaces
  // HERE at G5. The resolution is a recorded human edit (FR-REVIEW-004), offered in place —
  // exercise it, because it is the path a reviewer actually takes.
  const blockedByGap = await cdp.eval(`
    !![...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.trim()==='Edit to resolve')
  `);
  if (blockedByGap) {
    log('   FR-GEN-005 blocked publication — resolving via the in-place editor');
    await shot('13a-g5-blocked');
    await cdp.eval(`[...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.trim()==='Edit to resolve').click()`);
    await sleep(1000);
    await cdp.eval(`
      const tas = [...document.querySelectorAll('.modal textarea')];
      const ta = tas[tas.length - 1];
      ta.value = ta.value.replace(/- TBD \\[UNKNOWN[^\\]]*\\]/g,
        '- Target release window: Q3, confirmed with the delivery lead.');
      const s = document.getElementById('edit-summary');
      if (s) s.value = 'Supplied the missing release window.';
    `);
    await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Save revision')).click()`);
    await sleep(2500);
    collect();
    const cleared = await cdp.eval(`
      !([...document.querySelectorAll('.modal .banner-danger')].some(b=>b.textContent.includes('placeholder')))
    `);
    log(`   human edit saved · placeholder block cleared: ${cleared}`);
    await shot('13b-after-edit');
  }
  const g5 = await cdp.eval(`document.querySelector('.modal-head h2')?.textContent ?? '(none)'`);
  const preflight = await cdp.eval(`
    [...document.querySelectorAll('.modal .row.small')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()).filter(t=>t.length>8).slice(0,8)
  `);
  const blocked = await cdp.eval(`
    [...document.querySelectorAll('.modal .banner-danger')].map(b=>b.textContent.replace(/\\s+/g,' ').slice(0,160))
  `);
  log(`   gate: "${g5}"`);
  for (const p of preflight ?? []) log(`     ${p}`);
  if (blocked?.length) for (const b of blocked) log(`     BLOCKED: ${b}`);
  await shot('13-g5-approval');

  log('--- approve and publish');
  const approveBtn = await cdp.eval(`
    !!([...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Approve and publish')))
  `);
  if (approveBtn) {
    await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Approve and publish')).click()`);
    await sleep(3000);
    collect();
    const result = await cdp.eval(`
      [...document.querySelectorAll('.modal .banner')].map(b=>b.textContent.replace(/\\s+/g,' ').slice(0,180))[0] ?? '(none)'
    `);
    log(`   result: ${result}`);
    await shot('14-publish-result');
  } else {
    log('   Approve button not available (a pre-flight check is blocking) — this is the gate working.');
  }

  log('--- light theme');
  await cdp.eval(`document.documentElement.dataset.theme = 'light'`);
  await sleep(600);
  await shot('15-light-theme');
  await cdp.eval(`document.documentElement.dataset.theme = 'dark'`);

  log('--- admin console');
  await cdp.eval(`[...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.trim()==='Done')?.click()`);
  await sleep(500);
  await cdp.eval(`[...document.querySelectorAll('.rail .btn')].find(b=>b.textContent.trim()==='Admin console').click()`);
  await sleep(2200);
  collect();
  const recon = await cdp.eval(`
    [...document.querySelectorAll('.banner')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()).find(t=>t.includes('reconcile')) ?? '(none)'
  `);
  log(`   reconciliation: ${recon}`);
  await shot('16-admin-console');

  collect();
  log('\n=== CONSOLE / NETWORK PROBLEMS ===');
  const unique = [...new Set(problems)];
  if (unique.length === 0) log('   none — the UI ran clean.');
  else for (const p of unique) log('   ' + p);

  cdp.ws.close();
  edge.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(unique.length ? 2 : 0);
}

main().catch((e) => {
  console.error('UI CHECK FAILED:', e.message);
  edge.kill();
  process.exit(1);
});
