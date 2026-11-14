# 29 판④ 부품 C 시험 자료 — 수양개발 '거래명세서'(Excel 글자 PDF)와 같은 배치의 가짜 표를 엑셀 COM으로 만들어 PDF로 내보냄.
# 값은 전부 가짜(상호 '가짜개발'·'㈜ 가짜환경', 등록번호 000-00-00000, 대표 칸 '○○○', 전화 칸 없음, 금액 임의).
# 실행: python -I tools/fixtures/stmt29/make_suyang_pdf.py   (Windows + Excel + pywin32 필요)
import os
import sys

import win32com.client

HERE = os.path.dirname(os.path.abspath(__file__))

ROWS = [  # 일자(글), 품목, 차량번호, 수량, 단가, 공급가액, 세액
    ("'10/02", '감속기뭉치, 체인', '5288', 1, 450000, 450000, 45000),
    ("'10/15", '덮개판L, 덮개판R', '1234', 2, 150000, 300000, 30000),
    ("'10/28", '레일L, 레일R', '80버5474', 1, 450000, 450000, 45000),
]


def main(out):
    xl = win32com.client.DispatchEx('Excel.Application')
    xl.Visible = False
    xl.DisplayAlerts = False
    wb = xl.Workbooks.Add()
    try:
        ws = wb.Worksheets(1)
        for col, w in zip('ABCDEFG', (9, 34, 11, 6, 11, 12, 11)):
            ws.Columns(col).ColumnWidth = w
        ws.Cells.Font.Name = '맑은 고딕'
        ws.Cells.Font.Size = 9

        ws.Range('A1:G1').Merge()
        ws.Range('A1').Value = '거래명세서'
        ws.Range('A1').Font.Size = 18
        ws.Range('A1').HorizontalAlignment = -4108

        ws.Range('C3').Value = '등록번호'
        ws.Range('D3:G3').Merge()
        ws.Range('D3').Value = '000-00-00000'
        ws.Range('C4').Value = '상 호'
        ws.Range('D4:E4').Merge()
        ws.Range('D4').Value = '가짜개발'
        ws.Range('F4').Value = '성 명'
        ws.Range('G4').Value = '○○○ (인)'
        ws.Range('A4:B4').Merge()
        ws.Range('A4').Value = '㈜ 가짜환경 귀하'
        ws.Range('C5').Value = '업 태'
        ws.Range('D5:G5').Merge()
        ws.Range('D5').Value = '제조, 도소매'
        ws.Range('A6').Value = '2026 년 11 월 01 일'
        ws.Range('A7:B7').Merge()
        ws.Range('A7').Value = '아래와 같이 계산합니다.'

        ws.Range('A9').Value = '합계금액'
        ws.Range('B9').Value = '(공급가액+세액)'
        ws.Range('C9:D9').Merge()
        ws.Range('C9').Value = '일금 일백삼십이만원정'
        ws.Range('E9').Value = '\\'
        ws.Range('F9').Value = 1320000
        ws.Range('F9').NumberFormat = '#,##0'

        # 두 단 머리: 일자~단가는 세로 병합, 거래 금액 아래 공급가액·세액
        for c, s in zip('ABCDE', ('일자', '품목', '차량번호', '수량', '단 가')):
            ws.Range(c + '11:' + c + '12').Merge()
            ws.Range(c + '11').Value = s
            ws.Range(c + '11').VerticalAlignment = -4108
        ws.Range('F11:G11').Merge()
        ws.Range('F11').Value = '거 래 금 액'
        ws.Range('F12').Value = '공급가액'
        ws.Range('G12').Value = '세 액'
        ws.Range('A11:G12').HorizontalAlignment = -4108

        r = 13
        for d, item, veh, q, u, a, v in ROWS:
            ws.Range('A%d' % r).Value = d
            ws.Range('B%d' % r).Value = item
            ws.Range('C%d' % r).NumberFormat = '@'
            ws.Range('C%d' % r).Value = veh
            ws.Range('D%d' % r).Value = q
            ws.Range('E%d' % r).Value = u
            ws.Range('F%d' % r).Value = a
            ws.Range('G%d' % r).Value = v
            ws.Range('A%d:D%d' % (r, r)).HorizontalAlignment = -4108
            ws.Range('E%d:G%d' % (r, r)).NumberFormat = '#,##0'
            r += 1
        tr = r + 1
        ws.Range('B%d' % tr).Value = '합계'
        ws.Range('B%d' % tr).HorizontalAlignment = -4108
        ws.Range('D%d' % tr).Value = '=SUM(D13:D%d)' % (r - 1)
        ws.Range('F%d' % tr).Value = '=SUM(F13:F%d)' % (r - 1)
        ws.Range('G%d' % tr).Value = '=SUM(G13:G%d)' % (r - 1)
        ws.Range('D%d' % tr).HorizontalAlignment = -4108
        ws.Range('F%d:G%d' % (tr, tr)).NumberFormat = '#,##0'
        ws.Range('A%d' % (tr + 2)).Value = '비 고'
        ws.Range('A11:G%d' % tr).Borders.LineStyle = 1

        ps = ws.PageSetup
        ps.PaperSize = 9  # A4
        ps.Zoom = False
        ps.FitToPagesWide = 1
        ps.FitToPagesTall = 1
        ps.PrintArea = 'A1:G%d' % (tr + 2)
        path = os.path.join(out, 'suyang_fake.pdf')
        ws.ExportAsFixedFormat(0, path)
    finally:
        wb.Close(False)
        xl.Quit()
    print('ok')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else HERE)
