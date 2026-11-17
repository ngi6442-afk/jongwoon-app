'use strict';
// 29 판⑦ 메일 에이전트 IMAP 붙이기 — 워커(gw-stmtmail-run-background)만 부른다(imapflow를 다른 함수 묶음에 끌어들이지 않게 stmtmail.js와 나눔).
const { attParts, h, READ_MAX } = require('./stmtmail');

// IMAP 붙이기 — { list(since) → [{uid, key, at, from:{addr,name}, subject, atts}], get(uid, part) → Buffer, close() }
async function openImap(env) {
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({ host: env.host, port: env.port, secure: true, auth: { user: env.user, pass: env.pass }, logger: false, socketTimeout: 120000, connectionTimeout: 30000, greetingTimeout: 20000 });
  await c.connect();
  await c.mailboxOpen('INBOX', { readOnly: true });   // EXAMINE — 읽음 표시 등 아무 표시도 바꾸지 않음
  return {
    async list(since) {
      const out = [];
      for await (const m of c.fetch({ since: since }, { uid: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true })) {
        const atts = attParts(m.bodyStructure);
        if (!atts.length) continue;
        const env0 = m.envelope || {}, f = (env0.from && env0.from[0]) || {};
        out.push({ uid: m.uid, key: h(env0.messageId || ('uid:' + m.uid + ':' + (m.internalDate ? new Date(m.internalDate).getTime() : 0)), 16), at: m.internalDate ? new Date(m.internalDate).getTime() : Date.now(), from: { addr: String(f.address || ''), name: String(f.name || '') }, subject: String(env0.subject || ''), atts: atts });
      }
      return out;
    },
    async get(uid, part) {
      const d = await c.download(String(uid), part, { uid: true, maxBytes: READ_MAX + 1 });
      const bufs = []; let n = 0;
      for await (const ch of d.content) { bufs.push(ch); n += ch.length; if (n > READ_MAX) break; }
      return Buffer.concat(bufs);
    },
    async close() { try { await c.logout(); } catch (e) { try { c.close(); } catch (e2) {} } },
  };
}

module.exports = { openImap };
