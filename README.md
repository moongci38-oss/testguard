# TestGuard

**AI 에이전트가 테스트를 약하게 만들어 CI를 초록으로 만든 PR을 잡아냅니다.**

쉽게 말하면 — 답안을 다시 채점하는 게 아니라, **학생이 정답지를 고쳤는지** 봅니다.

```
🛡️ TestGuard — 이 PR이 테스트를 약하게 만들었을 수 있습니다
탐지 2건 (높음 1 · 보통 1)

🔴  src/load-plan.test.ts:41   skip 추가
🟡  src/load-plan.test.ts:58   기대값 변경 toHaveLength(14) → 10
```

## 왜 필요한가

에이전트가 PR을 쓰고 **"테스트 통과했습니다"** 라고 보고합니다. 사람은 그걸 눈으로 믿습니다.
그런데 통과시키는 가장 쉬운 방법은 코드를 고치는 게 아니라 **테스트를 고치는 것**입니다.

CI가 빨간 건 GitHub이 이미 보여줍니다. **CI가 초록인데 테스트가 무력화된 PR** — 그게 안 보입니다.

## 무엇을 잡나

| | 예시 |
|---|---|
| **skip / only 추가** | `it.skip(` · `@pytest.mark.skip` · `t.Skip(` · `#[ignore]` · `@Disabled` |
| **단언(assert) 삭제** | `expect` 3개 → 1개 |
| **기대값 하향** | `toHaveLength(14)` → `toHaveLength(10)` |
| **matcher 느슨해짐** | `toBe(42)` → `toBeTruthy()` · `assertEqual` → `assertTrue` |
| **테스트 파일 삭제** | — |

JS/TS · Python · Go · Rust · JVM. **테스트 파일만** 봅니다.

## 쓰는 법

```yaml
name: TestGuard
on: pull_request

jobs:
  guard:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write   # 코멘트용
    steps:
      - uses: lumir/testguard@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

체크아웃도, 설치도 필요 없습니다. PR의 diff만 봅니다.

### 옵션

| 입력 | 기본 | 설명 |
|---|---|---|
| `github-token` | (필수) | 보통 `${{ secrets.GITHUB_TOKEN }}` |
| `test-globs` | 흔한 규칙들 | 테스트 파일로 볼 경로 패턴(줄바꿈 구분) |
| `fail-on-detect` | `false` | `true`면 심각도 높음에서 Action 실패 |
| `comment` | `true` | PR 코멘트 작성 여부 |

**기본은 막지 않고 알려주기만 합니다.** 테스트를 고치는 정당한 이유도 많습니다 —
이 도구는 그걸 판단하지 않고 **눈에 띄게** 합니다. 판단은 리뷰어가 합니다.

## 설계 원칙 (읽어볼 만한 부분)

**1. LLM을 쓰지 않습니다.** 판정은 전부 결정론적 파서입니다.
LLM으로 판정하면 PR 안의 텍스트로 **판정 자체를 위조**할 수 있습니다.

**2. PR 본문에서 아무것도 실행하지 않습니다.**
포크 PR의 본문은 공격자 — 그리고 우리가 검증하려는 바로 그 에이전트 — 가 통제하는 입력입니다.

**3. 설정을 PR 브랜치에서 읽지 않습니다.**
에이전트가 같은 PR에서 설정 파일을 고칠 수 있으면 구멍은 그대로입니다.
설정은 워크플로 파일의 `with:` 뿐입니다.

**4. 우리가 실패해도 당신의 PR을 막지 않습니다.**
이 Action의 버그가 남의 배포를 세우면 안 됩니다. 실패는 로그에 남기되 통과시킵니다.
단 **"약화 없음"과 "확인하지 못함"은 다르게 적습니다.**

## 오탐에 대해

오탐이 나면 도구가 죽습니다. 그래서 이런 것들은 **일부러 안 잡습니다**:

- 원래 있던 `skip`이 자리만 옮긴 경우
- 단언 개수가 유지되는 리팩터링 (`getUser()` 두 번 → 변수로 빼기)
- 서로 다른 줄의 숫자가 우연히 바뀐 경우

오탐을 발견하시면 이슈로 알려주세요 — 규칙에 반례를 추가합니다.

## 상태

**v0.1.0 — 초기 공개.** 테스트 18개. 실제 PR에서 쓰면서 규칙을 늘려가는 중입니다.

MIT.
