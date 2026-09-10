// index.mjs — GitHub Action 진입점. 의존성 0 (Node 20 내장 fetch 만 쓴다).
//
// ⛔ 신뢰 경계 — 이 셋은 설계상 절대 하지 않는다:
//   1. PR **본문**에서 명령을 읽지 않는다. 포크 PR 의 본문은 공격자(그리고 우리가 검증하려는
//      바로 그 에이전트)가 통제하는 입력이다. 거기서 뭘 실행하면 전형적인 pwn-request 다.
//   2. 설정을 **PR 브랜치에서 읽지 않는다.** 에이전트가 같은 PR 에서 설정을 고치면 구멍이
//      그대로다. 설정은 워크플로 파일(base ref)에 있는 `with:` 만 쓴다.
//   3. LLM 을 쓰지 않는다. 판정은 전부 결정론적 파서다(detect.mjs) — 판정 자체가
//      프롬프트 인젝션으로 위조되는 경로를 만들지 않는다.
//
// ⚠️ 이 방어가 무력화되는 입력: 워크플로 파일 자체를 고치는 PR. 그건 GitHub 의
//    workflow 권한이 막는 축이고 이 Action 의 범위 밖이다.
import { readFileSync, appendFileSync } from 'node:fs';
import { detect, renderComment } from './detect.mjs';

const inp = (name, dflt = '') => process.env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] ?? dflt;

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) { appendFileSync(f, `${name}=${value}\n`); }
  else { console.log(`::set-output name=${name}::${value}`); }
}

async function gh(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'authorization': `Bearer ${token}`,
      'accept': 'application/vnd.github+json',
      'user-agent': 'testguard',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} — ${url}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const token = inp('github-token');
  const globs = inp('test-globs').split('\n').map((s) => s.trim()).filter(Boolean);
  const failOnDetect = inp('fail-on-detect', 'false') === 'true';
  const doComment = inp('comment', 'true') === 'true';

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) { console.log('TestGuard: 이벤트 정보가 없습니다 — 건너뜁니다.'); return; }
  const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
  const pr = event.pull_request;
  if (!pr) { console.log('TestGuard: pull_request 이벤트가 아닙니다 — 건너뜁니다.'); return; }

  const repo = process.env.GITHUB_REPOSITORY;           // owner/name
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const number = pr.number;

  // ── PR 이 건드린 파일 (페이지네이션 — 큰 PR 에서 조용히 잘리지 않게)
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await gh(token, `${api}/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...batch.map((f) => ({ path: f.filename, patch: f.patch, status: f.status, deletions: f.deletions })));
    if (batch.length < 100) break;
    if (page === 30) console.log('TestGuard: 파일이 3000개를 넘어 뒷부분은 보지 못했습니다.');
  }

  const findings = detect(files, globs);
  console.log(`TestGuard: 파일 ${files.length}개 검사 · 탐지 ${findings.length}건`);
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.path}${f.line ? ':' + f.line : ''} — ${f.label}`);
  }
  setOutput('findings', String(findings.length));

  const body = renderComment(findings);
  if (doComment && body) {
    // 같은 PR 에 코멘트를 쌓지 않는다 — 우리 것이 있으면 고쳐 쓴다.
    const MARK = '<!-- testguard -->';
    const existing = await gh(token, `${api}/repos/${repo}/issues/${number}/comments?per_page=100`);
    const mine = existing.find((c) => typeof c.body === 'string' && c.body.includes(MARK));
    const payload = JSON.stringify({ body: `${MARK}\n${body}` });
    if (mine) await gh(token, `${api}/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: payload });
    else await gh(token, `${api}/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: payload });
    console.log(`TestGuard: 코멘트 ${mine ? '갱신' : '작성'} 완료`);
  }

  if (failOnDetect && findings.some((f) => f.severity === 'high')) {
    console.log('TestGuard: 심각도 높음이 있어 실패로 끝냅니다 (fail-on-detect=true).');
    process.exit(1);
  }
}

main().catch((err) => {
  // ⛔ 실패해도 PR 을 막지 않는다 — 우리 버그가 남의 배포를 세우면 안 된다.
  //    "못 봤다"는 조용히 넘어가지 말고 로그에는 반드시 남긴다.
  console.log(`TestGuard: 실행 실패 — ${err?.message ?? err}`);
  console.log('TestGuard: 이 실패는 PR 을 막지 않습니다. "약화 없음"이 아니라 "확인하지 못함"입니다.');
});
