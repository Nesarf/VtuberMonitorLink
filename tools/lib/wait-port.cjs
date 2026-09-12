// wait-port.cjs — 「端口空出来了吗」这件小事的唯一一份实现
//
// 由来（2026-09-12 实测）：`npm run release` 里 traverse-release 与 traverse-ui 依次跑，
// **两个都对 43110 起 app**。前一个的进程被 kill 之后端口不一定立刻释放，后一个于是
// 可能「先起来又被顶掉」或者干脆绑不上 —— 表现出来是十来个**看起来毫不相干**的断言挂掉
// （报告列表 0 条、预览点不开…），最后一句才是 `fetch failed`，最难查的那种。
// 所以：起 app 之前先等端口真空出来，等不到就**明确说清是谁占着**，而不是让症状漂到别处。
const net = require('node:net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口上有人在听吗（连得上=有人听；ECONNREFUSED=空的） */
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
    sock.once('error', () => done(false)); // ECONNREFUSED 等一律当作「空的」
    sock.once('timeout', () => done(false));
  });
}

/**
 * 等端口空出来。
 * @returns {Promise<{free: boolean, waitedMs: number}>}
 */
async function waitPortFree(port, { timeoutMs = 20000, intervalMs = 400, onWait = null } = {}) {
  const started = Date.now();
  let told = false;
  while (Date.now() - started < timeoutMs) {
    if (!(await portBusy(port))) return { free: true, waitedMs: Date.now() - started };
    if (!told) {
      told = true;
      if (onWait) onWait(`${port} 还被上一个进程占着，等它退干净…`);
    }
    await sleep(intervalMs);
  }
  return { free: !(await portBusy(port)), waitedMs: Date.now() - started };
}

/** 等一个子进程真的退出（Windows 上 kill 之后端口不会立刻放） */
async function waitChildExit(child, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const started = Date.now();
  while (child.exitCode === null && child.signalCode === null && Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

module.exports = { portBusy, waitPortFree, waitChildExit };
