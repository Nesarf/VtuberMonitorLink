// mock-vision.cjs — local fake vision model / local fake vision endpoint
//
// Purpose: verify the image-tagging chain end to end without an API key and without sending any
// image out (request assembly, image_url argument passing, reply parsing, caching, concurrency,
// UI rendering). It returns **deterministic** tags based on keywords in the URL, and does no real
// recognition whatsoever.
//
//   node tools/mock-vision.cjs --port 43211 [--mode normal|prose|bad|flaky]
//
// Modes (used to verify how tolerant the parser is -- real models are often not well behaved):
//   normal  a perfectly well-formed JSON
//   prose   JSON wrapped in an explanation, with a ``` fence around it
//   bad     not JSON at all (verify that a parse failure gets recorded as failed instead of crashing)
//   flaky   first half of the requests 500, the rest fine (verify retry/recording on failure)
//   drop    the first request **has its connection cut outright** (no response sent), the rest fine
//           -- verifies that the "retry once on transport failure" path is really taken
//           (an HTTP 500 is a different class and is not retried)
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const PORT = Number(arg('port', 43211));
const MODE = arg('mode', 'normal');
let calls = 0;

/** Make up a stable fake tag set from keywords in the URL, so assertions are easy */
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
    if (MODE === 'drop' && calls === 1) {
      // Cut the connection without sending any response: the client sees ECONNRESET / socket hang up
      req.socket.destroy();
      return;
    }
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
      /* keep it null, we still return a normal answer below */
    }
    // Pick image_url out of the conversation -- this is "the image the model actually saw"
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
  // The port goes into a **runtime** file so humans and scripts can look it up (the path is
  // overridable through an environment variable).
  // Lesson learned: this used to be written to process.cwd() (i.e. the repo root) and got
  // committed to git by accident -- runtime artifacts must not land in the repo, so it now
  // defaults to the system temp directory, and `.gitignore` covers it too.
  const out = process.env.VML_MOCK_VISION_PORT_FILE || path.join(os.tmpdir(), 'vml-mock-vision-port.txt');
  try {
    fs.writeFileSync(out, String(PORT), 'utf8');
  } catch {
    /* if it cannot be written, never mind */
  }
  process.stdout.write(`mock vision (${MODE}) listening on http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`  port file: ${out}\n`);
});
