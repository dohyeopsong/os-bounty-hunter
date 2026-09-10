import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, safeWorkspacePath } from './config.js';

/**
 * 동기식 git 명령 래퍼. 에러를 읽기 쉽게 가공한다.
 * 빠르고 실패 확률이 낮은 명령(checkout, rev-parse 등)에만 쓴다.
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`git ${args.join(' ')} 실패:\n${stderr}`);
  }
}

/**
 * 비동기 git 명령 래퍼. clone 처럼 네트워크 I/O 가 있어 재시도가 필요한 명령용.
 * 에러 메시지에 stderr 를 포함해 호출측이 네트워크 에러 여부를 판별할 수 있게 한다.
 */
function gitAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, (err, _stdout, stderr) => {
      if (err) {
        const detail = stderr && stderr.trim() ? stderr.trim() : err.message;
        reject(new Error(`git ${args.join(' ')} 실패:\n${detail}`));
      } else {
        resolve();
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 디렉터리가 "그 위치 자체의" 유효한 git working tree 인지 검증.
 * 빈 디렉터리, 중단된 clone 잔해, 손상된 .git 모두 false.
 *
 * 주의: `git rev-parse --is-inside-work-tree` 만으로는 부족하다. git 은 cwd 에
 * .git 이 없으면 부모 디렉터리로 올라가 repo 를 찾는다. workspace/ 는
 * os-bounty-hunter 저장소 내부에 있으므로, target 의 .git 이 깨졌거나 없어도
 * 부모 repo 를 발견해 true 를 반환한다 — 그러면 깨진 클론을 "재사용"해버린다.
 *
 * 따라서 working tree 의 최상단(toplevel)이 target 과 정확히 일치하는지까지
 * 확인한다. target 자체가 유효한 repo 루트면 toplevel == target 이고,
 * target 의 .git 이 깨져 부모로 올라간 경우 toplevel == 부모 != target 이다.
 */
function isValidGitRepo(dir) {
  try {
    const toplevel = git(['rev-parse', '--show-toplevel'], dir);
    return resolve(toplevel) === resolve(dir);
  } catch {
    return false;
  }
}

/**
 * 일시적 네트워크 에러 패턴 — 재시도 대상.
 * 영구 에러(레포 없음·권한 거부)는 여기에 안 걸려 즉시 실패한다.
 */
const NETWORK_ERROR_PATTERNS = [
  /could not resolve host/i,
  /connection timed out/i,
  /connection reset/i,
  /rpc failed/i,
  /early eof/i,
  /remote end hung up/i,
  /ssl_error/i,
  /failed to connect/i,
  /network is unreachable/i,
  /unable to access/i,
];

function isNetworkError(message) {
  return NETWORK_ERROR_PATTERNS.some((re) => re.test(message));
}

const CLONE_MAX_RETRIES = 3;
const CLONE_RETRY_BASE_MS = 2000;

/**
 * 선택된 이슈의 레포를 workspace/ 하위에 shallow clone 하고
 * fix-issue-{번호} 브랜치를 생성한다.
 *
 * 엔지니어링 포인트:
 *  1. 기존 폴더 처리 — 이름만 같다고 재사용하지 않는다. 유효한 git repo 인지
 *     검증하고, 깨졌거나 --fresh 면 지우고 재클론한다. (부분 클론 잔해 방지)
 *  2. 네트워크 에러 — 일시적 오류(DNS, 타임아웃, RPC)는 지수 백오프로 재시도.
 *     영구 에러(레포 없음·권한 거부)는 재시도하지 않고 즉시 throw.
 *  3. 부분 클론 정리 — clone 실패 시 남은 디렉터리를 삭제한다. 그렇지 않으면
 *     다음 실행이 깨진 클론을 "재사용"해서 원인 불명 에러가 난다.
 *
 * @param {object} issue
 * @param {object} [opts]
 * @param {boolean} [opts.fresh=false]  기존 workspace 강제 삭제 후 재클론
 * @returns {Promise<string>} clone 된 레포의 절대 경로
 */
export async function cloneRepo(issue, opts = {}) {
  const { owner, repo, number } = issue;
  const dirName = `${owner}-${repo}-${number}`;
  const target = safeWorkspacePath(dirName);
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  mkdirSync(config.workspaceDir, { recursive: true });

  // --- 기존 폴더 처리 ---
  if (existsSync(target)) {
    if (opts.fresh) {
      console.log(`  🧹  --fresh: 기존 디렉터리 삭제`);
      rmSync(target, { recursive: true, force: true });
    } else if (isValidGitRepo(target)) {
      console.log(`  ℹ️  이미 존재 (유효한 repo): ${target} (재사용)`);
      return target;
    } else {
      console.log(`  ⚠️  기존 디렉터리가 깨진 repo — 삭제 후 재클론`);
      rmSync(target, { recursive: true, force: true });
    }
  }

  // --- 네트워크 재시도 루프 ---
  let lastErr = null;
  for (let attempt = 1; attempt <= CLONE_MAX_RETRIES; attempt++) {
    const tag = attempt > 1 ? ` (재시도 ${attempt}/${CLONE_MAX_RETRIES})` : '';
    console.log(`  ⬇️  clone (shallow): ${owner}/${repo}${tag}`);
    try {
      await gitAsync(['clone', '--depth', '1', cloneUrl, target], config.workspaceDir);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // 부분 클론 잔해 정리 — 깨진 상태로 남겨두지 않는다
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
      }
      const retryable = isNetworkError(err.message) && attempt < CLONE_MAX_RETRIES;
      if (retryable) {
        const wait = CLONE_RETRY_BASE_MS * 2 ** (attempt - 1);
        console.log(`  ⚠️  네트워크 에러 — ${wait}ms 후 재시도`);
        await sleep(wait);
        continue;
      }
      break; // 영구 에러이거나 마지막 시도
    }
  }

  if (lastErr) {
    throw new Error(`clone 실패 (${owner}/${repo}):\n${lastErr.message}`);
  }

  // --- 브랜치 생성 ---
  const branch = `fix-issue-${number}`;
  console.log(`  🌿  브랜치 생성: ${branch}`);
  git(['checkout', '-b', branch], target);

  return target;
}

/**
 * JS 프로젝트면 의존성 설치 — 이후 npm test 동작의 전제.
 * --ignore-scripts 로 install 시 부작용 스크립트 실행을 방지한다.
 */
export function installDeps(repoDir) {
  if (!existsSync(`${repoDir}/package.json`)) {
    console.log('  ℹ️  package.json 없음 — 의존성 설치 스킵');
    return false;
  }
  console.log('  📦  npm install --ignore-scripts ...');
  try {
    execFileSync('npm', ['install', '--ignore-scripts'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('  ✓  의존성 설치 완료');
    return true;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    console.log(`  ⚠️  npm install 실패 (계속 진행):\n${stderr}`);
    return false;
  }
}

/**
 * installDeps() 등이 만들어낸 이슈와 무관한 노이즈 파일.
 * 이 파일들은 스테이징/커밋/ diff 에서 모두 제외된다.
 */
const NOISE_PATHS = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'PR_DRAFT.md'];

/**
 * 의도한 변경사항을 스테이징한다.
 * `git add -A` 는 untracked 신규 파일(Solve 가 Write 한 파일)까지 잡기 위해
 * 쓰되, pathspec exclude 로 노이즈 파일은 제외한다.
 *
 * 노이즈: lockfile(installDeps 부산물) + PR_DRAFT.md(이 초안 자체).
 * PR_DRAFT.md 는 generateDraft() 가 커밋 직전에 디스크에 쓰므로, 제외하지
 * 않으면 fix 커밋에 초안 파일이 섞여 PR diff 에 노이즈로 보인다.
 *
 * 스테이징을 getDiff() 보다 먼저 수행하는 게 핵심이다 — 그래야
 * `git diff --cached` 가 신규 파일까지 diff 에 포함한다.
 * (untracked 상태의 새 파일은 일반 `git diff` 에 보이지 않는다.)
 *
 * 멱등: commitChanges() 도 내부에서 호출하지만, 중복 실행해 안전하다.
 */
export function stageChanges(repoDir) {
  const exclude = NOISE_PATHS.map((p) => `:!${p}`);
  git(['add', '-A', '--', ...exclude], repoDir);
}

/**
 * 로컬 커밋. push 절대 금지 — 이 함수는 push 하지 않는다.
 */
export function commitChanges(repoDir, issue) {
  stageChanges(repoDir);
  // 스테이징된(=커밋 대상) 변경사항이 있는지 확인.
  // untracked 노이즈 파일은 스테이징되지 않았으므로 여기서 무시된다.
  const staged = git(['diff', '--cached', '--name-only'], repoDir);
  if (!staged) {
    console.log('  ℹ️  커밋할 변경사항 없음');
    return false;
  }
  const msg = `fix: resolve #${issue.number}`;
  git(['commit', '-m', msg], repoDir);
  console.log(`  ✓  로컬 커밋: ${msg}`);
  return true;
}

/**
 * 스테이징된 변경 diff 반환 (draft 용).
 * 반드시 stageChanges() 이후에 호출해야 한다 — 그렇지 않으면 신규 파일이
 * 빠진다.
 */
export function getDiff(repoDir) {
  const stat = git(['diff', '--cached', '--stat'], repoDir);
  const full = git(['diff', '--cached'], repoDir);
  return { stat, full };
}
