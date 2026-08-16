#!/usr/bin/env node
// Dep-free, deterministic generator for the BINARY import-fidelity fixtures
// (the two PDFs + the DOCX). Plain-text fixtures (csv/md/html) are authored
// directly as files and are NOT touched by this script.
//
// Run: node benchmark/fixtures/import/tools/gen-fixtures.mjs
//
// No npm dependencies — only Buffer/strings + node:zlib (crc32 + deflateSync
// for the DOCX zip and the embedded PNG's IDAT chunk). Every byte written
// here is a function of the literal content below: no Date.now(), no
// Math.random(), no environment-derived value — so two runs produce
// byte-identical files (verified by the caller via sha256sum).
//
// PDF objects carry no /CreationDate or /Producer at all (the /Info
// dictionary is omitted outright) so there is nothing date-like to churn.
// The DOCX zip pins its DOS mtime the same way service/server.js's
// buildStoredZip() does for skill.zip: fixed DOS_TIME/DOS_DATE constants,
// STORED (no compression) entries, computed CRC32.

import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // benchmark/fixtures/import

// ─────────────────────────────────────────────────────────────────────────
// Minimal PDF 1.4 writer: one page, base-14 Helvetica/Helvetica-Bold (no
// font embedding — pdf.js extracts base-14 text via WinAnsiEncoding), text
// runs placed with an explicit text matrix (one Tj per line — guarantees
// each line survives as a single pdf.js text item, never split mid-phrase),
// plus vector rules (re/m/l + S stroke ops) for the invoice table grid.
// ─────────────────────────────────────────────────────────────────────────

function pdfEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// One full BT..ET block per call == one pdf.js text item == the whole
// `str` survives as one contiguous run (word-merge heuristics in
// renderPdfPage can't split what was never separate items).
function pdfText(x, y, size, str, font = 'F1') {
  return `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(str)}) Tj ET\n`;
}

function pdfLine(x1, y1, x2, y2, lw = 1) {
  return `${lw} w\n${x1} ${y1} m ${x2} ${y2} l S\n`;
}

function pdfRect(x, y, w, h, lw = 1) {
  return `${lw} w\n${x} ${y} ${w} ${h} re S\n`;
}

