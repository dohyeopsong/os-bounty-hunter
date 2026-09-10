import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

// 허용 도구 화이트리스트. 분류기/Manual 프롬프트를 거치지 않고 바로 실행된다.
// node 는 테스트 스크립트 실행에 필요하므로 포함 (없으면 3.7절처럼 거부됨).
// push/PR 차단은 아래 DISALLOWED_TOOLS 가 하드 블록한다 (allowlist 누락에만 의존 X).
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(node *)',
  'Bash(npm test)',
  'Bash(npm run *)',
  'Bash(npx *)',
  'Bash(git diff)',
  'Bash(git status)',
  'Bash(git log *)',
  'Bash(git add *)',
  'Bash(ls *)',
  'Bash(cat *)',
  'Bash(find *)',
].join(' ');

// 헤드리스 solver 하드 차단 목록. allowlist 와 무관하게 무조건 거부된다.
// claude -p 는 cwd 가 타겟 레포라 .claude/settings.json 을 로드하지 않으므로,
// push/PR 방어는 이 CLI 플래그로 직접 주입해야 한다.
const DISALLOWED_TOOLS = [
  'Bash(git push:*)',
  'Bash(git remote:*)',
  'Bash(gh pr:*)',
  'Bash(gh repo:*)',
].join(' ');

/**
 * 가드레일 시스템 프롬프트 — CLAUDE.md 와 동일 내용을 --append-system-prompt 로
 * 이중 주입한다.
 */
async function guardrailsPrompt() {
  try {
    const claudeMd = join(config.projectRoot, 'CLAUDE.md');
    return await readFile(claudeMd, 'utf8');
  } catch {
    return FALLBACK_GUARDRAILS;
  }
}

const FALLBACK_GUARDRAILS = `
안전 규칙 (절대):
- 모든 작업은 현재 워크스페이스 디렉터리 내부에서만. 상위 디렉터리 수정 금지.
- git push, 원격 조작, PR 생성 절대 금지.
- 포맷팅만 변경하는 수정 금지 — 반드시 로직 수정 포함.
- npm test 가 있으면 수정 후 실행, 결과 보고.
최종 응답은 아래 헤더 구조를 정확히 따를 것:
## Summary / ## Changes / ## Test Results / ## PR Description
`;

/**
 * Solve 프롬프트 빌더.
 */
function buildSolvePrompt(issue, language) {
  return `당신은 오픈소스 버그 헌터입니다. 아래 GitHub 이슈를 해결하는 코드 수정을 수행하세요.

# 이슈 정보
- 레포: ${issue.owner}/${issue.repo} (#${issue.number})
- 언어: ${language}
- URL: ${issue.htmlUrl}

# 이슈 본문
${issue.body}

# 이슈 댓글 (수정 방향이 명시된 경우가 많음)
${issue.comments}

# 수행 지침
1. 현재 디렉터리의 코드 구조를 분석한다 (Read/Glob/Grep 사용).
2. 이슈 본문과 댓글의 요구사항을 파악한다.
3. 최소한의 변경으로 로직을 수정한다 (Edit/Write 사용).
   - 포맷팅(띄어쓰기/줄바꿈)만 변경하지 마라 — 반드시 로직 수정.
   - 관련 없는 파일은 수정하지 마라.
4. package.json 에 test 스크립트가 있으면 "npm test" 를 실행해 결과를 확인한다.
   - 실패하면 원인 분석, 가능하면 수정.
5. 작업은 반드시 현재 디렉터리 내부에서만. git push / 원격 조작 / PR 생성 절대 금지.

# 최종 응답 형식 (반드시 아래 마크다운 헤더 준수, 다른 헤더 추가 금지)
## Summary
(무엇을 왜 수정했는지 논리적 근거)

## Changes
(기존 코드 vs 변경 코드의 핵심 차이점)

## Test Results
(npm test 결과. 테스트 없으면 "N/A", 실패 시 원인)

## PR Description
(GitHub PR 제출용 영문 본문. 복사해 바로 쓸 수 있게)
`;
}

/**
 * 헤드리스 claude-glm -p 를 호출해 이슈를 해결한다.
 *
 * @param {string} repoDir  clone 된 레포 절대 경로 (cwd)
 * @param {object} issue    전체 컨텍스트가 포함된 이슈 객체 (body, comments 포함)
 * @param {string} language
 * @returns {{ result: string, ok: boolean, error?: string }}
 */
export async function solveIssue(repoDir, issue, language) {
  const guardrails = await guardrailsPrompt();
  const prompt = buildSolvePrompt(issue, language);

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--add-dir', repoDir,
    '--allowed-tools', ALLOWED_TOOLS,
    '--disallowed-tools', DISALLOWED_TOOLS,
    '--append-system-prompt', guardrails,
  ];

  console.log(`  🤖  헤드리스 Claude 호출: ${config.claudeBin}`);

  return new Promise((resolve) => {
    const child = execFile(config.claudeBin, args, {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_SIMPLE: '1' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        resolve({
          ok: false,
          error: `claude-glm 래퍼를 찾을 수 없음: ${config.claudeBin}\nsetup-claude-glm.sh 를 먼저 실행하세요.`,
          result: '',
        });
      } else {
        resolve({ ok: false, error: String(err), result: '' });
      }
    });

    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        resolve({
          ok: false,
          error: `claude-glm 종료 코드 ${code}\n${stderr.slice(0, 2000)}`,
          result: '',
        });
        return;
      }
      // --output-format json: { "result": "...", ... }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ ok: true, result: parsed.result || stdout, raw: parsed });
      } catch {
        // json 파싱 실패 시 raw stdout 을 결과로 사용
        resolve({ ok: code === 0, result: stdout, error: code !== 0 ? stderr.slice(0, 1000) : undefined });
      }
    });
  });
}
