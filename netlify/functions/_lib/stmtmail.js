'use strict';
// 29 판⑦ 메일 에이전트(PM 11/17 'A안 ㄱ' — 브리핑 09_조사_문서/29_명세표정리_자료_20261110/메일에이전트_브리핑_20261117.md).
// 회사 메일함을 IMAP으로 '읽기 전용'(EXAMINE · BODY.PEEK)으로 열어 거래처가 보낸 계산서·명세서 첨부를 월 목록 '한꺼번에 넣기'와 같은 자리(gw_data stmtdrop:<ym>:<id> ·
// gw_files stmtfile:<id>)에 넣는다. 메일을 보내거나 지우거나 읽음 표시를 바꾸지 않는다. 본문은 받지 않는다(첨부만).
// 계정 = 환경변수 STMT_MAIL_USER·STMT_MAIL_PASS(앱 비밀번호 — PM이 Netlify에 직접 넣음, 코드·로그·저장에 값이 남지 않음) · STMT_MAIL_HOST(기본 imap.daum.net)·STMT_MAIL_PORT(993).
// 거래처 찾기 순서: ① 첨부 이름·내용(판⑥ guessVendor — 보안 계산서는 여러 거래처가 같은 대행 주소로 보내므로 내용이 먼저) ② 사람이 한 번 고른 보낸 사람(주소는 해시만 — stmt:mail:senders)
//   ③ 보낸 사람 표시 이름·제목에 거래처 이름 ④ 못 찾았지만 명세·계산서로 보이는 첨부 = '거래처 고르기'로 올림 ⑤ 그 밖 = 아무것도 저장 안 함.
// 저장(gw_data): stmt:mail:last 마지막 실행 요약(숫자·코드만) · stmt:mail:seen 처리한 첨부 표시(메시지 id 해시+파트 — 지운 원본이 다시 들어오지 않게) · stmt:mail:senders 보낸 사람 해시 → 거래처.
// 메일 주소·이름·제목은 저장하지 않는다 — 목록 줄에는 보낸 쪽 도메인만(mail.dom).
const crypto = require('crypto');
const RD = require('./stmtread');

const START_DAY = '2026-11-20';   // 11월분부터(PM 11/14 '11월부터는 메일로') — 10월분은 손으로 이미 넣음(같은 파일이라도 묶음 PDF라 sha가 달라 겹침)
const WINDOW_DAYS = 40;            // 매일 돌며 볼 기간
const READ_MAX = 4300000;          // gw-stmt READ_MAX와 같음
const DROP_MAX = 60;               // gw-stmt DROP_MAX와 같음
const SEEN_MAX = 4000;
const EXT = /\.(pdf|xls|xlsx|html?|xml|jpe?g|png)$/i;
const STMT_WORD = /명세|계산서|거래|청구|세금|정산|대금|원장|내역|월분|tax|invoice|statement|NTS_/i;
const BOT = '__stmtmail__';
const SENDERS = 'stmt:mail:senders', SEEN = 'stmt:mail:seen', LAST = 'stmt:mail:last';

function h(s, n) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n || 20); }
function senderHash(addr) { return h('stmtmail:' + String(addr || '').trim().toLowerCase(), 20); }
function domOf(addr) { const m = /@([A-Za-z0-9.\-]+)$/.exec(String(addr || '').trim()); return m ? m[1].toLowerCase().slice(0, 40) : ''; }
function kstDay(d) { return new Date(new Date(d).getTime() + 9 * 3600000).toISOString().slice(0, 10); }
// 귀속 월 — 20일 이후 받은 메일은 그 달, 19일까지는 앞달(월말 명세는 말일 전후~다음 달 초에 옴)
function ymOf(d) {
  const day = kstDay(d), y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)), dd = Number(day.slice(8, 10));
  if (dd >= 20) return day.slice(0, 7);
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
}
// bodyStructure에서 첨부 파트 — 파일 이름이 있고 확장자가 받는 꼴인 것만
function attParts(bs) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.childNodes) && n.childNodes.length) { n.childNodes.forEach(walk); return; }
    const dp = n.dispositionParameters || {}, p = n.parameters || {};
    const name = String(dp.filename || p.name || '').split(/[\\/]/).pop().slice(0, 160);
    if (!name || !EXT.test(name) || !n.part) return;
    const est = Number(n.size) || 0;   // 전송 부호화 크기(base64면 원본의 4/3)
    out.push({ part: String(n.part), name: name, est: /base64/i.test(String(n.encoding || '')) ? Math.floor(est * 3 / 4) : est });
  })(bs);
  return out;
}
function looksStmt(s) { return STMT_WORD.test(String(s || '')); }

