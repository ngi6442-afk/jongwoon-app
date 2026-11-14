// 체크 29 판④ 부품 A 시험 자료(가짜) 만들기 — 실물 값은 하나도 쓰지 않는다.
// 사업자번호는 000-00-0000x 꼴 가짜, 상호·금액·날짜도 지어낸 값. 보안 HTML은 _lib/stmtnts.js의 SEED·AES 암호로 실물과 같은 꼴(idCriHeader·idCriPcContents·idCriAttachContents<i>, 머리 키 이름)로 만든다.
// 실행: node tools/fixtures/stmt29/make_a_fixtures.mjs  → 같은 폴더에 a_*.xml · a_*.html (매번 같은 바이트 — iv 0, 난수 없음)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', '..', 'netlify', 'functions', '_lib');
const N = require(join(LIB, 'stmtnts.js'));

export const FAKE = {
  buyerA: '0000000001',   // 가짜 '받는 쪽 1'(종운환경 자리)
  buyerB: '0000000002',   // 가짜 '받는 쪽 2'(종운건설 자리)
  vendor1: '0000000011',
  vendor3: '0000000013'
};

const party = (tag, id, name) => `<${tag}><ID>${id}</ID><NameText>${name}</NameText>` +
  `<SpecifiedOrganization><TaxRegistrationID></TaxRegistrationID></SpecifiedOrganization>` +
  `<SpecifiedPerson><NameText>가짜대표</NameText></SpecifiedPerson>` +
  `<DefinedContact><URICommunication>fake@example.invalid</URICommunication></DefinedContact>` +
  `<SpecifiedAddress><LineOneText>가짜시 가짜로 1</LineOneText></SpecifiedAddress></${tag}>`;
const sig = '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="x"/>' +
  '<ds:Reference URI=""><ds:DigestValue>QUFBQQ==</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>QkJCQg==</ds:SignatureValue></ds:Signature>';

// 1줄짜리(엔티티·CDATA·접두어·주석 섞음) — AES로 싼다
export const XML1 = '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n' +
  '<!-- 시험용 가짜 계산서 -->\r\n' +
  '<TaxInvoice xmlns="urn:kr:or:kec:standard:Tax:ReusableAggregateBusinessInformationEntitySchemaModule:1:0">' +
  '<ExchangedDocument><IssueDateTime>20261101093000</IssueDateTime></ExchangedDocument>' + sig +
  '<TaxInvoiceDocument><IssueID>00000000-00000000-00000001</IssueID><TypeCode>0101</TypeCode><IssueDateTime>20261031</IssueDateTime><PurposeCode>02</PurposeCode></TaxInvoiceDocument>' +
  '<TaxInvoiceTradeSettlement>' + party('InvoicerParty', FAKE.vendor1, '가짜&amp;타이어 &lt;시험&gt;') + party('InvoiceeParty', FAKE.buyerB, '가짜받는곳2') +
  '<SpecifiedPaymentMeans><TypeCode>10</TypeCode></SpecifiedPaymentMeans>' +
  '<SpecifiedMonetarySummation><ChargeTotalAmount>123450</ChargeTotalAmount><TaxTotalAmount>12345</TaxTotalAmount><GrandTotalAmount>135795</GrandTotalAmount></SpecifiedMonetarySummation>' +
  '</TaxInvoiceTradeSettlement>' +
  '<kec:TaxInvoiceTradeLineItem xmlns:kec="urn:fake"><kec:SequenceNumeric>1</kec:SequenceNumeric><kec:InvoiceAmount>123450</kec:InvoiceAmount>' +
  '<kec:NameText><![CDATA[10월분 정비 & 부품]]></kec:NameText>' +
  '<kec:PurchaseExpiryDateTime>20261031</kec:PurchaseExpiryDateTime><kec:TotalTax><kec:CalculatedAmount>12345</kec:CalculatedAmount></kec:TotalTax>' +
  '</kec:TaxInvoiceTradeLineItem></TaxInvoice>\r\n';

