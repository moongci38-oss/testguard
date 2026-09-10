// detect.mjs — PR diff 에서 "테스트를 약하게 만든 변경" 을 찾는다.
//
// 왜 재실행이 아니라 diff 인가:
//   고객 CI 가 이미 테스트를 돌리는 레포에서 우리가 또 돌리면 **같은 초록을 한 번 더** 낼 뿐이다.
//   문제는 답안을 다시 채점하는 게 아니라 **학생이 정답지를 고쳐 놓은 것**이다.
//   그래서 1차 판정은 diff 다.
//
// ⛔ LLM 을 쓰지 않는다. 전부 결정론적 파서다 — 판정 자체가 프롬프트 인젝션으로 위조되는
//    경로를 아예 만들지 않기 위해서다(PR 본문·코드는 공격자가 통제하는 입력이다).

/** 테스트 파일로 볼 것인가 — glob 을 정규식으로 바꿔 판정한다(의존성 0). */
export function isTestFile(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function globToRegExp(glob) {
  // `**/` = 0개 이상 디렉터리, `*` = `/` 를 넘지 않는 임의 문자
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 는 "그 위치부터 0개 이상 디렉터리" 라 슬래시까지 함께 삼킨다
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

// ── 규칙 1: skip / only 추가 ────────────────────────────────────────────────
// 언어별 실제 표기를 모은다. 새 프레임워크는 여기만 늘리면 된다.
const SKIP_PATTERNS = [
  { re: /\b(?:it|test|describe|context)\s*\.\s*skip\s*\(/, lang: 'js', label: 'skip 추가' },
  { re: /\b(?:xit|xdescribe|xtest)\s*\(/, lang: 'js', label: 'skip 추가(x접두)' },
  { re: /\b(?:it|test|describe)\s*\.\s*(?:only|todo)\s*\(/, lang: 'js', label: 'only/todo — 나머지 테스트가 안 돈다' },
  { re: /@pytest\.mark\.(?:skip|xfail)\b/, lang: 'py', label: 'skip/xfail 추가' },
  { re: /@unittest\.skip\b/, lang: 'py', label: 'skip 추가' },
  { re: /\bt\s*\.\s*Skip\s*\(/, lang: 'go', label: 'skip 추가' },
  { re: /#\[ignore\]/, lang: 'rs', label: 'ignore 추가' },
  { re: /@(?:Disabled|Ignore)\b/, lang: 'jvm', label: 'disabled 추가' },
];

// ── 규칙 2: assert 삭제 ────────────────────────────────────────────────────
const ASSERT_RE = /\b(?:expect|assert|assert_eq!|assertEquals|assertThat|require\.\w+|should\b)/;

// ── 규칙 3: 기대값 하향 ────────────────────────────────────────────────────
// (a) 같은 matcher 인데 숫자만 바뀐 경우  (b) 엄격한 matcher → 느슨한 matcher
const NUM_MATCHER_RE = /\b(toBe|toEqual|toHaveLength|assertEqual|assert_eq!|toBeCloseTo)\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/;
const LOOSENED = [
  { from: /\btoBe\s*\(/, to: /\btoBeTruthy\s*\(|\btoBeDefined\s*\(/, label: 'toBe → toBeTruthy/toBeDefined' },
  { from: /\btoEqual\s*\(/, to: /\btoMatchObject\s*\(/, label: 'toEqual → toMatchObject (부분 일치)' },
  { from: /\bassertEqual\b/, to: /\bassertTrue\b|\bassertIsNotNone\b/, label: 'assertEqual → assertTrue/assertIsNotNone' },
  { from: /\btoHaveBeenCalledTimes\s*\(/, to: /\btoHaveBeenCalled\s*\(/, label: '호출 횟수 검사 → 호출 여부만' },
];

/**
 * 파일 하나의 patch(unified diff) 를 읽어 findings 를 낸다.
 * @param {{path:string, patch?:string, status?:string, deletions?:number}} file
 * @returns {Array<{path:string,line:number|null,rule:string,label:string,before?:string,after?:string,severity:'high'|'medium'}>}
 */
export function detectInPatch(file) {
  const out = [];
  const path = file.path;

  // 테스트 파일 삭제 — patch 가 없어도 status 로 잡힌다
  if (file.status === 'removed') {
    out.push({ path, line: null, rule: 'test-file-removed', label: '테스트 파일 삭제', severity: 'high' });
    return out;
  }
  if (!file.patch) return out;

  const added = [];   // {line, text}
  const removed = []; // {text}
  let newLine = 0;

  for (const raw of file.patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      newLine = m ? parseInt(m[1], 10) - 1 : newLine;
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) { newLine += 1; added.push({ line: newLine, text: raw.slice(1) }); }
    else if (raw.startsWith('-')) { removed.push({ text: raw.slice(1) }); }
    else { newLine += 1; }
  }

  // 규칙 1 — skip/only 가 **새로** 들어왔는가 (지워진 줄에 이미 있었으면 이동일 뿐이다)
  for (const a of added) {
    for (const p of SKIP_PATTERNS) {
      if (!p.re.test(a.text)) continue;
      const wasThere = removed.some((r) => p.re.test(r.text));
      if (wasThere) continue;
      out.push({ path, line: a.line, rule: 'skip-added', label: p.label, after: a.text.trim(), severity: 'high' });
    }
  }

  // 규칙 2 — assert 가 줄었는가 (개수 비교. 리팩터링이면 보통 수가 유지된다)
  const removedAsserts = removed.filter((r) => ASSERT_RE.test(r.text)).length;
  const addedAsserts = added.filter((a) => ASSERT_RE.test(a.text)).length;
  if (removedAsserts > addedAsserts) {
    out.push({
      path, line: added[0]?.line ?? null, rule: 'assert-removed',
      label: `단언(assert) ${removedAsserts - addedAsserts}개 감소`,
      before: `${removedAsserts}개`, after: `${addedAsserts}개`, severity: 'high',
    });
  }

  // 규칙 3a — 같은 matcher 의 기대 숫자가 바뀌었는가
  for (const r of removed) {
    const rm = r.text.match(NUM_MATCHER_RE);
    if (!rm) continue;
    for (const a of added) {
      const am = a.text.match(NUM_MATCHER_RE);
      if (!am || am[1] !== rm[1]) continue;
      if (am[2] === rm[2]) continue;
      // 같은 자리에서 숫자만 바뀐 것으로 본다(문맥이 비슷한 줄끼리 짝지음)
      if (!looksLikeSameLine(r.text, a.text)) continue;
      out.push({
        path, line: a.line, rule: 'expectation-changed',
        label: `기대값 변경 ${rm[1]}(${rm[2]}) → ${am[2]}`,
        before: r.text.trim(), after: a.text.trim(),
        severity: 'medium',
      });
      break;
    }
  }

  // 규칙 3b — matcher 가 느슨해졌는가
  for (const rule of LOOSENED) {
    const strictGone = removed.some((r) => rule.from.test(r.text));
    const looseCame = added.some((a) => rule.to.test(a.text));
    if (strictGone && looseCame) {
      out.push({
        path, line: added.find((a) => rule.to.test(a.text))?.line ?? null,
        rule: 'matcher-loosened', label: rule.label, severity: 'medium',
      });
    }
  }

  return out;
}

/** 두 줄이 "같은 줄의 전후" 로 볼 만큼 닮았는가 — 숫자를 지운 뒤 비교한다. */
export function looksLikeSameLine(a, b) {
  const norm = (s) => s.replace(/-?\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

/** 파일 목록 전체 → findings. 테스트 파일만 본다. */
export function detect(files, globs) {
  const out = [];
  for (const f of files) {
    if (!isTestFile(f.path, globs)) continue;
    out.push(...detectInPatch(f));
  }
  return out;
}

/** PR 코멘트 본문. 0건이면 null(조용히 지나간다 — 소음을 만들지 않는다). */
export function renderComment(findings) {
  if (findings.length === 0) return null;
  const high = findings.filter((f) => f.severity === 'high');
  const lines = [];
  lines.push('### 🛡️ TestGuard — 이 PR이 테스트를 약하게 만들었을 수 있습니다');
  lines.push('');
  lines.push(`탐지 **${findings.length}건** (높음 ${high.length} · 보통 ${findings.length - high.length})`);
  lines.push('');
  lines.push('| | 위치 | 무엇이 |');
  lines.push('|---|---|---|');
  for (const f of findings) {
    const mark = f.severity === 'high' ? '🔴' : '🟡';
    const where = f.line ? `\`${f.path}:${f.line}\`` : `\`${f.path}\``;
    lines.push(`| ${mark} | ${where} | ${f.label} |`);
  }
  lines.push('');
  lines.push('<details><summary>바뀐 줄 보기</summary>');
  lines.push('');
  for (const f of findings) {
    if (!f.before && !f.after) continue;
    lines.push(`**${f.path}${f.line ? ':' + f.line : ''}** — ${f.label}`);
    lines.push('```diff');
    if (f.before) lines.push('- ' + f.before);
    if (f.after) lines.push('+ ' + f.after);
    lines.push('```');
  }
  lines.push('</details>');
  lines.push('');
  lines.push('_테스트를 고치는 정당한 이유도 많습니다. 이 코멘트는 **막는 것이 아니라 눈에 띄게 하는 것**입니다._');
  return lines.join('\n');
}
