// mock-vision.cjs — 本地假视觉模型 / local fake vision endpoint
//
// 用途：在没有 API Key、也不想把图片发出去的情况下，端到端验证图片打标这条链路
// （请求组装、image_url 传参、回复解析、缓存、并发、界面呈现）。
// 它只按 URL 里的关键字返回**确定性**的标签，不做任何真实识别。
//
//   node tools/mock-vision.cjs --port 43211 [--mode normal|prose|bad|flaky]
//
// 模式（用来验证解析器的宽容度 —— 真实模型经常不老实）：
//   normal  规规矩矩的 JSON
//   prose   JSON 外面裹一段解释，还带 ``` 围栏
//   bad     完全不是 JSON（验证解析失败能被记录成 failed 而不是崩）
//   flaky   前一半请求 500，后一半正常（验证失败重试/记录）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const PORT = Number(arg('port', 43211));
const MODE = arg('mode', 'normal');
let calls = 0;

/** 按 URL 关键字编一个稳定的假标签，方便断言 */
function fakeTagsFor(url) {
  const u = String(url ?? '').toLowerCase();
  if (u.includes('meme') || u.includes('emoji')) return { kind: 'meme', tags: ['梗图', '表情'], text: '', people: [], confidence: 0.7 };
  if (u.includes('poster') || u.includes('banner')) return { kind: 'poster', tags: ['海报', '活动'], text: '3D披露 3月15日', people: [], confidence: 0.8 };
  if (u.includes('merch') || u.includes('goods')) return { kind: 'merch', tags: ['周边', '实物'], text: '', people: [], confidence: 0.75 };
  if (u.includes('3d') || u.includes('model')) return { kind: 'screenshot', tags: ['3D模型', '截图'], text: '', people: ['嘉然'], confidence: 0.9 };
  return { kind: 'illustration', tags: ['插画'], text: '', people: [], confidence: 0.6 };
}

const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (d) => (buf += d));
  req.on('end', () => {
    calls++;
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-vision-1' }] }));
    }
    if (MODE === 'flaky' && calls % 2 === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":"mock flaky failure"}');
    }
    let body = null;
    try {
      body = JSON.parse(buf);
    } catch {
      /* 保持 null，下面照样回一个正常答案 */
    }
    // 从对话里找出 image_url —— 这就是「模型看到的图」
    const content = body?.messages?.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) ?? [];
    const img = content.find((c) => c.type === 'image_url')?.image_url?.url ?? '';
    const tags = fakeTagsFor(img);

    let text;
    if (MODE === 'bad') text = '抱歉，我无法看图。';
    else if (MODE === 'prose') text = `好的，我看了一下这张图：\n\n\`\`\`json\n${JSON.stringify(tags)}\n\`\`\`\n\n还需要别的吗？`;
    else text = JSON.stringify(tags);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-vision',
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      })
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const out = path.join(process.cwd(), 'mock-vision-port.txt');
  try {
    fs.writeFileSync(out, String(PORT), 'utf8');
  } catch {
    /* 写不了就算了 */
  }
  process.stdout.write(`mock vision (${MODE}) listening on http://127.0.0.1:${PORT}\n`);
});
