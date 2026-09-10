// action.test.mjs — 가짜 GitHub API 로 Action 을 통째로 돌린다.
// 왜 필요한가: detect.mjs 는 순수 함수라 유닛테스트가 쉬운데, index.mjs 는 네트워크·env·파일을
// 만지는 곳이라 **런타임에만 터지는 버그**(예: ESM 에서 require 사용)가 여기 숨는다.
// 실제로 첫 작성분에 그 버그가 있었고 이 테스트가 그 재발을 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup({ files, comments = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
  const outPath = join(dir, 'out.txt');
  writeFileSync(outPath, '');

  process.env.GITHUB_EVENT_PATH = eventPath;
  process.env.GITHUB_OUTPUT = outPath;
  process.env.GITHUB_REPOSITORY = 'acme/widget';
  process.env.GITHUB_API_URL = 'https://api.example.test';
  process.env['INPUT_GITHUB-TOKEN'] = 'fake';
  process.env['INPUT_TEST-GLOBS'] = '**/*.test.*\n**/test_*.py';
  process.env['INPUT_FAIL-ON-DETECT'] = 'false';
  process.env['INPUT_COMMENT'] = 'true';

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const u = String(url);
    if (u.includes('/pulls/7/files')) {
      const page = Number(new URL(u).searchParams.get('page') || '1');
      return json(page === 1 ? files : []);
    }
    if (u.includes('/issues/7/comments')) return json(comments);
    if (u.includes('/issues/comments/')) return json({ id: 1 });
    return json({});
  };
  return { calls, outPath };
}
const json = (v) => ({ ok: true, status: 200, statusText: 'OK', json: async () => v });

test('Action 통째 실행 — 약화를 찾아 코멘트를 만들고 output 을 쓴다', async () => {
  const { calls, outPath } = setup({
    files: [
      { filename: 'src/app.ts', patch: '@@ -1,1 +1,1 @@\n+const a = 1;', status: 'modified' },
      { filename: 'src/app.test.ts', status: 'modified',
        patch: '@@ -40,3 +40,3 @@\n   it(\'loads\', () => {\n-    expect(load()).toHaveLength(14);\n+    expect(load()).toHaveLength(10);' },
    ],
  });
  await import('../src/index.mjs?case=1');
  await new Promise((r) => setTimeout(r, 30));

  const posted = calls.find((c) => c.method === 'POST');
  assert.ok(posted, '코멘트를 POST 해야 한다');
  const body = JSON.parse(posted.body).body;
  assert.match(body, /<!-- testguard -->/, '중복 코멘트 방지 마커');
  assert.match(body, /app\.test\.ts:41/); // hunk 시작 40 + context 1줄
  assert.match(body, /14.*→.*10/);
  assert.doesNotMatch(body, /app\.ts:1\b/, '프로덕션 파일은 보지 않는다');

  const out = readFileSync(outPath, 'utf-8');
  assert.match(out, /findings=1/, 'GITHUB_OUTPUT 에 써야 한다 (ESM require 버그 회귀 가드)');
});

test('Action 통째 실행 — 우리 코멘트가 이미 있으면 새로 달지 않고 고쳐 쓴다', async () => {
  const { calls } = setup({
    files: [{ filename: 'a.test.ts', status: 'removed' }],
    comments: [{ id: 99, body: '<!-- testguard -->\n이전 결과' }],
  });
  await import('../src/index.mjs?case=2');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.includes('/issues/comments/99')), 'PATCH 로 갱신');
  assert.ok(!calls.some((c) => c.method === 'POST'), '새 코멘트를 또 달지 않는다');
});

test('Action — 탐지 0건이면 코멘트를 만들지 않는다 (소음 금지)', async () => {
  const { calls } = setup({ files: [{ filename: 'src/app.ts', patch: '@@ -1,1 +1,1 @@\n+const a=1;', status: 'modified' }] });
  await import('../src/index.mjs?case=3');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!calls.some((c) => c.method === 'POST' || c.method === 'PATCH'));
});