function buildPdf(width, height, contentStream) {
  const contentBytes = Buffer.from(contentStream, 'latin1');
  const objs = [
    null, // 0 unused
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    { stream: contentBytes },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = new Array(objs.length).fill(0);
  let pos = chunks[0].length;

  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pos;
    const obj = objs[i];
    let body;
    if (obj && obj.stream) {
      body = Buffer.concat([
        Buffer.from(`${i} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n`, 'latin1'),
        obj.stream,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      body = Buffer.from(`${i} 0 obj\n${obj}\nendobj\n`, 'latin1');
    }
    chunks.push(body);
    pos += body.length;
  }

  const xrefOffset = pos;
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));

  return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────────────────
// pdf/memo.pdf — plain multi-paragraph memo, no table. Coverage/order/garble.
// ─────────────────────────────────────────────────────────────────────────

function buildMemoPdf() {
  const W = 612, H = 792; // US Letter
  const left = 72;
  let cs = '';
  const Y = (fromTop) => H - fromTop;

  cs += pdfText(left, Y(96), 18, 'Quarterly Business Memo', 'F2');
  cs += pdfText(left, Y(120), 10, 'Q2 2026 · Finance & Operations', 'F1');

  const paraA = [
    'Revenue rose 12% year over year, driven by strong renewal rates in',
    'the enterprise segment and a rebound in new customer acquisition',
    'across North America and Europe. Gross margin held steady at 71%,',
    'in line with the plan reviewed at the April board meeting.',
  ];
  let y = 156;
  for (const line of paraA) { cs += pdfText(left, Y(y), 11, line, 'F1'); y += 16; }

  const paraB = [
    'Support ticket volume declined 8% following the rollout of the',
    'self-serve onboarding flow, and the average first response time',
    'improved from six hours to just under four. Customer satisfaction',
    'scores rose two points to 92.',
  ];
  y += 8;
  for (const line of paraB) { cs += pdfText(left, Y(y), 11, line, 'F1'); y += 16; }

  y += 8;
  cs += pdfText(left, Y(y), 13, 'Next steps', 'F2');
  y += 22;

  const paraC = [
    'Next steps: finalize the Q3 hiring plan, expand the partner',
    'integration program, and close out the pending vendor security',
    'review before the September board meeting.',
  ];
  for (const line of paraC) { cs += pdfText(left, Y(y), 11, line, 'F1'); y += 16; }

  const paraD = [
    'Conclusion: the team is on track to hit the annual growth target',
    'set in January, and the finance group will circulate the full',
    'variance report by the first week of July.',
  ];
  y += 8;
  for (const line of paraD) { cs += pdfText(left, Y(y), 11, line, 'F1'); y += 16; }

  return buildPdf(W, H, cs);
}

// ─────────────────────────────────────────────────────────────────────────
// pdf/invoice.pdf — header lines + a visible 5x3 table drawn with vector
// rules, right-aligned numeric amounts. structure baseline (convertPdf
// emits positioned spans, no <table> — scores ~0 there; that gap is the
// documented, intentional point of this fixture).
// ─────────────────────────────────────────────────────────────────────────

// Very rough Helvetica advance width (em fraction) — good enough to
// right-align a numeric column visually; not used for anything scored.
function approxTextWidth(str, size) {
  return str.length * 0.55 * size;
}

function buildInvoicePdf() {
  const W = 612, H = 792;
  const left = 72, right = 540;
  let cs = '';
  const Y = (fromTop) => H - fromTop;

  cs += pdfText(left, Y(90), 20, 'INVOICE', 'F2');
  cs += pdfText(left, Y(118), 11, 'Acme Robotics Inc.', 'F1');
  cs += pdfText(left, Y(134), 11, 'Invoice #2026-0417', 'F1');
  cs += pdfText(left, Y(150), 11, 'Bill To: Northwind Traders', 'F1');
  cs += pdfText(left, Y(170), 10, 'Issue date: 2026-07-01    Due date: 2026-07-31', 'F1');

  // Table geometry: 5 rows (1 header + 4 data), 3 columns.
  const tableTop = 210;      // from-top y of the first grid line
  const rowH = 24;
  const rows = 5;
  const colX = [left, 322, 402, right]; // 4 verticals => 3 columns
  const gridTopY = Y(tableTop);
  const gridBottomY = Y(tableTop + rows * rowH);

  // Outer border (re + S).
  cs += pdfRect(left, gridBottomY, right - left, rows * rowH, 1.2);
  // Verticals (m/l + S).
  for (const x of colX) cs += pdfLine(x, gridTopY, x, gridBottomY, 1);
  // Horizontals (m/l + S).
  for (let r = 0; r <= rows; r++) {
    const ly = Y(tableTop + r * rowH);
    cs += pdfLine(left, ly, right, ly, 1);
  }

  const cellPad = 8;
  const rowsData = [
    ['Description', 'Qty', 'Amount', true],
    ['Widget A', '4', '$120.00', false],
    ['Widget B', '2', '$75.50', false],
    ['Shipping', '1', '$15.00', false],
    ['Total', '', '$210.50', false],
  ];
  for (let r = 0; r < rowsData.length; r++) {
    const [desc, qty, amt, header] = rowsData[r];
    const font = header ? 'F2' : 'F1';
    const size = 10.5;
    const textY = Y(tableTop + r * rowH + rowH / 2 + 3.5);
    cs += pdfText(colX[0] + cellPad, textY, size, desc, font);
    if (qty) cs += pdfText(colX[1] + cellPad, textY, size, qty, font);
    // Right-align the amount column against colX[3] (the right border).
    const amtRight = colX[3] - cellPad;
    const amtX = amtRight - approxTextWidth(amt, size);
    cs += pdfText(amtX, textY, size, amt, font);
  }

  return buildPdf(W, H, cs);
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal 1x1 opaque-red PNG (IHDR/IDAT/IEND), built from scratch with
// node:zlib only — the DOCX's tiny inline image.
// ─────────────────────────────────────────────────────────────────────────

function buildTinyPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);  // width
  ihdr.writeUInt32BE(1, 4);  // height
  ihdr.writeUInt8(8, 8);     // bit depth
  ihdr.writeUInt8(6, 9);     // color type: RGBA
  ihdr.writeUInt8(0, 10);    // compression
  ihdr.writeUInt8(0, 11);    // filter
  ihdr.writeUInt8(0, 12);    // interlace
  const raw = Buffer.from([0x00, 0xcc, 0x33, 0x33, 0xff]); // filter byte 0 + opaque red-ish RGBA
  const idatData = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal STORED-only zip writer — mirrors buildStoredZip() in
// service/server.js (skill.zip): STORED entries, zlib.crc32, pinned DOS
// mtime, so successive runs emit byte-identical archives.
// ─────────────────────────────────────────────────────────────────────────

function buildStoredZip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = 23728; // pinned, arbitrary — matches the skill.zip convention
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(dataBuf) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, dataBuf);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(dataBuf.length, 20);
    ch.writeUInt32LE(dataBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0x81a40000, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));

    offset += lh.length + nameBuf.length + dataBuf.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

