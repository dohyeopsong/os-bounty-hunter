import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// .env 로드 (프로젝트 루트)
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(__dirname, '..');
dotenv.config({ path: join(projectRoot, '.env') });

/**
 * claude-glm 래퍼 경로를 해석한다.
 * Pamout 게이트웨이 env(ANTHROPIC_BASE_URL, 키체인 토큰)을 주입하는 건
 * 이 래퍼뿐이다. bare `claude` 는 실제 Anthropic 인증을 시도해 실패한다.
 */
function resolveClaudeBin() {
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude-glm'),
    '/usr/local/bin/claude-glm',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'claude-glm'; // PATH fallback (없으면 solve.js 가 에러 안내)
}

export const config = {
  projectRoot,
  workspaceDir: join(projectRoot, 'workspace'),
  defaultLanguage: process.env.DEFAULT_LANGUAGE || 'JavaScript',
  perPage: 20,
  githubToken: process.env.GITHUB_TOKEN || '',
  claudeBin: resolveClaudeBin(),
  // 헤드리스 solver 실행 하드 타임아웃 (ms). 좀비 프로세스/네트워크 무한 대기 방지.
  // env SOLVE_TIMEOUT_MS 로 덮어쓰기 가능. 기본 10분.
  solveTimeoutMs: Number(process.env.SOLVE_TIMEOUT_MS) || 10 * 60 * 1000,
};

/**
 * workspace 경로가 projectRoot/workspace 하위인지 검증 — escape 차단.
 * @returns {string} 정규화된 안전 경로
 */
export function safeWorkspacePath(sub) {
  const target = resolve(config.workspaceDir, sub);
  if (!target.startsWith(resolve(config.workspaceDir))) {
    throw new Error(`경로 escape 시도 차단: ${sub}`);
  }
  return target;
}
