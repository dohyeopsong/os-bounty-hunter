import { config } from './config.js';

const API = 'https://api.github.com';

function authHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'os-bounty-hunter',
  };
  if (config.githubToken) {
    h.Authorization = `Bearer ${config.githubToken}`;
  }
  return h;
}

/**
 * GitHub Search API 로 good first issue 목록을 가져온다.
 * Search API 의 body 는 잘리므로 여기서는 title/number/html_url/repository_url 만 사용.
 */
export async function searchIssues(language) {
  // GitHub Search 쿼리: 항목 사이는 공백(→ %20). + 를 쓰면 %2B(리터럴)로 인코딩되어 실패.
  const q = `language:"${language}" label:"good first issue" state:open no:assignee`;
  const url = `${API}/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${config.perPage}`;

  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `GitHub API rate limit (403). GITHUB_TOKEN 환경변수를 설정하세요.\n${body.message || ''}`
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub Search 실패: HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.items || []).map(parseListItem);
}

function parseListItem(item) {
  // repository_url: https://api.github.com/repos/{owner}/{repo}
  const match = (item.repository_url || '').match(/repos\/([^/]+)\/([^/]+)$/);
  const owner = match ? match[1] : '';
  const repo = match ? match[2] : '';
  return {
    number: item.number,
    title: item.title,
    htmlUrl: item.html_url,
    owner,
    repo,
    updatedAt: item.updated_at,
  };
}

/**
 * 목록을 터미널에 출력한다.
 */
export function printIssueList(issues, language) {
  console.log(`\n🔍 ${language} · good first issue (${issues.length}개, 최근 업데이트순)\n`);
  if (issues.length === 0) {
    console.log('  검색 결과가 없습니다. 다른 언어로 시도해 보세요 (--lang Python).');
    return;
  }
  issues.forEach((it, i) => {
    const idx = String(i + 1).padStart(2, ' ');
    console.log(`  ${idx}. ${it.owner}/${it.repo} #${it.number}`);
    console.log(`      ${it.title}`);
    console.log(`      ${it.htmlUrl}\n`);
  });
}

/**
 * 선택된 이슈의 전체 본문 + 댓글을 로드한다.
 * 댓글에 종종 수정 방향이 명시된다.
 */
export async function fetchIssueContext(issue) {
  const { owner, repo, number } = issue;

  const [issueRes, commentsRes] = await Promise.all([
    fetch(`${API}/repos/${owner}/${repo}/issues/${number}`, { headers: authHeaders() }),
    fetch(`${API}/repos/${owner}/${repo}/issues/${number}/comments`, { headers: authHeaders() }),
  ]);

  if (!issueRes.ok) {
    throw new Error(`이슈 본문 로드 실패: HTTP ${issueRes.status}`);
  }
  const issueData = await issueRes.json();

  const comments = commentsRes.ok ? await commentsRes.json() : [];
  const commentTexts = (comments || [])
    .map((c) => `--- 댓글 by ${c.user?.login || '?'} ---\n${c.body || ''}`)
    .join('\n\n');

  return {
    ...issue,
    body: issueData.body || '(본문 없음)',
    comments: commentTexts || '(댓글 없음)',
  };
}
