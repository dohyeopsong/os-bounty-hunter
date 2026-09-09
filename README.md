# OS-Bounty-Hunter

> **Disclaimer:** This tool is strictly for educational purposes and personal workflow optimization. The author is not responsible for any spam or policy violations on GitHub caused by the misuse of this agent. Please use it responsibly and do not spam open-source projects with automated PRs.

GitHub의 `good first issue`를 자동 수집 → 로컬 격리 `clone` → 헤드리스 Claude로 버그 수정 → PR 초안(`PR_DRAFT.md`)까지 생성하는 CLI 툴입니다.

**push와 PR 생성은 절대 자동으로 하지 않습니다.** 최종 제출은 항상 사람이 검수한 뒤 수동으로 합니다.

---

## 🏗️ 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                      os-bounty-hunter CLI                    │
│                                                              │
│  [1/4] Fetch    [2/4] Clone     [3/4] Solve    [4/4] Draft   │
│   ┌────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐   │
│   │ GitHub │───▶│ shallow │───▶│ 헤드리스 │───▶│  PR_D   │   │
│   │ Search │    │  clone  │    │ Claude  │    │ RAFT.md │   │
│   │  API   │    │ + npm i │    │  (격리) │    │ + commit│   │
│   └────────┘    └─────────┘    └─────────┘    └─────────┘   │
│       │              │              │              │          │
│       ▼              ▼              ▼              ▼          │
│   이슈 목록     workspace/     코드 수정       PR 초안        │
│   (터미널)      (격리 디렉터리) (Edit/Write)   (수동 push)    │
└─────────────────────────────────────────────────────────────┘
```

**파이프라인 단계:**

| 단계 | 동작 | 파일 |
|------|------|------|
| **Fetch** | GitHub Search API로 `good first issue` 조회 · 이슈 본문+댓글 로드 | `src/github.js` |
| **Clone** | `workspace/` 하위에 shallow clone · `--ignore-scripts`로 의존성 설치 · fix 브랜치 생성 | `src/git.js` |
| **Solve** | 헤드리스 `claude -p` 호출 · 도구 화이트리스트 + 가드레일 시스템 프롬프트로 코드 분석·수정 | `src/solve.js` |
| **Draft** | Solve 결과를 파싱해 `PR_DRAFT.md` 생성 · 실제 diff 포함 · 로컬 커밋 (push 금지) | `src/draft.js` |

---

## 🛡️ 안전 설계

이 툴은 남의 레포지토리를 자동 수정하는 민감한 작업이므로 여러 겹의 가드레일을 둡니다.

- **작업 격리** — 모든 파일/git 작업은 `workspace/` 하위에서만. 프로젝트 루트나 상위 디렉터리 수정 불가 (`safeWorkspacePath()` 경로 검증)
- **push/PR 금지** — 헤드리스 Claude의 `--allowed-tools` 화이트리스트에 `git push`, `gh`, `git remote` 등 원격 명령이 없음. `CLAUDE.md` 가드레일로 이중 차단
- **노이즈 제외** — `npm install`이 만드는 `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`은 커밋과 diff에서 자동 제외
- **의존성 스크립트 차단** — `npm install --ignore-scripts`로 install 시 부작용 스크립트 실행 방지
- **최종 검수** — PR 생성 자동화 없음. `PR_DRAFT.md`를 사람이 읽고 수동으로 push

---

## 🚀 설치 및 실행

### 사전 요구사항

- Node.js ≥ 20
- Git
- Claude Code CLI (`claude`) — Solve 단계에서 사용. [Pamout 게이트웨이](https://llm.pamout.com) 등 호환 래퍼로 실행 권장
- (선택) GitHub Personal Access Token — 없으면 비인증(10회/분 제한). 공개 레포 clone은 토큰 없이 가능

### 설치

```bash
git clone https://github.com/dohyeopsong/os-bounty-hunter.git
cd os-bounty-hunter
npm install
```

### 환경변수

`.env.example`을 복사해 `.env`를 만들고 값을 채웁니다 (`.env`는 `.gitignore`에 이미 포함되어 push에서 제외됨).

```bash
cp .env.example .env
```

```env
# GitHub Personal Access Token (선택)
# 발급: https://github.com/settings/tokens (classic token, repo 스코프 권장)
GITHUB_TOKEN=

