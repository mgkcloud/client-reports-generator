#!/usr/bin/env node
/**
 * prepare_template.js
 * 
 * Takes the original report DOCX (template.docx) and creates a docxtemplater-compatible
 * tagged template (template_tagged.docx) by replacing hardcoded values with {tags}.
 * 
 * Structure:
 *   - Title: "Meta Ads Performance Audit"
 *   - Client/Campaign/Period info
 *   - Executive Summary
 *   - Key Metrics — This Week (table)
 *   - Key Metrics — This Month (table)
 *   - Key Metrics — Since Starting (table)
 *   - Latest Batch — Top Performers (table)
 *   - Top 5 Performers by CPL — All Time (table)
 *   - Release Lot Performance
 *   - Creative Insights
 *   - Demographic Sweet Spot
 *   - Key Insights
 *   - Recommended Next Steps
 *   - Chart image
 *   - Footer
 */

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATE_PATH = path.join(__dirname, 'template.docx');
const OUTPUT_PATH = path.join(__dirname, 'template_tagged.docx');

// ─── XML Building Helpers ──────────────────────────────────────────────

function xmlHeader() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
}

function documentOpen() {
  return `<w:document mc:Ignorable="w14 w15 wp14" xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" xmlns:cx2="http://schemas.microsoft.com/office/drawing/2015/10/21/chartex" xmlns:cx3="http://schemas.microsoft.com/office/drawing/2016/5/9/chartex" xmlns:cx4="http://schemas.microsoft.com/office/drawing/2016/5/10/chartex" xmlns:cx5="http://schemas.microsoft.com/office/drawing/2016/5/11/chartex" xmlns:cx6="http://schemas.microsoft.com/office/drawing/2016/5/12/chartex" xmlns:cx7="http://schemas.microsoft.com/office/drawing/2016/5/13/chartex" xmlns:cx8="http://schemas.microsoft.com/office/drawing/2016/5/14/chartex" xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink" xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex">`;
}

// Text run with properties
function run(text, props = {}) {
  let rpr = '';
  const parts = [];
  if (props.font) parts.push(`<w:rFonts w:ascii="${props.font}" w:cs="${props.font}" w:eastAsia="${props.font}" w:hAnsi="${props.font}"/>`);
  if (props.bold) parts.push(`<w:b/><w:bCs/>`);
  if (props.boldFalse) parts.push(`<w:b w:val="false"/><w:bCs w:val="false"/>`);
  if (props.italic) parts.push(`<w:i/><w:iCs/>`);
  if (props.color) parts.push(`<w:color w:val="${props.color}"/>`);
  if (props.size) parts.push(`<w:sz w:val="${props.size}"/><w:szCs w:val="${props.size}"/>`);
  if (parts.length) rpr = `<w:rPr>${parts.join('')}</w:rPr>`;
  return `<w:r>${rpr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

// Paragraph with style, spacing, justification
function para(content, props = {}) {
  const pprParts = [];
  if (props.style) pprParts.push(`<w:pStyle w:val="${props.style}"/>`);
  if (props.numId !== undefined) pprParts.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${props.numId}"/></w:numPr>`);
  if (props.spacing) {
    const sp = [];
    if (props.spacing.before) sp.push(`w:before="${props.spacing.before}"`);
    if (props.spacing.after) sp.push(`w:after="${props.spacing.after}"`);
    if (props.spacing.line) sp.push(`w:line="${props.spacing.line}" w:lineRule="auto"`);
    pprParts.push(`<w:spacing ${sp.join(' ')}/>`);
  }
  if (props.jc) pprParts.push(`<w:jc w:val="${props.jc}"/>`);
  const ppr = pprParts.length ? `<w:pPr>${pprParts.join('')}</w:pPr>` : '';
  return `<w:p>${ppr}${content}</w:p>`;
}

// Table cell
function tc(content, width, props = {}) {
  const tcParts = [`<w:tcW w:type="dxa" w:w="${width}"/>`];
  if (props.gridSpan) tcParts.push(`<w:gridSpan w:val="${props.gridSpan}"/>`);
  
  const borderColor = props.borderColor || 'E2E8F0';
  tcParts.push(`<w:tcBorders><w:top w:val="single" w:color="${borderColor}" w:sz="4"/><w:left w:val="single" w:color="${borderColor}" w:sz="4"/><w:bottom w:val="single" w:color="${borderColor}" w:sz="4"/><w:right w:val="single" w:color="${borderColor}" w:sz="4"/></w:tcBorders>`);
  
  if (props.fill) tcParts.push(`<w:shd w:fill="${props.fill}" w:val="clear"/>`);
  
  const mt = props.headerCell ? '100' : '80';
  const ml = '120';
  const mb = props.headerCell ? '100' : '80';
  const mr = '120';
  tcParts.push(`<w:tcMar><w:top w:type="dxa" w:w="${mt}"/><w:left w:type="dxa" w:w="${ml}"/><w:bottom w:type="dxa" w:w="${mb}"/><w:right w:type="dxa" w:w="${mr}"/></w:tcMar>`);
  
  return `<w:tc><w:tcPr>${tcParts.join('')}</w:tcPr>${content}</w:tc>`;
}

