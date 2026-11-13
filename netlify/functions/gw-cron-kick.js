'use strict';

// 크론 백업 킥 진입점(2026-09-03) — Netlify 스케줄 함수는 외부 HTTP 호출로는 실행되지 않아
// (9/3 백업 발사 1차 실패로 실측) 일반 함수 진입점을 따로 판다. 호출자 = GitHub Actions 백업층
// (jongwoon-appdata collectors/cron_backup.py, KST 08:20 — 오늘 잡 블롭이 없을 때만 호출).
// 인증 = BIDS_INGEST_KEY(수집봇 공유 시크릿 — gw-data ingest 통로와 동일 규약).
// 중복 안전: 크론 모듈 자체의 잠금(올바로 LOCK)·멱등(화관법 filed_keys·잡 키 덮어쓰기)이 방어한다.
// v456(원장 C108): 키 비교는 상수시간(_lib/keymatch botKeyOk — gw-data botKeyOk와 같은 규칙, 종전 '!==').
const { botKeyOk } = require('./_lib/keymatch');
exports.handler = async function (event, context) {
  let d = {};
  try { d = JSON.parse(event.body || '{}'); } catch (e) {}
  if (!botKeyOk(d.key))
    return { statusCode: 403, body: JSON.stringify({ ok: false, code: 'BAD_INGEST_KEY' }) };
  const target = String(d.target || '');
  if (target !== 'allbaro' && target !== 'hwakwan' && target !== 'brief')
    return { statusCode: 400, body: JSON.stringify({ ok: false, code: 'BAD_TARGET' }) };
  // 크론 모듈의 handler를 그대로 실행 — event를 통째로 넘겨 blobs 컨텍스트(잠금 확인)도 스케줄 실행과 동일하게
  // v416 brief = 아침 음성 브리핑 06:30 크론(오늘 생성본이 있으면 무동작 — 멱등)
  const mod = require(target === 'hwakwan' ? './gw-hwakwan-cron' : target === 'brief' ? './gw-brief-cron' : './gw-allbaro-cron');
  return mod.handler(event, context);
};
