// ChromeController test — launches a real headless Chrome on a throwaway profile + alt debug port,
// then exercises tabs/open/activate/close via CDP. Skips gracefully if Chrome isn't installed.
import { ChromeController } from '../src/modeB/chrome.js';

const PORT = 9333;
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

(async () => {
  const chrome = new ChromeController({ port: PORT });

  const launch = await chrome.launch({ url: 'about:blank', headless: true, profile: `/tmp/agc-test-${PORT}` });
  if (launch.ok === false) {
    console.log(`(skip) Chrome not available: ${launch.error}`);
    process.exit(0);
  }
  ok(launch.launched || launch.attached, `launched/attached Chrome (${launch.browser || 'attached'})`);

  const t1 = await chrome.tabs();
  ok(t1.ok && t1.count >= 1, `lists tabs (count=${t1.count})`);

  const opened = await chrome.openTab('about:blank');
  ok(opened.ok && opened.opened?.id, `opened a new tab (${opened.opened?.id})`);

  const t2 = await chrome.tabs();
  ok(t2.count === t1.count + 1, `tab count grew after open (${t1.count} → ${t2.count})`);

  const act = await chrome.activateTab(opened.opened.id);
  ok(act.ok, 'activated the new tab');

  const closed = await chrome.closeTab(opened.opened.id);
  ok(closed.ok, 'closed the new tab');

  await new Promise((r) => setTimeout(r, 300));
  const t3 = await chrome.tabs();
  ok(t3.count === t1.count, `tab count back to baseline after close (${t3.count})`);

  // Clean up: kill the Chrome we launched.
  if (chrome.proc) chrome.proc.kill('SIGKILL');

  console.log(failed === 0 ? '\nCHROME TESTS PASSED ✓' : `\n${failed} FAILED ✗`);
  process.exit(failed === 0 ? 0 : 1);
})();