// ─────────────────────────────────────────────────────────────────────────
// docx/report.docx — WordprocessingML: h1 + h2 headings (real Heading1/
// Heading2 paragraph styles), one bulleted + one numbered list, a 3x3
// table, bold/italic runs, and one tiny inline PNG (data-URI survival).
// ─────────────────────────────────────────────────────────────────────────

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>
`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>
`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>
`;

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>
`;

function docxP(inner, styleId) {
  const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : '';
  return `<w:p>${pPr}${inner}</w:p>`;
}
function docxListItem(text, numId) {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}
function docxRun(text, { bold, italic } = {}) {
  const rPr = (bold || italic) ? `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}
function docxCell(text, w) {
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
}
function docxRow(cells) {
  return `<w:tr>${cells.map(([t, w]) => docxCell(t, w)).join('')}</w:tr>`;
}

const INLINE_IMAGE_DRAWING = `<w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="228600" cy="228600"/>
<wp:docPr id="1" name="Picture 1"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="228600" cy="228600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic>
</a:graphicData>
</a:graphic>
</wp:inline>
</w:drawing>`;

function buildReportDocxXml() {
  const body = [
    docxP(docxRun('Q2 Product Report'), 'Heading1'),
    docxP(docxRun('Highlights'), 'Heading2'),
    docxP(
      docxRun('Adoption grew across every region this quarter, with the ') +
      docxRun('enterprise segment', { bold: true }) +
      docxRun(' growing fastest while ') +
      docxRun('pilot programs', { italic: true }) +
      docxRun(' expanded into three new regions.')
    ),
    docxListItem('Faster onboarding flow shipped to all new customers', 1),
    docxListItem('New dashboard analytics rolled out in beta', 1),
    docxListItem('Expanded API rate limits for partner integrations', 1),
    docxP(docxRun('Roadmap'), 'Heading2'),
    docxListItem('Ship the billing redesign', 2),
    docxListItem('Complete the SOC 2 audit', 2),
    docxListItem('Launch the partner API', 2),
    `<w:tbl>
<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
</w:tblBorders></w:tblPr>
<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
${docxRow([['Metric', 3000], ['Q1', 2000], ['Q2', 2000]])}
${docxRow([['Active Users', 3000], ['8,200', 2000], ['9,650', 2000]])}
${docxRow([['Monthly Revenue', 3000], ['$142k', 2000], ['$159k', 2000]])}
</w:tbl>`,
    docxP(docxRun('The chart below shows quarter-over-quarter growth.')),
    `<w:p><w:r>${INLINE_IMAGE_DRAWING}</w:r></w:p>`,
    docxP(docxRun('The team will publish the full Q3 plan alongside the September board packet.')),
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${body}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body>
</w:document>
`;
}

function buildReportDocx() {
  const entries = [
    ['[Content_Types].xml', CONTENT_TYPES_XML],
    ['_rels/.rels', ROOT_RELS_XML],
    ['word/document.xml', buildReportDocxXml()],
    ['word/_rels/document.xml.rels', DOCUMENT_RELS_XML],
    ['word/styles.xml', STYLES_XML],
    ['word/numbering.xml', NUMBERING_XML],
    ['word/media/image1.png', buildTinyPng()],
  ];
  return buildStoredZip(entries);
}

// ─────────────────────────────────────────────────────────────────────────

writeFileSync(path.join(ROOT, 'pdf', 'memo.pdf'), buildMemoPdf());
writeFileSync(path.join(ROOT, 'pdf', 'invoice.pdf'), buildInvoicePdf());
writeFileSync(path.join(ROOT, 'docx', 'report.docx'), buildReportDocx());
console.log('gen-fixtures: wrote pdf/memo.pdf, pdf/invoice.pdf, docx/report.docx');
