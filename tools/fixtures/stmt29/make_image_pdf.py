# 29 판④ 부품 C 시험 자료 — 그림 PDF(스캔본 꼴) 가짜 1개: 쪽 5장(5쪽 = 회색 Flate + PNG 예측자, 아래 본문 참고)
#   1쪽 회색 Flate 그림(왼쪽 절반 검정·오른쪽 흰색, 200x100) + 작은 RGB 그림(가장 큰 것만 골라야 함)
#   2쪽 RGB Flate 그림(빨강, 120x80)
#   3쪽 JPEG(DCT) 그림(파랑, 160x120) + 글자층 '가짜 OCR'
#   4쪽 글자만(그림 없음)
# 실행: python -I tools/fixtures/stmt29/make_image_pdf.py   (PyMuPDF 필요, 값은 전부 가짜)
import os
import sys

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = r'C:\Windows\Fonts\malgun.ttf'


def pix(cs, w, h, fill):
    p = fitz.Pixmap(cs, fitz.IRect(0, 0, w, h), False)
    p.set_rect(p.irect, fill)
    return p


def main(out):
    doc = fitz.open()
    # 1쪽 — 회색
    pg = doc.new_page(width=595, height=842)
    g = pix(fitz.csGRAY, 200, 100, (255,))
    g.set_rect(fitz.IRect(0, 0, 100, 100), (0,))
    pg.insert_image(fitz.Rect(10, 10, 40, 40), pixmap=pix(fitz.csRGB, 20, 20, (0, 255, 0)))   # 작은 그림을 먼저 칠함(첫 그림 ≠ 가장 큰 그림)
    pg.insert_image(fitz.Rect(0, 0, 595, 842), pixmap=g, keep_proportion=False)
    # 2쪽 — RGB
    pg = doc.new_page(width=595, height=842)
    pg.insert_image(fitz.Rect(0, 0, 595, 842), pixmap=pix(fitz.csRGB, 120, 80, (255, 0, 0)), keep_proportion=False)
    # 3쪽 — JPEG + 글자층
    pg = doc.new_page(width=595, height=842)
    jpg = pix(fitz.csRGB, 160, 120, (0, 0, 255)).tobytes('jpeg')
    pg.insert_image(fitz.Rect(0, 0, 595, 842), stream=jpg, keep_proportion=False)
    pg.insert_font(fontname='kr', fontfile=FONT)
    pg.insert_text((50, 100), '가짜 OCR', fontname='kr', fontsize=10)
    # 4쪽 — 글자만
    pg = doc.new_page(width=595, height=842)
    pg.insert_font(fontname='kr', fontfile=FONT)
    pg.insert_text((50, 100), '글자만 있는 쪽', fontname='kr', fontsize=10)
    # 5쪽 — 회색 Flate + PNG 예측자(Predictor 15, 스캐너 PDF에 흔함): 64x32, 위 절반 검정·아래 흰색, 줄마다 Up 필터(2)
    import zlib
    w, h = 64, 32
    raw = b''.join(bytes([2]) + bytes([0 if (y == 0) else (255 if y == h // 2 else 0)] * w) for y in range(h))
    x = doc.get_new_xref()
    doc.update_object(x, '<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 '
                         '/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns %d >> >>' % (w, h, w))
    doc.update_stream(x, zlib.compress(raw), compress=False)
    doc.xref_set_key(x, 'Filter', '/FlateDecode')   # update_stream이 DecodeParms를 지우므로 다시 넣음
    doc.xref_set_key(x, 'DecodeParms', '<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns %d >>' % w)
    pg = doc.new_page(width=595, height=842)
    pg.insert_image(fitz.Rect(0, 0, 595, 842), xref=x, keep_proportion=False)
    doc.subset_fonts()
    doc.save(os.path.join(out, 'images_fake.pdf'), garbage=4, deflate=True)
    d2 = fitz.open(os.path.join(out, 'images_fake.pdf'))
    print('ok', [[(x[7], d2.extract_image(x[0])['ext']) for x in p.get_images(full=True)] for p in d2])


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else HERE)
