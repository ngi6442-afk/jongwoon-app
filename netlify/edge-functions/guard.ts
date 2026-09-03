// 정적 노출 가드(Edge Function, 2026-09-03) — publish="."라 레포 파일이 전부 정적으로 열리고,
// Netlify 정적 서빙은 대소문자·중복 슬래시를 무시하므로 netlify.toml의 `/netlify/*` 재작성만으로는
// `/NETLIFY/...` 같은 변형을 못 막는다(9/3 실측 200). 엣지는 재작성·정적 서빙보다 먼저 돌므로
// 여기서 경로를 정규화(퍼센트 디코드·소문자·슬래시 정리)한 뒤 내부 파일 경로를 404로 끊는다.
// 차단: /netlify/* (함수 소스·_lib 데이터) · /tools/* (회귀 스크립트) · *.md (운영 문서) · package*.json
// 통과: 그 외 전부(index.html·sw.js·manifest·아이콘·/w/ 벽지·위젯·/data/duties_seed.json·/.netlify/functions/*).
// 어떤 예외가 나도 요청을 막지 않는다(try/catch → next) — 가드 오류로 앱이 죽는 일은 없게.
export default async (request: Request, context: { next: () => Promise<Response> }) => {
  try {
    const url = new URL(request.url);
    let p = url.pathname;
    try { p = decodeURIComponent(p); } catch (_) { /* 잘못된 인코딩은 원문으로 판정 */ }
    p = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/\.\//g, '/').toLowerCase();
    const blocked =
      p.startsWith('/netlify/') ||
      p.startsWith('/tools/') ||
      p === '/package.json' || p === '/package-lock.json' ||
      /\.md$/.test(p);
    if (blocked) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  } catch (_) { /* 가드 실패는 통과 */ }
  return context.next();
};
