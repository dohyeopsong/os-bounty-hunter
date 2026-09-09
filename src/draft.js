import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDiff, commitChanges, stageChanges } from './git.js';

/**
 * Solve 결과 텍스트에서 헤더 섹션을 파싱한다.
 * 헤더: ## Summary / ## Changes / ## Test Results / ## PR Description
 */
function parseSections(text) {
  const sections = { Summary: '', Changes: '', 'Test Results': '', 'PR Description': '' };
  if (!text) return sections;

  // 헤더 기준 분할
  const parts = text.split(/^## /m);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const header = part.slice(0, nl).trim();
    const body = part.slice(nl + 1).trim();
    // 대소문자/유사 헤더 매칭
    const key = Object.keys(sections).find(
      (k) => k.toLowerCase() === header.toLowerCase()
    );
    if (key) sections[key] = body;
  }

  // 파싱 실패 시 전체를 Summary 에
  if (!sections.Summary && !sections.Changes && !sections['PR Description']) {
    sections.Summary = text.trim();
  }
  return sections;
}

/**
 * PR_DRAFT.md 를 레포 최상단에 생성한다.
 * Solve 가 실패해도 실패 원인과 함께 생성 (끝까지 리포트 보장).
 */
export async function generateDraft(repoDir, issue, solveResult, language) {
  // 1) 의도한 변경사항을 먼저 스테이징 (노이즈 제외).
  //    이렇게 해야 아래 getDiff() 가 --cached 기반으로 신규 파일까지 잡는다.
  stageChanges(repoDir);
  const { stat, full } = getDiff(repoDir);
  const sections = parseSections(solveResult.result);

  let md = `# PR Draft — ${issue.owner}/${issue.repo} #${issue.number}\n\n`;
  md += `**이슈**: ${issue.htmlUrl}\n`;
  md += `**언어**: ${language}\n`;
  md += `**브랜치**: fix-issue-${issue.number}\n`;
  md += `**Solve 상태**: ${solveResult.ok ? '성공' : '실패'}\n\n---\n\n`;

  if (!solveResult.ok) {
    md += `> ⚠️ Solve 단계 실패 — 아래 원인을 확인하세요.\n\n`;
    md += `**실패 원인**:\n\`\`\`\n${solveResult.error || '알 수 없음'}\n\`\`\`\n\n`;
    // 부분 결과라도 있으면 표시
    if (solveResult.result) {
      md += `**부분 출력**:\n${solveResult.result}\n\n---\n\n`;
    }
  }

  md += `## Summary\n${sections.Summary || '(작성되지 않음)'}\n\n`;

  md += `## Changes\n${sections.Changes || '(작성되지 않음)'}\n\n`;
  md += `### 실제 diff (객관적 기록)\n\n`;
  md += `**diff --stat**:\n\`\`\`\n${stat || '(변경사항 없음)'}\n\`\`\`\n\n`;
  if (full) {
    md += `**full diff**:\n\`\`\`diff\n${truncate(full, 8000)}\n\`\`\`\n\n`;
  }

  md += `## Test Results\n${sections['Test Results'] || 'N/A'}\n\n`;

  md += `## PR Description (English)\n${sections['PR Description'] || '(작성되지 않음)'}\n\n`;

  md += `---\n`;
  md += `_이 초안은 os-bounty-hunter 가 자동 생성했습니다. 제출 전 반드시 검수하세요._\n`;
  md += `_push 와 PR 생성은 수동으로: \`git push -u origin fix-issue-${issue.number}\`\n`;

  const draftPath = join(repoDir, 'PR_DRAFT.md');
  await writeFile(draftPath, md, 'utf8');
  console.log(`  📄  PR_DRAFT.md 생성: ${draftPath}`);

  // 로컬 커밋 (push 금지)
  commitChanges(repoDir, issue);

  console.log(`\n✅ 완료. 검수 후 직접 push 하세요:`);
  console.log(`   cd ${repoDir}`);
  console.log(`   cat PR_DRAFT.md   # 검토`);
  console.log(`   git push -u origin fix-issue-${issue.number}`);

  return draftPath;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (총 ${s.length}자, ${max}자까지만 표시)`;
}
