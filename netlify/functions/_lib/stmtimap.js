'use strict';
// 29 판⑦ 메일 에이전트 IMAP 붙이기 — 워커(gw-stmtmail-run-background)만 부른다(imapflow를 다른 함수 묶음에 끌어들이지 않게 stmtmail.js와 나눔).
// 29 판⑨(11/20 실측): 회사 메일함은 분류 규칙으로 거래처 명세가 '청구서함', 국세청 계산서가 '청구서' 폴더로 간다 — 받은편지함만 읽으면 대부분을 놓침 → 폴더 여럿(env STMT_MAIL_BOXES)
const { attParts, bodyPart, h, READ_MAX, mailBoxes } = require('./stmtmail');
const CP = require('./stmtcoupang');

function domOf(addr) { const m = /@([A-Za-z0-9.\-]+)$/.exec(String(addr || '').trim()); return m ? m[1].toLowerCase() : ''; }

// IMAP 붙이기 — { list(since) → [{uid, box, key, at, from:{addr,name}, subject, atts}], get(uid, part, box) → Buffer, boxes, missing, close() }
async function openImap(env) {
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({ host: env.host, port: env.port, secure: true, auth: { user: env.user, pass: env.pass }, logger: false, socketTimeout: 120000, connectionTimeout: 30000, greetingTimeout: 20000 });
  await c.connect();
  const want = mailBoxes(env.boxes);
  const have = {};
  try { (await c.list()).forEach(function (b) { if (!(b.flags && b.flags.has('\\Noselect'))) have[b.path] = 1; }); } catch (e) { have.INBOX = 1; }
  const boxes = want.filter(function (b) { return have[b]; }), missing = want.filter(function (b) { return !have[b]; });
  let cur = '';
  async function open(box) { if (cur === box) return; await c.mailboxOpen(box, { readOnly: true }); cur = box; }   // EXAMINE — 읽음 표시 등 아무 표시도 바꾸지 않음
  return {
    boxes: boxes, missing: missing,
    async list(since) {
      const out = [];
      for (const box of boxes) {
        await open(box);
        for await (const m of c.fetch({ since: since }, { uid: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true })) {
          const env0 = m.envelope || {}, f = (env0.from && env0.from[0]) || {};
          const at = m.internalDate ? new Date(m.internalDate).getTime() : Date.now();
          const subject = String(env0.subject || ''), addr = String(f.address || '');
          let atts = attParts(m.bodyStructure);
          if (!atts.length && CP.isOrderMail(domOf(addr), subject)) {   // 첨부 없는 쿠팡 주문 메일 — 본문 HTML 파트를 '첨부'처럼
            const bp = bodyPart(m.bodyStructure);
            if (bp) atts = [{ part: bp.part, name: '쿠팡 주문 ' + new Date(at + 9 * 3600000).toISOString().slice(0, 10) + '.html', est: bp.est, body: 'coupang' }];
          }
          if (!atts.length) continue;
          out.push({ uid: m.uid, box: box, key: h(env0.messageId || (box + ':uid:' + m.uid + ':' + at), 16), at: at, from: { addr: addr, name: String(f.name || '') }, subject: subject, atts: atts });
        }
      }
      return out;
    },
    async get(uid, part, box) {
      await open(box || 'INBOX');
      const d = await c.download(String(uid), part, { uid: true, maxBytes: READ_MAX + 1 });
      const bufs = []; let n = 0;
      for await (const ch of d.content) { bufs.push(ch); n += ch.length; if (n > READ_MAX) break; }
      return Buffer.concat(bufs);
    },
    async close() { try { await c.logout(); } catch (e) { try { c.close(); } catch (e2) {} } },
  };
}

module.exports = { openImap };
