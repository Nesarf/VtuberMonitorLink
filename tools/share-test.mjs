// share-test.mjs — 一键分享的自检 / self-test for sharing
//
// 分享这一层最危险的不是「发不出去」，而是**在没登录/没验证的情况下假装能发**，
// 以及**把不可撤销的对外动作做成自动化**。所以自检重点：
//   · 单文件 HTML 必须**零外部引用**（对方离线/内网也能打开）
//   · 每个需要登录的目标都要如实报告缺什么，而不是静默失败
//   · 对外发声必须过确认闸门 + 状态闸门 + 长度闸门，并且留审计
//   · 未验证的功能不得被当成可用
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHARE_TARGETS,
  appendAudit,
  buildBundle,
  bundleFilename,
  checkReadiness,
  contentDisposition,
  guardPost,
  readAudit,
  renderBundle,
  targetById,
  toHtml,
  toMarkdown,
  toPlainText,
} from '../server/src/share.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-share-'));
const cfg = { paths: { logsDir: tmp } };

const items = [
  {
    id: 'a1',
    title: '嘉然 3D披露 将于 3月15日 举行',
    text: '正文内容 <script>alert(1)</script>',
    url: 'https://example.com/a1',
    sourceId: 'official-hololive',
    publishedAt: '2026-03-01T10:00:00Z',
    people: ['jaran'],
    keywords: ['3D披露'],
  },
  { id: 'a2', title: 'Rei 新曲发布', url: 'https://example.com/a2', sourceId: 'news-ann', publishedAt: '2026-03-02T10:00:00Z', people: ['rei'] },
];
const bundle = buildBundle({
  scopeKind: 'day',
  items,
  title: 'VML 日报 2026-03-01',
  subtitle: '示例',
  note: '由 VML 生成',
  contentDate: '2026-03-01',
  generatedAt: '2026-09-12T00:00:00.000Z', // 导出日故意与内容日不同，用来验证两者没被搞混
});

process.stdout.write('\nshare: 打包内容\n');
t('bundle 结构完整', () => {
  assert.equal(bundle.items.length, 2);
  assert.ok(bundle.generatedAt);
  assert.equal(bundle.scope, 'day');
});

t('Markdown 带标题/时间/人/关键词/原文链接', () => {
  const md = toMarkdown(bundle);
  assert.ok(md.includes('# VML 日报 2026-03-01'));
  assert.ok(md.includes('嘉然 3D披露'));
  assert.ok(md.includes('👤 jaran'));
  assert.ok(md.includes('🏷 3D披露'));
  assert.ok(md.includes('https://example.com/a1'));
  assert.ok(md.includes('共 2 条'));
});

t('纯文本版适合贴聊天框（只有标题与链接）', () => {
  const txt = toPlainText(bundle);
  assert.ok(txt.includes('· 嘉然 3D披露 将于 3月15日 举行'));
  assert.ok(txt.includes('https://example.com/a1'));
  assert.ok(!txt.includes('正文内容'));
});

process.stdout.write('\nshare: 单文件 HTML\n');
t('HTML 里没有**任何**外部引用（离线也能打开）', () => {
  const html = toHtml(bundle);
  // 允许出现 http 链接（原文链接本身），但不允许有会去加载资源的外链
  const externalRefs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
  const loadingRefs = externalRefs.filter((u) => !/^https?:\/\/(example\.com)/.test(u));
  assert.deepEqual(loadingRefs, [], '不该有会去加载的外部资源: ' + loadingRefs.join(','));
  assert.ok(!/<script/i.test(html), '分享文件里不应带脚本');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), '不应引用外部样式表');
});

