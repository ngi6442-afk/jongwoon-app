'use strict';
// 엑셀 97-2003 통합문서(.xls) 읽기 — 외부 라이브러리 없이 OLE2(CFB) 컨테이너 + BIFF8 셀 레코드만 푼다(29 판④ 부품 B).
// 근거: [MS-CFB](복합 파일 — 머리 512바이트·FAT·DIFAT·miniFAT·디렉터리) · [MS-XLS](BIFF8 — BOF·BOUNDSHEET·SST(+CONTINUE)·LABELSST·LABEL·NUMBER·RK·MULRK·FORMULA·STRING).
// 원칙
//   - 순수 함수: Buffer → 객체. 저장소·네트워크 없음.
//   - 읽기만 한다 — 서식·수식 식·이름·그림은 버림. 날짜는 엑셀 일련번호(숫자) 그대로 돌려준다(꼴 판단은 틀 쪽에서).
//   - 상한(파일 8MB·셀 20만·시트 20·섹터 사슬 길이)으로 압축 폭탄·순환 사슬을 막는다. 넘으면 { ok:false, code }.
//   - 암호 걸린 통합문서(FILEPASS)는 풀지 않는다(code ENCRYPTED).

const LIM = { bytes: 8 * 1024 * 1024, cells: 200000, sheets: 20, rows: 65536, cols: 256 };
const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function fail(code, why) { return { ok: false, code: code, why: why }; }

