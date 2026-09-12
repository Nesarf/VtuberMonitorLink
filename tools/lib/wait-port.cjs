// wait-port.cjs — the single implementation of the small question "has the port been freed yet"
//
// Origin (measured 2026-09-12): in `npm run release`, traverse-release and traverse-ui run in
// sequence, and **both start an app on 43110**. The port is not necessarily released the moment
// the previous process is killed, so the second one may "come up only to get pushed off" or simply
// fail to bind — which shows up as a dozen **apparently unrelated** assertions failing
// (report list has 0 entries, previews won't open…), and only the very last line says
// `fetch failed`: the hardest kind to track down.
// So: before starting an app, wait until the port is genuinely free; if it never frees up,
// **say clearly who is holding it** instead of letting the symptom drift somewhere else.
const net = require('node:net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is anyone listening on the port (connects = someone is listening; ECONNREFUSED = free) */
function portBusy(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port), host });
    const done = (busy) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false)); // ECONNREFUSED and the like are all treated as "free"
    sock.once('timeout', () => done(false));
  });
}

/**
 * Wait for the port to become free.
 * @returns {Promise<{free: boolean, waitedMs: number}>}
 */
async function waitPortFree(port, { timeoutMs = 20000, intervalMs = 400, onWait = null } = {}) {
  const started = Date.now();
  let told = false;
  while (Date.now() - started < timeoutMs) {
    if (!(await portBusy(port))) return { free: true, waitedMs: Date.now() - started };
    if (!told) {
      told = true;
      if (onWait) onWait(`${port} is still held by the previous process, waiting for it to exit fully…`);
    }
    await sleep(intervalMs);
  }
  return { free: !(await portBusy(port)), waitedMs: Date.now() - started };
}

/** Wait for a child process to really exit (on Windows the port is not released immediately after kill) */
async function waitChildExit(child, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const started = Date.now();
  while (child.exitCode === null && child.signalCode === null && Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

module.exports = { portBusy, waitPortFree, waitChildExit };
