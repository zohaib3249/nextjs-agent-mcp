// Broker isolation test — no browser. Spins up the Broker, connects 2 fake agents + 2 fake tabs
// as raw WS clients, and asserts: claim free tab, exclusive ownership, cross-agent command block,
// routing to the right tab, release, and duplicate-tabId reassignment.
import { Broker } from '../src/modeB/broker.js';
import { WebSocket } from 'ws';

const PORT = 7395;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

// Minimal WS client that records frames and lets us await a predicate.
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox = [];
  ws.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  const send = (o) => ws.send(JSON.stringify(o));
  const waitFor = async (pred, ms = 1500) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    return null;
  };
  const open = new Promise((res) => ws.on('open', res));
  return { ws, inbox, send, waitFor, open };
}

(async () => {
  const broker = new Broker({ port: PORT });
  await broker.start();

  // 2 tabs register (one with a DUPLICATE id to test reassignment).
  const tabA = client(); await tabA.open;
  tabA.send({ t: 'register', role: 'tab', tabId: 'dup', url: 'http://x/a', title: 'A' });
  const tabB = client(); await tabB.open;
  tabB.send({ t: 'register', role: 'tab', tabId: 'dup', url: 'http://x/b', title: 'B' });

  const regA = await tabA.waitFor((m) => m.t === 'registered');
  const regB = await tabB.waitFor((m) => m.t === 'registered' || m.t === 'assignTabId');
  const idA = regA?.tabId;
  // B either got 'registered' with a different id, or an 'assignTabId'
  const assignB = tabB.inbox.find((m) => m.t === 'assignTabId');
  const idB = assignB?.tabId || tabB.inbox.find((m) => m.t === 'registered')?.tabId;
  ok(!!idA && !!idB && idA !== idB, `two tabs get DISTINCT ids (${idA} vs ${idB}) — dedup works`);

  // 2 agents register.
  const ag1 = client(); await ag1.open;
  ag1.send({ t: 'register', role: 'agent', agentId: 'ag1', name: 'Agent One' });
  const ag2 = client(); await ag2.open;
  ag2.send({ t: 'register', role: 'agent', agentId: 'ag2', name: 'Agent Two' });
  await sleep(100);

  // ag1 claims a free tab.
  ag1.send({ t: 'claim', intent: 'doing X' });
  const c1 = await ag1.waitFor((m) => m.t === 'claimed');
  ok(!!c1, `ag1 claimed a free tab (${c1?.tabId})`);
  const claimedTab = c1.tabId;
  // the owning tab got a 'claimed' notice with agent name + intent
  const tabGotClaim = [tabA, tabB].some((t) => t.inbox.find((m) => m.t === 'claimed' && m.agentName === 'Agent One' && m.intent === 'doing X'));
  ok(tabGotClaim, 'claimed tab received owner name + intent');

  // ag2 tries to claim the SAME tab → must be rejected.
  ag2.send({ t: 'claim', tabId: claimedTab, intent: 'sneaky' });
  const err2 = await ag2.waitFor((m) => m.t === 'error');
  ok(!!err2, 'ag2 cannot claim a tab already owned by ag1');

  // ag2 claims the OTHER free tab.
  ag2.send({ t: 'claim', intent: 'doing Y' });
  const c2 = await ag2.waitFor((m) => m.t === 'claimed');
  ok(!!c2 && c2.tabId !== claimedTab, `ag2 claimed the other tab (${c2?.tabId})`);

  // No more free tabs → ag1 release, then a 3rd claim attempt returns needTab.
  // (We only have 2 tabs; both bound now.) Make a fresh agent ask.
  const ag3 = client(); await ag3.open;
  ag3.send({ t: 'register', role: 'agent', agentId: 'ag3', name: 'Agent Three' });
  await sleep(80);
  ag3.send({ t: 'claim', intent: 'needs one' });
  const need = await ag3.waitFor((m) => m.t === 'needTab');
  ok(!!need, 'agent with no free tab gets needTab (would open its own)');

  // Command routing: find which tab ag1 owns, send a cmd, assert ONLY that tab receives it.
  const ownTab = claimedTab === idA ? tabA : tabB;
  const otherTab = ownTab === tabA ? tabB : tabA;
  ownTab.inbox.length = 0; otherTab.inbox.length = 0;
  ag1.send({ t: 'cmd', id: 1, tabId: claimedTab, op: 'snapshot', args: {}, message: 'hi' });
  const cmdSeen = await ownTab.waitFor((m) => m.t === 'cmd' && m.id === 1);
  ok(!!cmdSeen, 'cmd routed to the owning tab');
  const leaked = otherTab.inbox.find((m) => m.t === 'cmd');
  ok(!leaked, 'cmd did NOT leak to the other agent\'s tab');

  // Owning tab replies → ag1 gets the result.
  ownTab.send({ t: 'result', id: 1, ok: true, value: { snap: 'ok' } });
  const res1 = await ag1.waitFor((m) => m.t === 'result' && m.id === 1);
  ok(!!res1 && res1.ok, 'result relayed back to the owning agent');

  // ag1 cannot cmd ag2's tab.
  ag1.send({ t: 'cmd', id: 2, tabId: c2.tabId, op: 'click', args: {} });
  const blocked = await ag1.waitFor((m) => m.t === 'result' && m.id === 2 && m.ok === false);
  ok(!!blocked, 'agent cannot command a tab it does not own');

  // Release frees the tab.
  ag1.send({ t: 'release', tabId: claimedTab });
  const rel = await ag1.waitFor((m) => m.t === 'released');
  ok(!!rel, 'release returns released');
  const freedNotice = ownTab.inbox.find((m) => m.t === 'released');
  ok(!!freedNotice, 'released tab is notified (goes back to unclaimed)');

  // --- RELOAD: ag2 still owns c2.tabId. Simulate a page reload of that tab: close its socket, then
  //     reconnect with the SAME tabId. It must restore ag2's ownership (not go unclaimed). ---
  const owned2 = c2.tabId;
  const tab2 = owned2 === idA ? tabA : tabB;
  tab2.ws.close();
  await sleep(150);
  const reloaded = client(); await reloaded.open;
  reloaded.send({ t: 'register', role: 'tab', tabId: owned2, url: 'http://x/reloaded', title: 'R' });
  const reClaimed = await reloaded.waitFor((m) => m.t === 'claimed' && m.agentName === 'Agent Two');
  ok(!!reClaimed, 'reloaded tab AUTO-RE-BINDS to its owner (ag2) — not unclaimed');
  // ag2 can still command it after reload.
  reloaded.inbox.length = 0;
  ag2.send({ t: 'cmd', id: 9, tabId: owned2, op: 'snapshot', args: {} });
  const afterReload = await reloaded.waitFor((m) => m.t === 'cmd' && m.id === 9);
  ok(!!afterReload, 'owner can still command the tab after its reload');

  // --- claim-by-match: open a free tab on /checkout; a fresh agent claims by match "checkout". ---
  const tabC = client(); await tabC.open;
  tabC.send({ t: 'register', role: 'tab', tabId: 'tabC', url: 'http://x/en/checkout', title: 'Checkout' });
  await tabC.waitFor((m) => m.t === 'registered');
  const ag4 = client(); await ag4.open;
  ag4.send({ t: 'register', role: 'agent', agentId: 'ag4', name: 'Agent Four' });
  await sleep(80);
  ag4.send({ t: 'claim', match: 'checkout', intent: 'pay' });
  const byMatch = await ag4.waitFor((m) => m.t === 'claimed');
  ok(!!byMatch && byMatch.tabId === 'tabC', 'claim by url match picks the right free tab');

  console.log(failed === 0 ? '\nALL BROKER TESTS PASSED ✓' : `\n${failed} TEST(S) FAILED ✗`);
  process.exit(failed === 0 ? 0 : 1);
})();
