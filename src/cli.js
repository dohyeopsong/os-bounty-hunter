#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { config } from './config.js';
import { searchIssues, printIssueList, fetchIssueContext } from './github.js';
import { cloneRepo, installDeps } from './git.js';
import { solveIssue } from './solve.js';
import { generateDraft } from './draft.js';

function parseArgs(argv) {
  const args = { lang: config.defaultLanguage, fresh: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--lang' || a === '-l') && argv[i + 1]) {
      args.lang = argv[++i];
    } else if (a === '--fresh') {
      args.fresh = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
os-bounty-hunter — GitHub good first issue 자동 해결 CLI

사용법:
  os-bounty-hunter [--lang <언어>]

옵션:
  --lang, -l    검색할 언어 (기본: ${config.defaultLanguage})
  --fresh       선택한 이슈의 기존 workspace 를 지우고 다시 clone
  --help, -h    도움말

환경변수:
  GITHUB_TOKEN        (선택) GitHub PAT. 없으면 비인증 (10회/분 제한)
  DEFAULT_LANGUAGE    (선택) 기본 검색 언어

안전:
  모든 작업은 workspace/ 내부에만 격리됩니다.
  봇은 push / PR 생성을 절대 하지 않습니다 — 최종 제출은 수동으로.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  console.log('━'.repeat(60));
  console.log('  OS-Bounty-Hunter');
  console.log('━'.repeat(60));

  // --- 1. Fetch ---
  console.log(`\n[1/4] Fetch — ${args.lang} good first issue 검색 중...`);
  const issues = await searchIssues(args.lang);
  printIssueList(issues, args.lang);
  if (issues.length === 0) return;

  const rl = readline.createInterface({ input, output });
  let choice;
  try {
    const answer = await rl.question('\n번호를 선택하세요 (1-' + issues.length + '): ');
    choice = parseInt(answer, 10);
    if (isNaN(choice) || choice < 1 || choice > issues.length) {
      console.log('잘못된 번호입니다.');
      rl.close();
      process.exit(1);
    }
  } finally {
    rl.close();
  }

  const selected = issues[choice - 1];
  console.log(`\n선택: ${selected.owner}/${selected.repo} #${selected.number}`);

  // 선택된 이슈의 전체 본문 + 댓글 로드
  console.log('  📋  전체 이슈 본문 + 댓글 로드 중...');
  const issueCtx = await fetchIssueContext(selected);

  // --- 2. Clone ---
  console.log('\n[2/4] Clone — 로컬 격리 workspace');
  const repoDir = await cloneRepo(selected, { fresh: args.fresh });
  installDeps(repoDir);

  // --- 3. Solve ---
  console.log('\n[3/4] Solve — 헤드리스 Claude 로 코드 분석·수정');
  const solveResult = await solveIssue(repoDir, issueCtx, args.lang);
  if (solveResult.ok) {
    console.log('  ✓  Solve 완료');
  } else {
    console.log('  ⚠️  Solve 실패 — 리포트만 생성합니다');
  }

  // --- 4. Draft ---
  console.log('\n[4/4] Draft — PR_DRAFT.md 생성');
  await generateDraft(repoDir, selected, solveResult, args.lang);

  console.log('\n' + '━'.repeat(60));
  console.log('  완료. PR_DRAFT.md 를 검수한 뒤 수동으로 push 하세요.');
  console.log('━'.repeat(60));
}

main().catch((err) => {
  console.error(`\n❌ 오류: ${err.message}`);
  process.exit(1);
});