function mailEnv(pe) {
  const e = pe || process.env;
  const user = String(e.STMT_MAIL_USER || '').trim(), pass = String(e.STMT_MAIL_PASS || '');
  if (!user || !pass) return null;
  return { user: user, pass: pass, host: String(e.STMT_MAIL_HOST || 'imap.daum.net').trim(), port: Number(e.STMT_MAIL_PORT) || 993 };
}
function errCode(e) {
  const s = String((e && (e.responseText || e.message)) || e || '');
  if (e && (e.authenticationFailed || /AUTHENTICATIONFAILED|authenticat|LOGIN failed|invalid credentials/i.test(s))) return 'MAIL_LOGIN_FAILED';
  if (e && /ENOTFOUND|EAI_AGAIN/.test(String(e.code || s))) return 'MAIL_HOST_NOT_FOUND';
  if (e && /ETIMEDOUT|timeout/i.test(String(e.code || s))) return 'MAIL_TIMEOUT';
  if (/ECONNREFUSED|ECONNRESET/.test(String((e && e.code) || s))) return 'MAIL_CONNECT_FAILED';
  return 'MAIL_FAILED';
}

// 한 번 돌기 — io: { st(gw_data), fst(gw_files), blobGet, blobSet, blobList, blobDelete, mailbox, cfg(vendors), names(), audit(op,id,t), usage(ym,res), now(), budget }
async function run(io) {
  const t0 = io.now(), sum = { at: t0, ok: true, code: '', msgs: 0, atts: 0, added: 0, read: 0, ai: 0, nov: 0, fail: 0, dup: 0, skip: 0, left: 0, full: 0 };
  const g = async function (k, dflt) { const r = await io.blobGet(io.st, k); return (r.ok && r.data && typeof r.data === 'object') ? r.data : dflt; };
  const seenDoc = await g(SEEN, { keys: [] }), seen = new Set(Array.isArray(seenDoc.keys) ? seenDoc.keys : []), seenAdd = [];
  const senders = await g(SENDERS, { map: {} }), smap = (senders.map && typeof senders.map === 'object') ? senders.map : {};
  const act = (io.cfg || []).filter(function (v) { return v && v.active !== false; });
  const byVk = {}; (io.cfg || []).forEach(function (v) { byVk[v.vk] = v; });
  const lists = {};
  async function dropList(ym) {
    if (lists[ym]) return lists[ym];
    const l = await io.blobList(io.st, 'stmtdrop:' + ym + ':');
    const keys = ((l.ok && l.keys) || []).filter(function (k) { return String(k).indexOf('stmtdrop:' + ym + ':') === 0; });
    const arr = [];
    for (const k of keys) { const r = await io.blobGet(io.st, k); if (r.ok && r.data && r.data.id) arr.push(r.data); }
    lists[ym] = arr; return arr;
  }
  let names = null;
  const since = new Date(Math.max(Date.parse(START_DAY + 'T00:00:00+09:00'), t0 - WINDOW_DAYS * 86400000));
  let msgs;
  try { msgs = await io.mailbox.list(since); } catch (e) { sum.ok = false; sum.code = errCode(e); return sum; }
  msgs.sort(function (a, b) { return a.at - b.at; });
  outer:
  for (const m of msgs) {
    if (m.at < since.getTime()) continue;
    sum.msgs++;
    for (const a of m.atts) {
      const sk = m.key + ':' + a.part;
      if (seen.has(sk)) continue;
      if (io.now() - t0 > io.budget.total) { sum.left++; continue outer; }
      sum.atts++;
      if (a.est > READ_MAX * 1.05) { sum.skip++; seen.add(sk); seenAdd.push(sk); continue; }
      let buf;
      try { buf = await io.mailbox.get(m.uid, a.part); } catch (e) { sum.fail++; continue; }   // 표시 안 함 — 다음 날 다시
      if (!buf.length || buf.length > READ_MAX) { sum.skip++; seen.add(sk); seenAdd.push(sk); continue; }
      const ym = ymOf(m.at), list = await dropList(ym);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (list.some(function (x) { return x.sha === sha; })) { sum.dup++; seen.add(sk); seenAdd.push(sk); continue; }
      if (list.length >= DROP_MAX) { sum.full++; continue; }
      const fh = senderHash(m.from.addr);
      let v = null, how = '';
      const gv = await RD.guessVendor(buf, a.name, io.cfg, ym);
      if (gv && byVk[gv.vk]) { v = byVk[gv.vk]; how = gv.how; }
      if (!v && smap[fh] && smap[fh].vk && byVk[smap[fh].vk] && byVk[smap[fh].vk].active !== false) { v = byVk[smap[fh].vk]; how = 'mail'; }
      if (!v) { const mv = RD.matchVendor(m.from.name + ' ' + m.subject, act, 2); if (mv) { v = mv; how = 'mail'; } }
      if (!v && !looksStmt(a.name + ' ' + m.subject)) { sum.skip++; seen.add(sk); seenAdd.push(sk); continue; }   // 명세·계산서로 안 보임 — 저장 안 함
      const id = crypto.randomBytes(12).toString('hex');
      const kind = RD.sniff(buf, a.name) || 'etc';
      const name = String(a.name).replace(/\d[\d .\-·_]{7,}\d/g, function (x) { return x.replace(/\D/g, '').length >= 9 ? '…' : x; }).replace(/[\u0000-\u001f]/g, '').slice(0, 120) || '이름 없는 파일';
      let e = { id: id, ym: ym, name: name, size: buf.length, kind: kind, sha: sha, vk: '', how: '', state: 'novendor', by: BOT, at: io.now(), mail: { at: m.at, dom: domOf(m.from.addr), fh: fh } };
      const w0 = await io.blobSet(io.st, 'stmtdrop:' + ym + ':' + id, e);
      if (!w0.ok) { sum.fail++; continue; }
      const fw = await io.blobSet(io.fst, 'stmtfile:' + id, { ym: ym, name: name, size: buf.length, kind: kind, by: BOT, at: io.now(), data: buf.toString('base64') });
      if (!fw.ok) { await io.blobDelete(io.st, 'stmtdrop:' + ym + ':' + id); sum.fail++; continue; }
      list.push(e); sum.added++;
      if (v) {
        e.vk = v.vk; e.how = how;
        const ctx = { ym: ym, vk: v.vk, vendor: { name: v.name, kind: v.kind, group: v.group, hint: v.hint } };
        let r;
        try { r = await RD.readFile(buf, name, ctx); } catch (x) { r = { ok: false, code: 'READ_FAILED' }; }
        if (!r.ok) { e.state = 'fail'; e.code = r.code || 'READ_FAILED'; sum.fail++; }
        else if (!r.ai) { e.state = 'read'; e.result = r.result; e.n = r.result.rows.length; e.src = r.result.src || ''; e.warn = (r.result.warn || []).length; sum.read++; }
        else if (io.now() - t0 < io.budget.ai) {
          if (!names) names = await io.names();
          let out;
          try { out = await RD.readByAi(buf, r.ai, Object.assign({}, ctx, { names: names })); } catch (x) { out = { ok: false, code: 'READ_FAILED' }; }
          await io.usage(ym, out);
          if (out.ok) { e.state = 'read'; e.result = out.result; e.n = out.result.rows.length; e.src = 'vision'; e.warn = (out.result.warn || []).length; sum.read++; sum.ai++; }
          else { e.state = 'fail'; e.code = out.code || 'READ_FAILED'; sum.fail++; }
        } else {
          // 시간이 모자람 — 판⑥과 같은 배경 판독 맡김(앱이 목록을 열면 부름 · 맡긴 사람 = 메일 봇이라 수행 권한이면 누구나 부를 수 있음)
          const job = crypto.randomBytes(12).toString('hex');
          const jw = await io.blobSet(io.fst, 'stmtsrc:' + job, { bid: BOT, ym: ym, vk: v.vk, mode: r.ai, vendor: ctx.vendor, at: io.now(), file: 'stmtfile:' + id, drop: { ym: ym, id: id } });
          if (jw.ok) { e.state = 'reading'; e.job = job; e.at_read = io.now(); e.src = 'vision'; } else { e.state = 'fail'; e.code = 'STORAGE_WRITE_FAILED'; sum.fail++; }
        }
      } else sum.nov++;
      await io.blobSet(io.st, 'stmtdrop:' + ym + ':' + id, e);
      seen.add(sk); seenAdd.push(sk);
      await io.audit('명세서원본', ym + ':' + (e.vk || '?'), '메일 ' + kind + ' ' + e.state + (e.n ? ' ' + e.n + '줄' : ''));
    }
  }
  if (seenAdd.length) {
    const keys = (Array.isArray(seenDoc.keys) ? seenDoc.keys : []).concat(seenAdd).slice(-SEEN_MAX);
    await io.blobSet(io.st, SEEN, { keys: keys, at: io.now() });
  }
  return sum;
}
// 사람이 메일로 온 첨부의 거래처를 고르면 보낸 사람(해시)을 그 거래처로 — 다른 거래처로 고른 적이 있으면 '여럿'(빈 값)으로 두어 다시는 보낸 사람으로 정하지 않음
function learnSender(doc, fh, vk) {
  const d = (doc && typeof doc === 'object') ? doc : {}, map = (d.map && typeof d.map === 'object') ? d.map : {};
  const cur = map[fh];
  if (!cur) map[fh] = { vk: vk, n: 1 };
  else if (cur.vk === vk) cur.n = (Number(cur.n) || 0) + 1;
  else map[fh] = { vk: '', n: (Number(cur.n) || 0) + 1, multi: 1 };
  const keys = Object.keys(map);
  if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete map[k]; });
  return { map: map, at: Date.now() };
}

module.exports = { run, mailEnv, h, READ_MAX, attParts, ymOf, looksStmt, senderHash, domOf, learnSender, errCode, BOT, START_DAY, SENDERS, SEEN, LAST };