// ---------- OLE2 / CFB ----------
// 반환: { ok, streams: { 이름: Buffer } } — 뿌리 바로 아래 스트림만(Workbook/Book 찾기에 충분).
function readCfb(buf) {
  if (!Buffer.isBuffer(buf)) return fail('BAD_INPUT', 'Buffer가 아님');
  if (buf.length > LIM.bytes) return fail('TOO_BIG', '파일이 8MB를 넘음');
  if (buf.length < 512) return fail('NOT_OLE', '파일이 너무 작음');
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return fail('NOT_OLE', 'OLE2 서명이 아님');
  const secShift = buf.readUInt16LE(0x1e);
  const miniShift = buf.readUInt16LE(0x20);
  if (secShift !== 9 && secShift !== 12) return fail('BAD_OLE', '섹터 크기가 이상함');
  if (miniShift !== 6) return fail('BAD_OLE', '작은 섹터 크기가 이상함');
  const secSize = 1 << secShift;
  const miniSize = 1 << miniShift;
  const nFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  const nMiniFat = buf.readUInt32LE(0x40);
  let difatSec = buf.readUInt32LE(0x44);
  const nDifat = buf.readUInt32LE(0x48);
  const nSecs = Math.floor((buf.length - secSize) / secSize) + 1;   // 마지막 조각 섹터도 읽게(일부 프로그램이 꼬리를 자름)
  if (nFat > nSecs || nMiniFat > nSecs || nDifat > nSecs) return fail('BAD_OLE', '머리 수치가 파일보다 큼');

  function secOff(s) { return (s + 1) * secSize; }
  function secBuf(s) {
    const o = secOff(s);
    if (s >= nSecs || o >= buf.length) return null;
    const end = Math.min(o + secSize, buf.length);
    if (end - o === secSize) return buf.subarray(o, end);
    const b = Buffer.alloc(secSize); buf.copy(b, 0, o, end); return b;
  }

  // FAT 섹터 목록(DIFAT): 머리 109칸 + DIFAT 사슬
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s === FREESECT || s === ENDOFCHAIN) break;
    fatSecs.push(s);
  }
  let guard = 0;
  while (fatSecs.length < nFat && difatSec !== ENDOFCHAIN && difatSec !== FREESECT) {
    if (++guard > nSecs) return fail('BAD_OLE', 'DIFAT 사슬 순환');
    const b = secBuf(difatSec);
    if (!b) return fail('BAD_OLE', 'DIFAT 섹터가 파일 밖');
    const per = secSize / 4 - 1;
    for (let i = 0; i < per && fatSecs.length < nFat; i++) {
      const s = b.readUInt32LE(i * 4);
      if (s === FREESECT || s === ENDOFCHAIN) continue;
      fatSecs.push(s);
    }
    difatSec = b.readUInt32LE(per * 4);
  }
  const fat = [];
  for (const s of fatSecs) {
    const b = secBuf(s);
    if (!b) return fail('BAD_OLE', 'FAT 섹터가 파일 밖');
    for (let i = 0; i < secSize; i += 4) fat.push(b.readUInt32LE(i));
  }

  function chain(start, table, limit) {
    const out = [];
    let s = start;
    while (s !== ENDOFCHAIN && s !== FREESECT) {
      if (s >= table.length || out.length > limit) return null;
      out.push(s);
      s = table[s];
    }
    return out;
  }
  function readBig(start, size) {
    const ch = chain(start, fat, nSecs);
    if (!ch) return null;
    const parts = [];
    for (const s of ch) { const b = secBuf(s); if (!b) return null; parts.push(b); }
    const all = Buffer.concat(parts);
    return size == null ? all : (all.length < size ? null : all.subarray(0, size));
  }

  const dirBuf = readBig(dirStart, null);
  if (!dirBuf) return fail('BAD_OLE', '디렉터리 사슬이 깨짐');
  const ents = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nl = dirBuf.readUInt16LE(o + 64);
    const type = dirBuf[o + 66];
    const name = nl >= 2 && nl <= 64 ? dirBuf.toString('utf16le', o, o + nl - 2) : '';
    ents.push({ name: name, type: type, left: dirBuf.readUInt32LE(o + 68), right: dirBuf.readUInt32LE(o + 72), child: dirBuf.readUInt32LE(o + 76), start: dirBuf.readUInt32LE(o + 116), size: dirBuf.readUInt32LE(o + 120) });
  }
  const root = ents[0];
  if (!root || root.type !== 5) return fail('BAD_OLE', '뿌리 항목이 없음');

  let miniFat = null, miniStream = null;
  function loadMini() {
    if (miniFat) return true;
    const mf = nMiniFat ? readBig(miniFatStart, null) : Buffer.alloc(0);
    if (!mf) return false;
    miniFat = [];
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
    miniStream = readBig(root.start, null) || Buffer.alloc(0);
    return true;
  }
  function readMini(start, size) {
    if (!loadMini()) return null;
    const ch = chain(start, miniFat, miniFat.length);
    if (!ch) return null;
    const parts = [];
    for (const s of ch) {
      const o = s * miniSize;
      if (o + miniSize > miniStream.length) return null;
      parts.push(miniStream.subarray(o, o + miniSize));
    }
    const all = Buffer.concat(parts);
    return all.length < size ? null : all.subarray(0, size);
  }

  // 뿌리의 자식 나무(빨강-검정 나무 — 왼·오른 형제를 모두 따라감)
  const streams = Object.create(null);
  const seen = new Set();
  const stack = [root.child];
  while (stack.length) {
    const id = stack.pop();
    if (id === FREESECT || id >= ents.length || seen.has(id)) continue;
    seen.add(id);
    const e = ents[id];
    stack.push(e.left, e.right);
    if (e.type !== 2) continue;
    if (e.size > LIM.bytes) return fail('TOO_BIG', '스트림이 8MB를 넘음');
    const data = e.size < cutoff ? readMini(e.start, e.size) : readBig(e.start, e.size);
    if (!data) return fail('BAD_OLE', '스트림 사슬이 깨짐: ' + e.name.slice(0, 20));
    streams[e.name] = data;
  }
  return { ok: true, streams: streams };
}

// ---------- BIFF8 ----------
function rkValue(rk) {
  let v;
  if (rk & 2) v = rk >> 2;                       // 부호 있는 30비트 정수
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return (rk & 1) ? v / 100 : v;
}

// 레코드 목록: [{ t, d(Buffer) }]
function records(ws) {
  const out = [];
  let o = 0;
  while (o + 4 <= ws.length) {
    const t = ws.readUInt16LE(o), n = ws.readUInt16LE(o + 2);
    if (o + 4 + n > ws.length) break;
    out.push({ t: t, d: ws.subarray(o + 4, o + 4 + n), at: o });
    o += 4 + n;
  }
  return out;
}