t('HTML 转义了内容里的脚本（不把对方的浏览器当武器）', () => {
  const html = toHtml(bundle);
  assert.ok(html.includes('&lt;script&gt;'), '应转义为实体');
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

t('三种格式各自的 mime 与扩展名正确', () => {
  assert.equal(renderBundle(bundle, 'html').mime, 'text/html; charset=utf-8');
  assert.equal(renderBundle(bundle, 'md').ext, 'md');
  assert.equal(renderBundle(bundle, 'json').ext, 'json');
  assert.equal(renderBundle(bundle, 'text').ext, 'txt');
  assert.doesNotThrow(() => JSON.parse(renderBundle(bundle, 'json').body));
});

t('文件名用**内容日期**而不是导出日（两者不能混为一谈）', () => {
  const f = bundleFilename(bundle, 'html');
  assert.ok(/^vml-share-.+-2026-03-01\.html$/.test(f), f);
  assert.ok(!f.includes('2026-09-12'), '不该用导出日: ' + f);
  assert.ok(!/[\\/:*?"<>|]/.test(f));
});

t('没有内容日期时才落到导出日', () => {
  const b = buildBundle({ items: [{ id: 'x', title: 'y' }], title: 'Latest' });
  assert.ok(bundleFilename(b, 'md').endsWith('.md'));
  assert.ok(bundleFilename(b, 'md').includes(b.generatedAt.slice(0, 10)));
});

t('content-disposition 头永远是纯 ASCII（中文名走 RFC 5987）', () => {
  const f = bundleFilename(bundle, 'html'); // 标题里有中文
  const header = contentDisposition(f);
  // 这条断言是踩出来的：HTTP 头带中文会直接抛 ERR_INVALID_CHAR、接口 500，
  // 而单元测试只验证「文件名生成得对」，不走 HTTP 层就抓不到
  assert.ok(/^[\x20-\x7E]+$/.test(header), '头部必须是 ASCII: ' + header);
  assert.ok(header.includes("filename*=UTF-8''"), '要带 UTF-8 编码版本');
  assert.ok(header.includes(encodeURIComponent(f)), '编码后的原名要在里面');
  // 引号是 ASCII 兜底名的**定界符**，要验的是引号内的值本身不含引号/反斜杠
  const asciiName = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
  assert.ok(asciiName.length > 0, '要有 ASCII 兜底名');
  assert.ok(!/["\\]/.test(asciiName), '兜底名里不能有引号或反斜杠: ' + asciiName);
  assert.ok(/^[\x20-\x7E]+$/.test(asciiName));
});

t('条目数量有上限（分享不该把一整天几千条塞给对方）', () => {
  const many = buildBundle({ items: Array.from({ length: 500 }, (_, i) => ({ id: 'x' + i, title: 't' + i })) });
  assert.ok(many.items.length <= 60, '实际 ' + many.items.length);
});

process.stdout.write('\nshare: 目标登记表与登录需求\n');
t('每个目标都如实声明「要不要登录」', () => {
  for (const target of SHARE_TARGETS) {
    assert.equal(typeof target.needsLogin, 'boolean', target.id);
    assert.ok(['ready', 'needs-login', 'needs-verification', 'unsupported'].includes(target.status), target.id + ' 状态非法');
    assert.ok(target.name?.zh && target.name?.en, target.id + ' 缺名字');
    assert.ok(target.hint?.zh && target.hint?.en, target.id + ' 缺说明');
  }
});

t('需要登录的目标必须声明登录种类与检查方式', () => {
  for (const target of SHARE_TARGETS.filter((x) => x.needsLogin)) {
    assert.ok(target.loginKind, target.id + ' 需要登录却没写 loginKind');
  }
});

t('不需要登录的目标与登录态无关，永远可用', () => {
  for (const target of SHARE_TARGETS.filter((x) => !x.needsLogin)) {
    assert.equal(checkReadiness(target, []).ok, true, target.id);
  }
});

t('没有登录态时如实说缺什么，而不是假装可用', () => {
  const t1 = targetById('bilibili-dynamic');
  const r = checkReadiness(t1, []);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs-login');
  assert.ok(r.reason.includes('SESSDATA'), r.reason);
});

t('有可用账号时才可能就绪（但「未验证」仍不算就绪）', () => {
  const t1 = targetById('bilibili-dynamic');
  const accounts = [{ kind: 'bilibili', name: 'someone', canSend: true }];
  const r = checkReadiness(t1, accounts);
  assert.equal(r.ok, false, '未验证之前不该允许');
  assert.equal(r.status, 'needs-verification');
  assert.equal(r.account, 'someone');
});

t('做不到的平台明确标为 unsupported', () => {
  const x = targetById('x-post');
  assert.equal(x.status, 'unsupported');
  assert.equal(checkReadiness(x, [{ kind: 'twitter', canSend: true }]).status, 'unsupported');
});

process.stdout.write('\nshare: 对外发声的闸门\n');
t('没有明确确认 → 拒绝', () => {
  const g = guardPost(cfg, { target: 'bilibili-dynamic', text: 'hi' });
  assert.equal(g.ok, false);
  assert.ok(g.error.includes('确认'));
});

t('未验证的目标 → 拒绝（即使已经登录）', () => {
  const g = guardPost(cfg, {
    target: 'bilibili-dynamic',
    accounts: [{ kind: 'bilibili', canSend: true }],
    text: 'hi',
    confirm: true,
  });
  assert.equal(g.ok, false);
  assert.equal(g.status, 'needs-verification');
});

t('验证过 + 已登录 + 已确认 → 放行', () => {
  const g = guardPost(cfg, {
    target: 'bilibili-dynamic',
    accounts: [{ kind: 'bilibili', canSend: true }],
    verified: ['bilibili-dynamic'],
    text: '分享内容',
    confirm: true,
  });
  assert.equal(g.ok, true);
  assert.equal(g.body, '分享内容');
});

t('不支持的平台 → 拒绝', () => {
  const g = guardPost(cfg, { target: 'x-post', text: 'hi', confirm: true });
  assert.equal(g.ok, false);
});

t('不是发帖目标（例如下载）→ 拒绝', () => {
  const g = guardPost(cfg, { target: 'file-html', text: 'hi', confirm: true });
  assert.equal(g.ok, false);
});

t('空内容与超长内容被挡', () => {
  const base = { target: 'bilibili-dynamic', accounts: [{ kind: 'bilibili', canSend: true }], verified: ['bilibili-dynamic'], confirm: true };
  assert.equal(guardPost(cfg, { ...base, text: '   ' }).ok, false);
  assert.equal(guardPost(cfg, { ...base, text: 'x'.repeat(2001) }).ok, false);
  assert.equal(guardPost(cfg, { ...base, text: 'x'.repeat(2000) }).ok, true);
});

t('未知目标被挡', () => {
  assert.equal(guardPost(cfg, { target: 'nope', text: 'hi', confirm: true }).ok, false);
});

process.stdout.write('\nshare: 审计\n');
t('审计可写可读，且是追加的', () => {
  assert.equal(appendAudit(cfg, { action: 'download', target: 'file-html', items: 2 }), true);
  assert.equal(appendAudit(cfg, { action: 'post', target: 'bilibili-dynamic', ok: true }), true);
  const log = readAudit(cfg, 10);
  assert.equal(log.length, 2);
  assert.equal(log[0].action, 'post', '最新的在最前');
  assert.ok(log[0].at);
});

t('审计文件是 JSONL（一行一条，便于事后追加与解析）', () => {
  const raw = fs.readFileSync(path.join(tmp, 'share.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 2);
  for (const line of raw.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
});

t('目录不存在时不会抛（返回 false 而不是崩）', () => {
  const bad = { paths: { logsDir: path.join(tmp, 'a', 'b', 'c') } };
  assert.equal(appendAudit(bad, { action: 'x' }), true, '应该会创建目录');
  assert.equal(readAudit(bad, 5).length, 1);
});

fs.rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
