# 29 판④ 부품 C 시험 자료 — 오천공구 '거래처 원장 - 전표별'·'거래처 원장 - 상품상세'와 같은 글 배치의 가짜 PDF 2장.
# 값은 전부 가짜(상호 '가짜공구상사'·'(주)가짜환경', 금액 임의). 좌표는 실물 배치(A4 595x841, 왼쪽 위 기준 pt)를 따름.
# 실행: python -I tools/fixtures/stmt29/make_ochun_pdf.py   (PyMuPDF 필요 — 글꼴은 맑은 고딕을 넣고 subset_fonts로 줄임)
import os
import sys

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = r'C:\Windows\Fonts\malgun.ttf'


def new_page(doc):
    pg = doc.new_page(width=595, height=841)
    pg.insert_font(fontname='kr', fontfile=FONT)
    return pg


def put(pg, x, y, s, size=5.5):
    # y = 글 윗부분 기준(덤프 좌표와 같은 자리) → 기준선은 글 크기만큼 아래
    pg.insert_text((x, y + size), s, fontname='kr', fontsize=size)


def right(pg, xr, y, s, size=5.5):
    # 오른쪽 맞춤 숫자 — 오른쪽 끝 xr
    w = fitz.get_text_length(s, fontname='helv', fontsize=size)  # 숫자·쉼표 폭 근사
    put(pg, xr - w, y, s, size)


def head_common(pg, title):
    put(pg, 14, 40, '매장 : 가짜공구상사', 6)
    put(pg, 240, 32, title, 8)
    put(pg, 216, 46, '전표일자 : 2026-10-01 ~ 2026-10-31', 6)
    put(pg, 488, 40, '거래처 : (주)가짜환경', 6)


def foot(pg):
    put(pg, 14, 821, '<가짜>', 6)
    put(pg, 286, 821, '1', 6)
    put(pg, 294, 821, '/', 6)
    put(pg, 301, 821, '1', 6)
    put(pg, 481, 821, '2026-11-12', 6)
    put(pg, 533, 821, '오후 01:35', 6)


def ledger(path):
    doc = fitz.open()
    pg = new_page(doc)
    head_common(pg, '[거래처 원장 - 전표별]')
    for x, s in [(26, '전표일자'), (62, '전표타입'), (128, '내용'), (196, '매입금액'), (249, '지불금액'), (308, '매출금액'), (366, '수금금액'), (421, '잔액'), (510, '메모')]:
        put(pg, x, 74, s)
    put(pg, 15, 89, '월:')
    put(pg, 28, 89, '[0]')
    put(pg, 61, 102, '이월')
    put(pg, 88, 102, '이월')
    right(pg, 449, 102, '450,000')
    for y in (113,):
        put(pg, 218, y, '합계:0'); put(pg, 271, y, '합계:0'); put(pg, 335, y, '합계:0'); put(pg, 387, y, '합계:0')
    put(pg, 15, 124, '월: 2026년 10월')
    put(pg, 60, 124, '[2]')
    put(pg, 25, 136, '2026-10-02')
    put(pg, 61, 136, '수금')
    put(pg, 88, 136, '이체')
    right(pg, 402, 136, '500,000')
    right(pg, 449, 136, '-50,000')
    put(pg, 25, 149, '2026-10-20')
    put(pg, 61, 149, '매출')
    put(pg, 88, 149, '[장갑(10KG)* 100] 외 1건')
    right(pg, 350, 149, '77,000')
    right(pg, 449, 149, '27,000')
    for y in (160, 170):
        put(pg, 218, y, '합계:0'); put(pg, 271, y, '합계:0'); put(pg, 321, y, '합계:77,000'); put(pg, 370, y, '합계:500,000')
    foot(pg)
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)


def detail(path):
    doc = fitz.open()
    pg = new_page(doc)
    head_common(pg, '[거래처 원장 - 상품상세]')
    for x, s in [(99, '상품'), (218, '바코드'), (259, '재고 단위'), (299, '상품수량'), (346, '상품단가'), (403, '공급가액'), (468, '부가세액'), (533, '합계금액')]:
        put(pg, x, 78, s)
    put(pg, 16, 98, '매출일자 : 2026-10-20')
    put(pg, 102, 98, '상품수량 : 2')
    put(pg, 176, 98, '공급가액 : 70,000')
    put(pg, 256, 98, '부가세액 : 7,000')
    put(pg, 334, 98, '합계금액 : 77,000')
    put(pg, 413, 98, '메모 :')
    rows = [(114, '장갑(10KG)* 100', '1234567', '1', '44,000', '40,000', '4,000', '44,000'),
            (131, '마대*포대 5KG', '1234568', '1', '33,000', '30,000', '3,000', '33,000')]
    for y, name, code, q, u, a, v, t in rows:
        put(pg, 29, y, name)
        put(pg, 199, y, code)
        put(pg, 261, y, 'EA')
        right(pg, 336, y, q)
        right(pg, 382, y, u)
        right(pg, 450, y, a)
        right(pg, 512, y, v)
        right(pg, 580, y, t)
    for y in (146, 158):
        put(pg, 407, y, '합계 : 70,000'); put(pg, 473, y, '합계 : 7,000'); put(pg, 537, y, '합계 : 77,000')
    foot(pg)
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)


def textless(path):
    # 글자층 없는 그림 PDF(경영박사 메일처럼) — 선·칸만 그림
    doc = fitz.open()
    pg = doc.new_page(width=595, height=841)
    for y in range(80, 400, 20):
        pg.draw_line((20, y), (575, y))
    pg.draw_rect(fitz.Rect(20, 80, 575, 380))
    doc.save(path, garbage=4, deflate=True)


def unknown(path):
    # 아는 틀이 아닌 글자 PDF(다른 업체 견적서 꼴)
    doc = fitz.open()
    pg = new_page(doc)
    put(pg, 250, 40, '견 적 서', 12)
    put(pg, 40, 100, '품명', 8); put(pg, 200, 100, '수량', 8); put(pg, 300, 100, '금액', 8)
    put(pg, 40, 120, '가짜 부품', 8); put(pg, 200, 120, '1', 8); put(pg, 300, 120, '10,000', 8)
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else HERE
    ledger(os.path.join(out, 'ochun_ledger_fake.pdf'))
    detail(os.path.join(out, 'ochun_detail_fake.pdf'))
    textless(os.path.join(out, 'textless_fake.pdf'))
    unknown(os.path.join(out, 'unknown_fake.pdf'))
    print('ok')