// 조각(SST + CONTINUE들) 위를 걷는 읽개. 문자열 글자가 조각 경계를 넘으면 새 조각 첫 바이트가 압축 여부 깃발.
function SegReader(segs) { this.segs = segs; this.i = 0; this.o = 0; }
SegReader.prototype.left = function () { const s = this.segs[this.i]; return s ? s.length - this.o : 0; };
SegReader.prototype.next = function () { this.i++; this.o = 0; return !!this.segs[this.i]; };
SegReader.prototype.ensure = function (n) {   // 숫자 칸은 경계에 걸치지 않는다(MS-XLS) — 비면 다음 조각으로
  while (this.left() === 0) if (!this.next()) return false;
  return this.left() >= n;
};
SegReader.prototype.u8 = function () { if (!this.ensure(1)) throw new Error('SST'); return this.segs[this.i][this.o++]; };
SegReader.prototype.u16 = function () { if (!this.ensure(2)) throw new Error('SST'); const v = this.segs[this.i].readUInt16LE(this.o); this.o += 2; return v; };
SegReader.prototype.u32 = function () { if (!this.ensure(4)) throw new Error('SST'); const v = this.segs[this.i].readUInt32LE(this.o); this.o += 4; return v; };
SegReader.prototype.skip = function (n) {
  while (n > 0) {
    if (this.left() === 0 && !this.next()) throw new Error('SST');
    const k = Math.min(n, this.left()); this.o += k; n -= k;
  }
};
SegReader.prototype.chars = function (cch, high) {
  let s = '';
  while (cch > 0) {
    if (this.left() === 0) {
      if (!this.next()) throw new Error('SST');
      high = this.segs[this.i][this.o++] & 1;      // CONTINUE 첫 바이트 = 남은 글자 깃발
      continue;
    }
    const seg = this.segs[this.i];
    const per = high ? 2 : 1;
    const k = Math.min(cch, Math.floor(this.left() / per));
    if (k === 0) throw new Error('SST');
    s += high ? seg.toString('utf16le', this.o, this.o + k * 2) : seg.toString('latin1', this.o, this.o + k);
    this.o += k * per; cch -= k;
  }
  return s;
};

function readSst(segs) {
  const r = new SegReader(segs);
  r.u32();
  const unique = r.u32();
  const out = [];
  const max = Math.min(unique, LIM.cells * 2);
  for (let k = 0; k < max; k++) {
    if (r.left() === 0 && !r.segs[r.i + 1]) break;
    const cch = r.u16();
    const fl = r.u8();
    const rich = fl & 8 ? r.u16() : 0;
    const ext = fl & 4 ? r.u32() : 0;
    out.push(r.chars(cch, fl & 1));
    r.skip(rich * 4 + ext);
  }
  return out;
}

// 레코드 안 XLUnicodeString(cch 16비트) / ShortXLUnicodeString(cch 8비트)
function xlStr(d, o, short) {
  const cch = short ? d[o] : d.readUInt16LE(o);
  o += short ? 1 : 2;
  const fl = d[o++];
  if (fl & 1) return d.toString('utf16le', o, Math.min(d.length, o + cch * 2));
  return d.toString('latin1', o, Math.min(d.length, o + cch));
}