// 3줄짜리(수량·단가·규격·비고·차량 번호, 한 줄 비고에 가짜 전화 꼴) — SEED로 싼다
export const XML3 = '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
  '<TaxInvoice xmlns="urn:kr:or:kec:standard:Tax:ReusableAggregateBusinessInformationEntitySchemaModule:1:0">' +
  '<ExchangedDocument><IssueDateTime>20261102100000</IssueDateTime></ExchangedDocument>' + sig +
  '<TaxInvoiceDocument><IssueID>00000000-00000000-00000003</IssueID><TypeCode>0101</TypeCode><DescriptionText>가짜 비고</DescriptionText><IssueDateTime>20261030</IssueDateTime><PurposeCode>02</PurposeCode></TaxInvoiceDocument>' +
  '<TaxInvoiceTradeSettlement>' + party('InvoicerParty', FAKE.vendor3, '가짜상용서비스') + party('InvoiceeParty', FAKE.buyerA, '가짜받는곳1') +
  '<SpecifiedPaymentMeans><TypeCode>30</TypeCode><PaidAmount>0</PaidAmount></SpecifiedPaymentMeans>' +
  '<SpecifiedMonetarySummation><ChargeTotalAmount>1,001,500</ChargeTotalAmount><TaxTotalAmount>100150</TaxTotalAmount><GrandTotalAmount>1101650</GrandTotalAmount></SpecifiedMonetarySummation>' +
  '</TaxInvoiceTradeSettlement>' +
  '<TaxInvoiceTradeLineItem><SequenceNumeric>1</SequenceNumeric><InvoiceAmount>800000</InvoiceAmount><ChargeableUnitQuantity>4</ChargeableUnitQuantity>' +
  '<InformationText>315/80R22.5</InformationText><NameText>가짜 타이어</NameText><PurchaseExpiryDateTime>20261005</PurchaseExpiryDateTime>' +
  '<TotalTax><CalculatedAmount>80000</CalculatedAmount></TotalTax><UnitPrice><UnitAmount>200000</UnitAmount></UnitPrice><DescriptionText>80가 1234 앞바퀴</DescriptionText></TaxInvoiceTradeLineItem>' +
  '<TaxInvoiceTradeLineItem><SequenceNumeric>2</SequenceNumeric><InvoiceAmount>1500</InvoiceAmount><ChargeableUnitQuantity>2.5</ChargeableUnitQuantity>' +
  '<NameText>가짜 요소수</NameText><PurchaseExpiryDateTime>20261012</PurchaseExpiryDateTime>' +
  '<TotalTax><CalculatedAmount>150</CalculatedAmount></TotalTax><UnitPrice><UnitAmount>600</UnitAmount></UnitPrice></TaxInvoiceTradeLineItem>' +
  '<TaxInvoiceTradeLineItem><SequenceNumeric>3</SequenceNumeric><InvoiceAmount>200000</InvoiceAmount><ChargeableUnitQuantity>1</ChargeableUnitQuantity>' +
  '<NameText>가짜 공임</NameText><PurchaseExpiryDateTime>20261031</PurchaseExpiryDateTime>' +
  '<TotalTax><CalculatedAmount>20000</CalculatedAmount></TotalTax><UnitPrice><UnitAmount>200000</UnitAmount></UnitPrice><DescriptionText>문의 010-0000-0000</DescriptionText></TaxInvoiceTradeLineItem>' +
  '</TaxInvoice>\r\n';

export function build() {
  const x1 = Buffer.from(XML1, 'utf8'), x3 = Buffer.from(XML3, 'utf8');
  return {
    'a_tax1.xml': x1,
    'a_tax3.xml': x3,
    'a_nts_seed.html': N.encryptNtsForTest({ alg: 'SEED', bn: FAKE.buyerA, body: '<html><body>가짜 계산서 보기 화면</body></html>', files: [{ name: '00000000000000000000000003.xml', buf: x3 }] }),
    'a_nts_aes.html': N.encryptNtsForTest({ alg: 'AES', bn: FAKE.buyerB, files: [{ name: '00000000000000000000000001.xml', buf: x1 }] })
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build();
  for (const [k, v] of Object.entries(out)) { fs.writeFileSync(join(HERE, k), v); console.log('씀', k, v.length); }
}
