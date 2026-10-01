import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import { cvFormatDetails, normalizeCvFormat } from '../shared/cv-format.js';

export const MAX_CV_EXPORT_CHARS = 150_000;
const FONT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts', 'Ubuntu-R.ttf');
const FONT_BOLD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts', 'Ubuntu-B.ttf');

function cleanMarkup(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/<[^>]*>/g, '')
    .replace(/`([^`]+)`/g, '$1');
}

function stripMarkup(value) {
  return cleanMarkup(value).trim();
}

function markdownBlocks(markdown) {
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of String(markdown || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) { flush(); blocks.push({ type: 'bullet', text: bullet[1] }); continue; }
    const number = line.match(/^\d+[.)]\s+(.+)$/);
    if (number) { flush(); blocks.push({ type: 'number', marker: number[0].match(/^\d+/)?.[0] || '1', text: number[1] }); continue; }
    paragraph.push(line.replace(/^>\s?/, ''));
  }
  flush();
  return blocks.length ? blocks : [{ type: 'paragraph', text: '' }];
}

function inlineRuns(value) {
  const source = String(value || '');
  const runs = [];
  const pattern = /(\*\*|__)(.+?)\1|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) runs.push({ text: cleanMarkup(source.slice(cursor, match.index)), bold: false });
    runs.push(match[3]
      ? { text: cleanMarkup(match[3]), bold: false, link: match[4] }
      : { text: cleanMarkup(match[2]), bold: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) runs.push({ text: cleanMarkup(source.slice(cursor)), bold: false });
  return runs.length ? runs : [{ text: cleanMarkup(source), bold: false }];
}

function safeFilenameSegment(value, fallback) {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  return normalized || fallback;
}

export function cvExportFilename({ profileName, roleTitle, format }) {
  return `${safeFilenameSegment(profileName, 'candidate')}-${safeFilenameSegment(roleTitle, 'tailored-cv')}.${format}`;
}

function pdfText(doc, runs, options = {}) {
  runs.forEach((run, index) => {
    doc.font(run.bold ? 'CVBold' : 'CVRegular').fontSize(options.size || 10.5).fillColor('#1f2937').text(run.text, {
      continued: index < runs.length - 1,
      link: run.link,
      underline: Boolean(run.link),
      indent: options.indent || 0,
      lineGap: 3,
    });
  });
}

async function createPdf(markdown, metadata) {
  const chunks = [];
  const document = new PDFDocument({
    size: 'A4',
    margins: { top: 52, right: 52, bottom: 52, left: 52 },
    info: { Title: `${metadata.roleTitle || 'Tailored CV'} — ${metadata.formatLabel}` },
  });
  document.registerFont('CVRegular', FONT_PATH);
  document.registerFont('CVBold', FONT_BOLD_PATH);
  document.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => { document.on('end', resolve); document.on('error', reject); });
  const blocks = markdownBlocks(markdown);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === 'heading') {
      if (document.y > document.page.height - document.page.margins.bottom - 92) document.addPage();
      document.moveDown(block.level === 1 ? 0.7 : 0.45);
      document.font('CVBold').fontSize(block.level === 1 ? 18 : block.level === 2 ? 14 : 11.5).fillColor('#17365d');
      document.text(stripMarkup(block.text), { lineGap: 3 });
      continue;
    }
    document.moveDown(0.2);
    const runs = inlineRuns(block.text);
    if (block.type === 'bullet') {
      document.font('CVRegular').fontSize(10.5).fillColor('#1f2937').text('•  ', { continued: true, indent: 8, lineGap: 3 });
      pdfText(document, runs, { size: 10.5 });
    } else if (block.type === 'number') {
      document.font('CVRegular').fontSize(10.5).fillColor('#1f2937').text(`${block.marker}.  `, { continued: true, indent: 8, lineGap: 3 });
      pdfText(document, runs, { size: 10.5 });
    } else {
      pdfText(document, runs, { size: 10.5 });
    }
  }
  document.end();
  await finished;
  return Buffer.concat(chunks);
}

function docxRuns(value, options = {}) {
  return inlineRuns(value).map((run) => {
    const textRun = new TextRun({ text: run.text, bold: options.bold || run.bold, font: 'Arial', size: options.size || 21, color: run.link ? '0563C1' : '1F2937', underline: run.link ? {} : undefined });
    return run.link ? new ExternalHyperlink({ children: [textRun], link: run.link }) : textRun;
  });
}

async function createDocx(markdown, metadata) {
  const children = markdownBlocks(markdown).map((block) => {
    if (block.type === 'heading') {
      return new Paragraph({ heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, keepNext: true, children: docxRuns(block.text, { bold: true, size: block.level === 1 ? 36 : block.level === 2 ? 28 : 23 }), spacing: { before: 260, after: 120 } });
    }
    return new Paragraph({
      children: block.type === 'number' ? [new TextRun({ text: `${block.marker}.  `, font: 'Arial', size: 21, color: '1F2937' }), ...docxRuns(block.text)] : docxRuns(block.text),
      bullet: block.type === 'bullet' ? { level: 0 } : undefined,
      alignment: AlignmentType.LEFT,
      spacing: { after: 120, line: 276 },
    });
  });
  const document = new Document({
    creator: 'Hire Me Agents',
    title: `${metadata.roleTitle || 'Tailored CV'} — ${metadata.formatLabel}`,
    description: 'Editable tailored CV export',
    styles: { default: { document: { run: { font: 'Arial', size: 21, color: '1F2937' } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

export async function createCvExport({ content, format, profileName = '', roleTitle = '', cvFormat = 'chronological' }) {
  const normalizedFormat = format === 'docx' || format === 'pdf' ? format : '';
  if (!normalizedFormat) throw new Error('Choose PDF or DOCX export format.');
  const text = String(content || '').replace(/\0/g, '').trim();
  if (!text) throw new Error('Add CV content before exporting.');
  if (text.length > MAX_CV_EXPORT_CHARS) throw new Error(`CV content must be ${MAX_CV_EXPORT_CHARS.toLocaleString()} characters or fewer.`);
  if (!fs.existsSync(FONT_PATH) || !fs.existsSync(FONT_BOLD_PATH)) throw new Error('The Unicode export font is unavailable.');
  const metadata = { roleTitle: String(roleTitle || '').slice(0, 160), formatLabel: cvFormatDetails(normalizeCvFormat(cvFormat)).label };
  const buffer = normalizedFormat === 'pdf' ? await createPdf(text, metadata) : await createDocx(text, metadata);
  return {
    buffer,
    filename: cvExportFilename({ profileName, roleTitle, format: normalizedFormat }),
    contentType: normalizedFormat === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

