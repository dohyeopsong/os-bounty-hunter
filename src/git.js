import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { config, safeWorkspacePath } from './config.js';

/**
 * 동기식 git 명령 래퍼. 에러를 읽기 쉽게 가공한다.
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
 * 선택된 이슈의 레포를 workspace/ 하위에 shallow clone 하고
 * fix-issue-{번호} 브랜치를 생성한다.
 *
 * @returns {string} clone 된 레포의 절대 경로
 */
export function cloneRepo(issue) {
  const { owner, repo, number } = issue;
  const dirName = `${owner}-${repo}-${number}`;
  const target = safeWorkspacePath(dirName);

  // 이미 존재하면 스킵 (재실행 대응)
  if (existsSync(target)) {
    console.log(`  ℹ️  이미 존재: ${target} (재사용)`);
    return target;
  }

  mkdirSync(config.workspaceDir, { recursive: true });

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  console.log(`  ⬇️  clone (shallow): ${owner}/${repo}`);
  git(['clone', '--depth', '1', cloneUrl, target], config.workspaceDir);

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
const NOISE_PATHS = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

/**
 * 의도한 변경사항을 스테이징한다.
 * `git add -A` 는 untracked 신규 파일(Solve 가 Write 한 파일)까지 잡기 위해
 * 쓰되, pathspec exclude 로 노이즈 파일은 제외한다.
 *
 * 스테이징을 getDiff() 보다 먼저 수행하는 게 핵심이다 — 그래야
 * `git diff --cached` 가 신규 파일까지 diff 에 포함한다.
 * (untracked 상태의 새 파일은 일반 `git diff` 에 보이지 않는다.)
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
