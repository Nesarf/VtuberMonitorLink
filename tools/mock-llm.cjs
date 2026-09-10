// tools/mock-llm.cjs - a tiny OpenAI-compatible endpoint for testing.
//
// ASCII only, CommonJS. No dependencies.
//
// Why: a full end-to-end run (fetch -> watch -> analyse -> report -> intel)
// normally needs a real API key, which must never live in a repo or a build.
// This stub answers /chat/completions and /models so the whole pipeline can be
// exercised offline. It also lets the user try the console without spending
// tokens.
//
//   node tools/mock-llm.cjs [--port 43197]
//
// The completion it returns is deterministic and quotes the prompt back, so a
// test can assert that watch results and bilibili items actually reached the
// model instead of vanishing somewhere in between.

'use strict';

const http = require('node:http');

const args = process.argv.slice(2);
let port = Number(process.env.MOCK_LLM_PORT || 43197);
for (let i = 0; i < args.length; i++) if (args[i] === '--port') port = Number(args[++i]) || port;

const MODELS = ['mock-model', 'mock-reasoner'];

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

/** Build a report that proves what actually arrived in the prompt. */
function buildReport(userPrompt) {
  const text = String(userPrompt ?? '');
  const sourceSections = (text.match(/^## /gm) || []).length;
  const watchLines = (text.match(/^- 【监视】/gm) || []).length;
  const watchEvents = (text.match(/^ {4}· /gm) || []).length;
  const biliLines = (text.match(/^https:\/\/www\.bilibili\.com\/opus\//gm) || []).length;
  const hasWatchSection = text.includes('# 监视对象检查结果');
  const hasKeywords = text.includes('# 本次重点关注的关键词');

  return [
    '# 测试报告（由 mock LLM 生成）',
    '',
    `生成日期：${new Date().toISOString().slice(0, 10)}`,
    '',
    '## 数据来源清单',
    '',
    `- 本次共收到 **${sourceSections}** 条来源摘要`,
    `- 监视对象 ${watchLines} 个，其中变更条目 ${watchEvents} 条`,
    `- B 站动态链接 ${biliLines} 条`,
    '',
    '## 监视告警',
    '',
    hasWatchSection ? '（prompt 中带有监视结果段落 ✔）' : '（prompt 中没有监视结果段落 ✘）',
    '',
    '## B 站动态',
    '',
    biliLines > 0 ? '（prompt 中带有 opus 链接 ✔）' : '（prompt 中没有 opus 链接 ✘）',
    '',
    '## 已确认事实',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    `| 来源段落 | ${sourceSections} |`,
    `| 监视变更 | ${watchEvents} |`,
    `| 关键词段落 | ${hasKeywords ? '有' : '无'} |`,
    '',
    '## 传闻 / 未证实',
    '',
    '- 这是一份由本地 mock LLM 产出的报告，仅用于验证链路，不含任何真实情报。',
    '',
    '> 把「设置 → LLM」里的档位换成真实提供商，即可得到真实分析。',
    '',
    '参考链接：[Vtuber\'s Monitor Link](https://example.com/vml) 与 https://example.com/bare-link',
    '',
    '---',
    '',
    '- 列表项一',
    '- 列表项二 **加粗** 与 `行内代码`',
  ].join('\n');
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url.startsWith('/models')) {
    return send(200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) });
  }

  if (req.method === 'POST' && req.url.startsWith('/chat/completions')) {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { error: { message: 'bad json' } });
    }
    const user = (body.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (/^ping$/.test(String(user).trim()) || (body.max_tokens ?? 0) <= 4) {
      return send(200, { choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    }
    const content = buildReport(user);
    return send(200, {
      id: 'mock-1',
      object: 'chat.completion',
      model: body.model ?? 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: raw.length, completion_tokens: content.length, total_tokens: raw.length + content.length },
    });
  }

  if (req.method === 'POST' && req.url.startsWith('/fail')) {
    return send(401, { error: { message: 'mock: deliberate failure' } });
  }

  send(404, { error: { message: 'not found' } });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('mock LLM listening on http://127.0.0.1:' + port + '\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
