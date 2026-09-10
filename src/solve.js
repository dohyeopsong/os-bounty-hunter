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
 * 프롬프트 템플릿 캐시. 첫 호출 시 src/prompts/solve.txt 를 읽어 둔다.
 * 템플릿 안의 {{placeholder}} 를 변수로 치환한다. 프롬프트 텍스트를
 * 로직(js)과 분리해 언어별/도메인별 확장을 쉽게 만든다.
 */
let _solveTemplate = null;
async function loadSolveTemplate() {
  if (_solveTemplate) return _solveTemplate;
  const tplPath = join(config.projectRoot, 'src', 'prompts', 'solve.txt');
  try {
    _solveTemplate = await readFile(tplPath, 'utf8');
  } catch {
    throw new Error(`Solve 프롬프트 템플릿을 찾을 수 없음: ${tplPath}`);
  }
  return _solveTemplate;
}

/**
 * 신뢰할 수 없는 사용자 입력(이슈 본문/댓글)에서 프롬프트 펜스 태그를 제거한다.
 * 공격자가 이슈 본문에 </issue_body> 를 넣어 XML 울타리를 탈출한 뒤
 * 새 지시를 주입하는(prompt injection) 것을 막는다.
 */
function sanitizeUserInput(text) {
  if (!text) return '';
  return String(text)
    // 프롬프트 펜스 태그 탈출 방지 (XML injection)
    .replace(/<\/?issue_body>/gi, '[filtered]')
    .replace(/<\/?issue_comments>/gi, '[filtered]')
    // 템플릿 플레이스홀더 악용 방지 ({{issue_body}} 등을 본문에 넣어 치환 유도 차단)
    .replace(/\{\{[^}]+\}\}/g, '[filtered]');
}

/**
 * Solve 프롬프트 빌더 — 템플릿 파일을 로드해 변수를 치환한다.
 * 이슈 본문/댓글은 sanitizeUserInput 로 정제한 뒤 주입한다.
 */
async function buildSolvePrompt(issue, language) {
  const tpl = await loadSolveTemplate();
  return tpl
    .replace(/\{\{owner\}\}/g, issue.owner || '')
    .replace(/\{\{repo\}\}/g, issue.repo || '')
    .replace(/\{\{number\}\}/g, issue.number || '')
    .replace(/\{\{language\}\}/g, language || '')
    .replace(/\{\{htmlUrl\}\}/g, issue.htmlUrl || '')
    .replace(/\{\{issue_body\}\}/g, sanitizeUserInput(issue.body))
    .replace(/\{\{issue_comments\}\}/g, sanitizeUserInput(issue.comments));
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
  const prompt = await buildSolvePrompt(issue, language);

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--add-dir', repoDir,
    '--allowed-tools', ALLOWED_TOOLS,
    '--disallowed-tools', DISALLOWED_TOOLS,
    '--append-system-prompt', guardrails,
  ];

  const timeoutMs = config.solveTimeoutMs;
  console.log(`  🤖  헤드리스 Claude 호출: ${config.claudeBin} (타임아웃 ${Math.round(timeoutMs / 1000)}s)`);

  return new Promise((resolve) => {
    const child = execFile(config.claudeBin, args, {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      // 운영체제 단 하드 타임아웃 — claude-glm 이 네트워크 무한 대기 등으로
      // 좀비 프로세스가 되는 것을 막는다. 시간 초과 시 SIGTERM 으로 프로세스 종료.
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      env: { ...process.env, CLAUDE_CODE_SIMPLE: '1' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        resolve({
          ok: false,
          error: `claude-glm 래퍼를 찾을 수 없음: ${config.claudeBin}\nsetup-claude-glm.sh 를 먼저 실행하세요.`,
          result: '',
        });
      } else if (err.killed) {
        // timeout 옵션이 프로세스를 죽인 경우 (TimeoutError)
        timedOut = true;
        resolve({
          ok: false,
          error: `claude-glm 타임아웃 (${Math.round(timeoutMs / 1000)}s 초과). 좀비 프로세스 종료.\n${stderr.slice(0, 1000)}`,
          result: '',
        });
      } else {
        resolve({ ok: false, error: String(err), result: '' });
      }
    });

    child.on('close', (code, signal) => {
      if (timedOut) return; // 이미 error 핸들러에서 resolve 됨
      // timeout 에 의해 SIGTERM 으로 종료된 경우 (close 만 발생하는 경로 대비)
      if (signal === 'SIGTERM' && code === null) {
        resolve({
          ok: false,
          error: `claude-glm 타임아웃 (${Math.round(timeoutMs / 1000)}s 초과). 프로세스 강제 종료됨.`,
          result: stdout ? safeExtractResult(stdout) : '',
        });
        return;
      }
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

/**
 * stdout 에서 부분적으로 들어온 JSON 의 result 필드만 안전 추출 (타임아웃 시).
 */
function safeExtractResult(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.result || '';
  } catch {
    return '';
  }
}