# 기본 검색 언어 (선택, 기본값: JavaScript)
DEFAULT_LANGUAGE=JavaScript
```

### 실행

```bash
# 대화형 — 이슈 목록에서 번호 선택
npm start
# 또는
node src/cli.js

# 언어 지정
node src/cli.js --lang Python

# 엔드투엔드 자동 실행 (이슈 1번 자동 선택)
bash run-e2e.sh
```

### 실행 예시

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OS-Bounty-Hunter
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1/4] Fetch — JavaScript good first issue 검색 중...

🔍 JavaScript · good first issue (20개, 최근 업데이트순)

   1. owner/repo #42
      Fix off-by-one error in pagination helper
      https://github.com/owner/repo/issues/42
   ...

번호를 선택하세요 (1-20): 1

[2/4] Clone — 로컬 격리 workspace
  ⬇️  clone (shallow): owner/repo
  📦  npm install --ignore-scripts ...
  ✓  의존성 설치 완료

[3/4] Solve — 헤드리스 Claude 로 코드 분석·수정
  🤖  헤드리스 Claude 호출
  ✓  Solve 완료

[4/4] Draft — PR_DRAFT.md 생성
  📄  PR_DRAFT.md 생성
  ✓  로컬 커밋: fix: resolve #42

✅ 완료. PR_DRAFT.md 를 검수한 뒤 수동으로 push 하세요.
```

> 💡 **실행 화면 GIF 자리** — 터미널에서 봇이 실행되는 모습을 녹화한 GIF를 여기에 넣으면 됩니다 (`![demo](./docs/demo.gif)`).

### 결과 검수 및 제출

```bash
cd workspace/<owner>-<repo>-<이슈번호>
cat PR_DRAFT.md            # 초안 검토
git diff HEAD~1            # 실제 변경 확인
git push -u origin fix-issue-<이슈번호>   # 수동 push
```

---

## 📁 프로젝트 구조

```
os-bounty-hunter/
├── src/
│   ├── cli.js        # 4단계 파이프라인 진입점
│   ├── config.js     # 설정 로드 + 경로 검증 (escape 차단)
│   ├── github.js     # GitHub Search API + 이슈 본문/댓글 로드
│   ├── git.js        # shallow clone, 의존성 설치, stage/commit
│   ├── solve.js      # 헤드리스 Claude 호출 (도구 화이트리스트 + 가드레일)
│   └── draft.js      # PR_DRAFT.md 생성 (신규 파일 diff 포함)
├── CLAUDE.md         # 헤드리스 에이전트 가드레일 지침
├── run-e2e.sh        # 엔드투엔드 실행 러너
├── .env.example      # 환경변수 템플릿
└── .gitignore        # .env, workspace/, node_modules/ 제외
```

---

## ⚠️ 사용 시 주의사항

- **API 키 보안**: `.env`에만 토큰을 넣고, `.env`는 `.gitignore`에 포함되어 있으니 절대 커밋하지 마세요.
- **비인증 제한**: `GITHUB_TOKEN` 없이 실행하면 GitHub Search API가 10회/분으로 제한됩니다.
- **Solve 품질**: 헤드리스 LLM이 만든 수정은 항상 사람이 검수해야 합니다. 자동 생성된 PR을 검토 없이 남의 레포에 보내지 마세요.
- **요금 주의**: Solve 단계에서 LLM API를 호출하므로 사용량에 따라 비용이 발생합니다.

## 📜 라이선스

MIT
