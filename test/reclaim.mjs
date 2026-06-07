// Agent-side persistence test: uses the REAL AgentClient + Broker. Asserts that after a tab
// "reload" (socket close + reconnect with same tabId), the agent KEEPS its binding and can
// dispatch WITHOUT calling claim again — i.e. no manual re-claim after reload/navigate.
import { Broker } from '../src/modeB/broker.js';
import { AgentClient } from '../src/modeB/agentClient.js';
import { WebSocket } from 'ws';

const PORT = 7396;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

// A fake browser tab: registers, answers cmds, can "reload" (close + reconnect same id).
function fakeTab(tabId, url = 'http://x/page') {
  let ws;
  const api = { tabId, claimed: false, cmds: [] };
  const open = () =>
    new Promise((res) => {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      api.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'register', role: 'tab', tabId, url, title: 'T' }));
        res();
      });
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'assignTabId') api.tabId = m.tabId;
        if (m.t === 'claimed') api.claimed = true;
        if (m.t === 'released') api.claimed = false;
        if (m.t === 'cmd') {
          api.cmds.push(m);
          ws.send(JSON.stringify({ t: 'result', id: m.id, ok: true, value: { op: m.op, echoed: true } }));
        }
      });
    });
  api.open = open;
  api.reload = async () => { ws.close(); await sleep(200); await open(); await sleep(150); };
  return api;
}

(async () => {
  const broker = new Broker({ port: PORT });
  await broker.start();

  const tab = fakeTab('tabX');
  await tab.open();

  const agent = new AgentClient({ port: PORT, agentId: 'agentA', name: 'Tester' });
  await agent.start();
  await sleep(200);

  // Claim once.
  const claim = await agent.claim({ intent: 'driving' });
  ok(claim.ok && agent.boundTabId === 'tabX', `claimed tabX (bound=${agent.boundTabId})`);

  // Drive a few ops without reclaim.
  const r1 = await agent.dispatch('snapshot', {});
  ok(r1.ok, 'snapshot works while claimed');

  // RELOAD the tab — the crux of the bug. No reclaim afterwards.
  await tab.reload();
  ok(agent.boundTabId === 'tabX', 'after reload, agent STILL has boundTabId (no manual reclaim)');
  ok(tab.claimed, 'reloaded tab is re-marked claimed by the broker');

  const r2 = await agent.dispatch('snapshot', { after: 'reload' });
  ok(r2.ok, 'dispatch works after reload WITHOUT reclaim');

  // Simulate a slower reload: dispatch fired while the tab is briefly gone → should WAIT then work.
  tab.api && null;
  const reloadP = tab.reload(); // start reload
  const r3p = agent.dispatch('click', { selector: '#x' }); // fire during the gap
  await reloadP;
  const r3 = await r3p;
  ok(r3.ok, 'dispatch issued during a reload waits for reconnect, then succeeds');

  // Release → now dispatch should fail (truly unclaimed).
  agent.release();
  await sleep(100);
  const r4 = await agent.dispatch('snapshot', {});
  ok(!r4.ok, 'after release, dispatch correctly reports no claim');

  console.log(failed === 0 ? '\nRECLAIM/PERSISTENCE TESTS PASSED ✓' : `\n${failed} FAILED ✗`);
  process.exit(failed === 0 ? 0 : 1);
})();