// readXls(buf) → { ok:true, sheets:[{ name, cells }] } | { ok:false, code, why }
// cells[r][c] = 문자열|숫자, 빈 칸 ''. 행마다 길이가 다를 수 있다(그 행 마지막 칸까지).
function readXls(buf) {
  const cfb = readCfb(buf);
  if (!cfb.ok) return cfb;
  const ws = cfb.streams.Workbook || cfb.streams.Book;
  if (!ws) return fail('NO_WORKBOOK', 'Workbook 스트림이 없음(xls가 아님)');
  const recs = records(ws);
  if (!recs.length || recs[0].t !== 0x0809) return fail('NOT_BIFF8', 'BIFF8 BOF가 아님');
  if (recs[0].d.readUInt16LE(0) !== 0x0600) return fail('NOT_BIFF8', 'BIFF8(엑셀 97 이후)이 아님');

  // 1) 통합문서 전역: 시트 목록·SST
  const sheetsMeta = [];
  let sst = [];
  let i = 1;
  for (; i < recs.length; i++) {
    const r = recs[i];
    if (r.t === 0x000a) break;                                 // EOF
    if (r.t === 0x002f) return fail('ENCRYPTED', '암호 걸린 통합문서');
    if (r.t === 0x0085) {                                      // BOUNDSHEET
      if (r.d[5] === 0) {                                      // 일반 워크시트만(차트·매크로 시트 제외)
        if (sheetsMeta.length >= LIM.sheets) return fail('TOO_MANY_SHEETS', '시트가 20개를 넘음');
        sheetsMeta.push({ pos: r.d.readUInt32LE(0), name: xlStr(r.d, 6, true) });
      }
    } else if (r.t === 0x00fc) {                               // SST + 뒤따르는 CONTINUE
      const segs = [r.d];
      let j = i + 1;
      while (j < recs.length && recs[j].t === 0x003c) { segs.push(recs[j].d); j++; }
      try { sst = readSst(segs); } catch (e) { return fail('BAD_SST', '공유 문자열 표가 깨짐'); }
      i = j - 1;
    }
  }

  const byPos = new Map();
  recs.forEach(function (r, k) { byPos.set(r.at, k); });
  let cellCount = 0;
  const sheets = [];
  for (const m of sheetsMeta) {
    let k = byPos.get(m.pos);
    if (k == null || recs[k].t !== 0x0809) return fail('BAD_SHEET', '시트 위치가 맞지 않음');
    const rows = [];
    function put(row, col, v) {
      if (row >= LIM.rows || col >= LIM.cols) return true;
      if (++cellCount > LIM.cells) return false;
      let a = rows[row];
      if (!a) { for (let z = rows.length; z <= row; z++) if (!rows[z]) rows[z] = []; a = rows[row]; }
      while (a.length < col) a.push('');
      a[col] = v;
      return true;
    }
    let pendStr = null;                                        // FORMULA 문자열 결과 → 바로 뒤 STRING
    for (k = k + 1; k < recs.length; k++) {
      const r = recs[k], d = r.t, b = r.d;
      if (d === 0x000a) break;
      let ok = true;
      if (d === 0x00fd && b.length >= 10) {                    // LABELSST
        const s = sst[b.readUInt32LE(6)];
        ok = put(b.readUInt16LE(0), b.readUInt16LE(2), s == null ? '' : s);
      } else if (d === 0x0204 && b.length >= 9) {              // LABEL
        ok = put(b.readUInt16LE(0), b.readUInt16LE(2), xlStr(b, 6, false));
      } else if (d === 0x0203 && b.length >= 14) {             // NUMBER
        ok = put(b.readUInt16LE(0), b.readUInt16LE(2), b.readDoubleLE(6));
      } else if (d === 0x027e && b.length >= 10) {             // RK
        ok = put(b.readUInt16LE(0), b.readUInt16LE(2), rkValue(b.readUInt32LE(6)));
      } else if (d === 0x00bd && b.length >= 6) {              // MULRK
        const row = b.readUInt16LE(0); let col = b.readUInt16LE(2);
        for (let o = 4; o + 6 <= b.length - 2 && ok; o += 6) ok = put(row, col++, rkValue(b.readUInt32LE(o + 2)));
      } else if (d === 0x0006 && b.length >= 14) {             // FORMULA — 결과만
        const row = b.readUInt16LE(0), col = b.readUInt16LE(2);
        if (b.readUInt16LE(12) === 0xffff) {
          if (b[6] === 0) pendStr = { row: row, col: col };    // 문자열 결과는 다음 STRING 레코드
          else if (b[6] === 1) ok = put(row, col, b[8] ? 1 : 0);
        } else ok = put(row, col, b.readDoubleLE(6));
      } else if (d === 0x0207 && pendStr && b.length >= 3) {   // STRING
        ok = put(pendStr.row, pendStr.col, xlStr(b, 0, false));
        pendStr = null;
      }
      if (!ok) return fail('TOO_MANY_CELLS', '셀이 20만 개를 넘음');
    }
    sheets.push({ name: m.name, cells: rows });
  }
  return { ok: true, sheets: sheets };
}

module.exports = { readXls: readXls, readCfb: readCfb, rkValue: rkValue, readSst: readSst, LIM: LIM };