// Helper: build a consolidated metrics comparison table
// Rows = time periods, Columns = Spend/Leads/CPL/CTR
function buildConsolidatedMetricsTable() {
  const cols = [2200, 1800, 1600, 1600, 1600];
  const headers = ['Period', 'Spend', 'Leads', 'CPL', 'CTR'];
  
  const rows = [
    { label: 'This Week',      tags: ['{week_spend}', '{week_leads}', '{week_cpl}', '{week_ctr}'] },
    { label: 'This Month',     tags: ['{month_spend}', '{month_leads}', '{month_cpl}', '{month_ctr}'] },
    { label: 'Since Starting', tags: ['{alltime_spend}', '{alltime_leads}', '{alltime_cpl}', '{alltime_ctr}'] },
  ];
  
  let tbl = `<w:tbl><w:tblPr><w:tblW w:type="pct" w:w="100%"/><w:tblBorders><w:top w:val="single" w:color="E2E8F0" w:sz="4"/><w:left w:val="single" w:color="E2E8F0" w:sz="4"/><w:bottom w:val="single" w:color="E2E8F0" w:sz="4"/><w:right w:val="single" w:color="E2E8F0" w:sz="4"/><w:insideH w:val="single" w:color="E2E8F0" w:sz="4"/><w:insideV w:val="single" w:color="E2E8F0" w:sz="4"/></w:tblBorders></w:tblPr>`;
  tbl += `<w:tblGrid>${cols.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  
  // Header row
  tbl += '<w:tr>';
  headers.forEach((h, i) => {
    tbl += tc(
      para(run(h, { font: 'Arial', bold: true, color: 'FFFFFF', size: '20' }), { jc: i === 0 ? 'left' : 'center' }),
      cols[i],
      { gridSpan: 1, fill: '1E293B', headerCell: true }
    );
  });
  tbl += '</w:tr>';
  
  // Data rows
  rows.forEach((row, rowIdx) => {
    const stripeFill = rowIdx % 2 === 0 ? 'F8FAFC' : 'FFFFFF';
    tbl += '<w:tr>';
    // Period label cell
    tbl += tc(
      para(run(row.label, { font: 'Arial', bold: true, color: '1E293B', size: '20' }), { jc: 'left' }),
      cols[0],
      { fill: stripeFill }
    );
    // Metric value cells
    row.tags.forEach((tag, i) => {
      const isMoney = (i === 0 || i === 2); // Spend, CPL
      const color = (i === 1 || i === 2) ? '10B981' : '1E293B'; // Leads + CPL in green
      tbl += tc(
        para(run(tag, { font: 'Arial', bold: true, color, size: '22' }), { jc: 'center' }),
        cols[i + 1],
        { fill: stripeFill }
      );
    });
    tbl += '</w:tr>';
  });
  
  tbl += '</w:tbl>';
  return tbl;
}

// Helper: build a 7-column ad performance table with loop (includes thumbnail preview)
function buildAdTable(loopOpenTag, loopCloseTag) {
  const t5Cols = [500, 1300, 1400, 1400, 1400, 2360, 800];
  const t5Headers = ['#', 'Release Lot', 'CPL', 'Leads', 'CTR', 'Ad ID', 'Preview'];
  
  let tbl = `<w:tbl><w:tblPr><w:tblW w:type="pct" w:w="100%"/><w:tblBorders><w:top w:val="single" w:color="E2E8F0" w:sz="4"/><w:left w:val="single" w:color="E2E8F0" w:sz="4"/><w:bottom w:val="single" w:color="E2E8F0" w:sz="4"/><w:right w:val="single" w:color="E2E8F0" w:sz="4"/><w:insideH w:val="single" w:color="E2E8F0" w:sz="4"/><w:insideV w:val="single" w:color="E2E8F0" w:sz="4"/></w:tblBorders></w:tblPr>`;
  tbl += `<w:tblGrid>${t5Cols.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  
  // Header row
  tbl += '<w:tr>';
  t5Headers.forEach((h, i) => {
    tbl += tc(
      para(run(h, { font: 'Arial', bold: true, color: 'FFFFFF', size: '20' }), { jc: 'center' }),
      t5Cols[i],
      { gridSpan: 1, fill: '1E293B', headerCell: true }
    );
  });
  tbl += '</w:tr>';

  // Loop row (thumbnail is 7th column with image tag)
  tbl += '<w:tr>';
  const loopFields = [`${loopOpenTag}{rank_icon}`, '{release_lot}', '{cpl}', '{leads}', '{ctr}', '{ad_id}', `{%thumbnail}${loopCloseTag}`];
  loopFields.forEach((field, i) => {
    const jc = (i === 5) ? 'left' : 'center';
    const isBold = (i === 1 || i === 2);
    tbl += tc(
      para(run(field, { font: 'Arial', boldFalse: !isBold, bold: isBold, color: '1E293B', size: '20' }), { jc }),
      t5Cols[i],
      { fill: 'FFFFFF' }
    );
  });
  tbl += '</w:tr>';
  tbl += '</w:tbl>';
  return tbl;
}

// ─── Build Document XML ────────────────────────────────────────────────

function buildDocumentXml() {
  const parts = [];
  parts.push(xmlHeader());
  parts.push(documentOpen());
  parts.push('<w:body>');

  // ── Logo (keeping original image reference rId6)
  parts.push(`<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1333500" cy="247650"/><wp:effectExtent t="0" r="0" b="0" l="0"/><wp:docPr id="1" name="feisty-logo" descr="Feisty Agency Logo" title="Feisty Logo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="" descr=""/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId6" cstate="none"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="1333500" cy="247650"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);

  // ── Title
  parts.push(para(
    run('Meta Ads Performance Audit', { bold: true, color: '1E293B', size: '44' }),
    { style: 'Heading1', spacing: { before: '300', after: '200' } }
  ));

  // ── Client Info
  parts.push(para(
    run('Client: ', { bold: true, color: '475569', size: '22' }) +
    run('{client_name}', { color: '1E293B', size: '22' }),
    { spacing: { after: '120' } }
  ));

  parts.push(para(
    run('Campaign: ', { bold: true, color: '475569', size: '22' }) +
    run('{campaign_name}', { color: '1E293B', size: '22' }),
    { spacing: { after: '120' } }
  ));

  parts.push(para(
    run('Period: ', { bold: true, color: '475569', size: '22' }) +
    run('{period}', { color: '1E293B', size: '22' }),
    { spacing: { after: '300' } }
  ));

  // ── Executive Summary
  parts.push(para(
    run('Executive Summary', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  parts.push(para(
    run('{executive_summary}', { color: '475569', size: '22' }),
    { spacing: { after: '300' } }
  ));

  // ══════════════════════════════════════════════════════════════════════
  // KEY METRICS — CONSOLIDATED TABLE
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Key Metrics', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  parts.push(buildConsolidatedMetricsTable());
  parts.push(para('', { spacing: { after: '300' } }));

  // ══════════════════════════════════════════════════════════════════════
  // LATEST BATCH — TOP PERFORMERS
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Latest Batch — Top Performers', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  parts.push(buildAdTable('{#latest_batch_ads}', '{/latest_batch_ads}'));
  parts.push(para('', { spacing: { after: '300' } }));

  // ══════════════════════════════════════════════════════════════════════
  // TOP 5 PERFORMERS BY CPL — ALL TIME
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Top 5 Performers by CPL — All Time', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  parts.push(buildAdTable('{#top_ads}', '{/top_ads}'));

  // Table footnote
  parts.push(para(
    run('{table_footnote}', { italic: true, color: '475569', size: '18' }),
    { spacing: { before: '100', after: '300' } }
  ));

  // ══════════════════════════════════════════════════════════════════════
  // RELEASE LOT PERFORMANCE
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Release Lot Performance', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  // Paragraph-level loop: each item gets its own paragraph with line break
  parts.push(para(run('{#release_lots}'), { spacing: { after: '0' } }));
  parts.push(para(
    run('• {title}: ', { bold: true, color: '1E293B', size: '22' }) +
    run('{description}', { color: '475569', size: '22' }),
    { spacing: { after: '80' } }
  ));
  parts.push(para(run('{/release_lots}'), { spacing: { after: '0' } }));
  parts.push(para('', { spacing: { after: '200' } }));

  // ══════════════════════════════════════════════════════════════════════
  // CREATIVE INSIGHTS
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Creative Insights', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  parts.push(para(run('{#creative_insights}'), { spacing: { after: '0' } }));
  parts.push(para(
    run('{title}', { bold: true, color: '1E293B', size: '22' }),
    { spacing: { after: '40' } }
  ));
  parts.push(para(
    run('{description}', { color: '475569', size: '22' }),
    { spacing: { after: '120' } }
  ));
  parts.push(para(run('{/creative_insights}'), { spacing: { after: '0' } }));
  parts.push(para('', { spacing: { after: '200' } }));

  // ══════════════════════════════════════════════════════════════════════
  // DEMOGRAPHIC SWEET SPOT
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Demographic Sweet Spot', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  parts.push(para(run('{#demographics}'), { spacing: { after: '0' } }));
  parts.push(para(
    run('• {title}: ', { bold: true, color: '1E293B', size: '22' }) +
    run('{description}', { color: '475569', size: '22' }),
    { spacing: { after: '80' } }
  ));
  parts.push(para(run('{/demographics}'), { spacing: { after: '0' } }));
  parts.push(para('', { spacing: { after: '200' } }));

  // ══════════════════════════════════════════════════════════════════════
  // KEY INSIGHTS
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Key Insights', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));

  parts.push(para(
    run("What's Working:", { bold: true, color: '10B981', size: '24' }),
    { spacing: { after: '80' } }
  ));
  parts.push(para(run('{#whats_working}'), { spacing: { after: '0' } }));
  parts.push(para(
    run('✓ {text}', { color: '475569', size: '22' }),
    { spacing: { after: '80' } }
  ));
  parts.push(para(run('{/whats_working}'), { spacing: { after: '0' } }));

  parts.push(para('', { spacing: { after: '120' } }));

  parts.push(para(
    run('Opportunities:', { bold: true, color: '1E293B', size: '24' }),
    { spacing: { after: '80' } }
  ));
  parts.push(para(run('{#opportunities}'), { spacing: { after: '0' } }));
  parts.push(para(
    run('→ {text}', { color: '475569', size: '22' }),
    { spacing: { after: '80' } }
  ));
  parts.push(para(run('{/opportunities}'), { spacing: { after: '0' } }));
  parts.push(para('', { spacing: { after: '200' } }));

  // ══════════════════════════════════════════════════════════════════════
  // RECOMMENDED NEXT STEPS
  // ══════════════════════════════════════════════════════════════════════
  parts.push(para(
    run('Recommended Next Steps', { bold: true, color: '1E293B', size: '28' }),
    { style: 'Heading2', spacing: { before: '200', after: '120' } }
  ));
  parts.push(para(run('{#next_steps}'), { spacing: { after: '0' } }));
  parts.push(para(
    run('▸ {text}', { color: '475569', size: '22' }),
    { spacing: { after: '80' } }
  ));
  parts.push(para(run('{/next_steps}'), { spacing: { after: '0' } }));
  parts.push(para('', { spacing: { after: '300' } }));

  // ── Chart Image (using docxtemplater-image-module tag)
  parts.push(para(run('{%chart_image}'), { jc: 'center' }));
  parts.push(para('', { spacing: { after: '300' } }));

  // ── Footer
  parts.push(para(
    run("Questions? Let's chat about scaling these results.", { italic: true, color: '475569', size: '22' }),
    { spacing: { before: '300' }, jc: 'center' }
  ));

  // Section properties
  parts.push(`<w:sectPr><w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="708" w:footer="708" w:gutter="0"/><w:pgNumType/><w:docGrid w:linePitch="360"/></w:sectPr>`);
  
  parts.push('</w:body>');
  parts.push('</w:document>');

  return parts.join('');
}


// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  console.log('Reading original template:', TEMPLATE_PATH);
  const content = fs.readFileSync(TEMPLATE_PATH);
  const zip = new PizZip(content);

  // Replace document.xml with our tagged version
  const newDocXml = buildDocumentXml();
  zip.file('word/document.xml', newDocXml);

  console.log('Writing tagged template:', OUTPUT_PATH);
  const output = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(OUTPUT_PATH, output);
  
  console.log('✅ Tagged template created successfully!');
  console.log('Template tags:');
  console.log('  {client_name}, {campaign_name}, {period}');
  console.log('  {executive_summary}');
  console.log('  Week:    {week_spend}, {week_leads}, {week_cpl}, {week_ctr}');
  console.log('  Month:   {month_spend}, {month_leads}, {month_cpl}, {month_ctr}');
  console.log('  AllTime: {alltime_spend}, {alltime_leads}, {alltime_cpl}, {alltime_ctr}');
  console.log('  {#latest_batch_ads}...{/latest_batch_ads} loop');
  console.log('  {#top_ads}...{/top_ads} loop');
  console.log('  {#release_lots}, {#creative_insights}, {#demographics}');
  console.log('  {#whats_working}, {#opportunities}, {#next_steps}');
  console.log('  {%chart_image} (image module)');
  console.log('  {table_footnote}');
}

main();
