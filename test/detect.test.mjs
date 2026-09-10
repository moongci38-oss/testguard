// detect.test.mjs — 진짜 unified diff 로 판별력을 고정한다.
// 이 테스트의 계약: ①약화는 잡는다 ②정상 리팩터링은 안 잡는다(오탐이 제품을 죽인다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, detectInPatch, isTestFile, globToRegExp, looksLikeSameLine, renderComment } from '../src/detect.mjs';

const GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.go', '**/tests/**'];

test('isTestFile — 흔한 규칙을 잡고, 프로덕션 코드는 안 잡는다', () => {
  assert.equal(isTestFile('src/load-plan.test.ts', GLOBS), true);
  assert.equal(isTestFile('a/b/c/foo.spec.js', GLOBS), true);
  assert.equal(isTestFile('api/test_user.py', GLOBS), true);
  assert.equal(isTestFile('pkg/handler_test.go', GLOBS), true);
  assert.equal(isTestFile('tests/e2e/login.js', GLOBS), true);
  assert.equal(isTestFile('src/load-plan.ts', GLOBS), false);
  assert.equal(isTestFile('src/protest.ts', GLOBS), false, 'protest 는 test 가 아니다');
});

test('globToRegExp — ** 는 디렉터리를 건너뛰고 * 는 슬래시를 못 넘는다', () => {
  assert.equal(globToRegExp('**/*.test.*').test('a/b/x.test.ts'), true);
  assert.equal(globToRegExp('**/*.test.*').test('x.test.ts'), true);
  assert.equal(globToRegExp('test/*.js').test('test/a/b.js'), false);
});

test('규칙1 — it.skip 이 새로 들어오면 잡는다', () => {
  const f = { path: 'src/a.test.ts', patch:
`@@ -10,7 +10,7 @@
 describe('load', () => {
-  it('loads 14 plans', () => {
+  it.skip('loads 14 plans', () => {
     expect(load()).toHaveLength(14);
   });` };
  const r = detectInPatch(f);
  assert.equal(r.length, 1);
  assert.equal(r[0].rule, 'skip-added');
  assert.equal(r[0].line, 11, '추가된 줄의 새 파일 기준 줄번호 (hunk 시작 10 + context 1줄)');
});

test('규칙1 — 원래 있던 skip 이 자리만 옮긴 것은 안 잡는다 (오탐 방지)', () => {
  const f = { path: 'a.test.ts', patch:
`@@ -1,4 +1,4 @@
-  it.skip('a', () => {})
+  it.skip('a', () => {})   // 주석만 추가` };
  assert.equal(detectInPatch(f).length, 0);
});

test('규칙1 — pytest·go·rust·junit 도 잡는다', () => {
  const cases = [
    ['api/test_u.py', '+@pytest.mark.skip(reason="flaky")'],
    ['pkg/h_test.go', '+\tt.Skip("later")'],
    ['src/l_test.rs', '+#[ignore]'],
    ['A.spec.java',   '+@Disabled'],
  ];
  for (const [path, line] of cases) {
    const r = detectInPatch({ path, patch: `@@ -1,1 +1,2 @@\n ok\n${line}` });
    assert.equal(r.length, 1, path);
    assert.equal(r[0].rule, 'skip-added', path);
  }
});

test('규칙2 — assert 가 줄면 잡는다', () => {
  const f = { path: 'a.test.ts', patch:
`@@ -1,6 +1,4 @@
 it('x', () => {
-  expect(a).toBe(1);
-  expect(b).toBe(2);
-  expect(c).toBe(3);
+  expect(a).toBe(1);
 });` };
  const r = detectInPatch(f).filter((x) => x.rule === 'assert-removed');
  assert.equal(r.length, 1);
  assert.match(r[0].label, /2개 감소/);
});

test('규칙2 — assert 수가 유지되는 리팩터링은 안 잡는다 (오탐 방지)', () => {
  const f = { path: 'a.test.ts', patch:
`@@ -1,4 +1,4 @@
-  expect(getUser().name).toBe('kim');
-  expect(getUser().age).toBe(30);
+  const u = getUser();
+  expect(u.name).toBe('kim');
+  expect(u.age).toBe(30);` };
  assert.equal(detectInPatch(f).filter((x) => x.rule === 'assert-removed').length, 0);
});

test('규칙3a — 기대 숫자를 낮추면 잡는다 (14 → 10)', () => {
  const f = { path: 'src/load-plan.test.ts', patch:
`@@ -41,3 +41,3 @@
   it('loads all plans', () => {
-    expect(loadPlans()).toHaveLength(14);
+    expect(loadPlans()).toHaveLength(10);
   });` };
  const r = detectInPatch(f).filter((x) => x.rule === 'expectation-changed');
  assert.equal(r.length, 1);
  assert.match(r[0].label, /14.*→.*10/);
});

test('규칙3a — 아예 다른 줄끼리는 짝짓지 않는다 (오탐 방지)', () => {
  const f = { path: 'a.test.ts', patch:
`@@ -1,4 +1,4 @@
-  expect(countUsers()).toBe(14);
+  expect(computeTax(salary)).toBe(10);` };
  assert.equal(detectInPatch(f).filter((x) => x.rule === 'expectation-changed').length, 0);
});

test('규칙3b — matcher 가 느슨해지면 잡는다', () => {
  const f = { path: 'a.test.ts', patch:
`@@ -1,3 +1,3 @@
-  expect(result).toBe(42);
+  expect(result).toBeTruthy();` };
  const r = detectInPatch(f).filter((x) => x.rule === 'matcher-loosened');
  assert.equal(r.length, 1);
});

test('규칙4 — 테스트 파일 삭제', () => {
  const r = detectInPatch({ path: 'a.test.ts', status: 'removed' });
  assert.equal(r.length, 1);
  assert.equal(r[0].rule, 'test-file-removed');
  assert.equal(r[0].severity, 'high');
});

test('detect — 프로덕션 파일은 아예 안 본다', () => {
  const files = [{ path: 'src/index.ts', patch: '@@ -1,1 +1,1 @@\n+  it.skip("x", () => {})' }];
  assert.equal(detect(files, GLOBS).length, 0, '프로덕션 코드 안의 문자열은 우리 관심사가 아니다');
});

test('looksLikeSameLine — 숫자만 다르면 같은 줄로 본다', () => {
  assert.equal(looksLikeSameLine('expect(a).toBe(14);', 'expect(a).toBe(10);'), true);
  assert.equal(looksLikeSameLine('expect(a).toBe(14);', 'expect(b).toBe(10);'), false);
});

test('renderComment — 0건이면 코멘트를 만들지 않는다 (소음 금지)', () => {
  assert.equal(renderComment([]), null);
});

test('renderComment — 탐지가 있으면 위치와 무엇이 바뀌었는지 담는다', () => {
  const body = renderComment([
    { path: 'a.test.ts', line: 42, rule: 'expectation-changed', label: '기대값 변경 toHaveLength(14) → 10',
      before: 'expect(x).toHaveLength(14);', after: 'expect(x).toHaveLength(10);', severity: 'medium' },
  ]);
  assert.match(body, /TestGuard/);
  assert.match(body, /a\.test\.ts:42/);
  assert.match(body, /toHaveLength\(14\)/);
});
