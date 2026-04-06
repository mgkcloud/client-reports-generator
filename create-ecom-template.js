const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const TEMPLATE_DIR = '/home/mgk/clawd/client-reports';
const INPUT_TEMPLATE = path.join(TEMPLATE_DIR, 'template_tagged.docx');
const OUTPUT_TEMPLATE = path.join(TEMPLATE_DIR, 'template_tagged_ecom.docx');

// Read the template
const content = fs.readFileSync(INPUT_TEMPLATE, 'binary');
const zip = new PizZip(content);

// Extract the document.xml to see the tags
const docXml = zip.file('word/document.xml').asText();

// Key replacements for e-commerce:
const replacements = [
  // Section headers
  { from: 'Cost Per Lead (CPL)', to: 'Cost Per Purchase (CPP)' },
  { from: 'Lead Generation', to: 'E-Commerce Performance' },
  { from: 'Leads per Week', to: 'Purchases per Week' },
  { from: 'Weekly Leads', to: 'Weekly Purchases' },
  
  // Metric labels
  { from: 'Total Leads', to: 'Total Purchases' },
  { from: 'Month Leads', to: 'Month Purchases' },
  { from: 'All-time Leads', to: 'All-time Purchases' },
  
  // Table headers
  { from: 'Leads', to: 'Purchases' },
  { from: 'CPL', to: 'CPP' },
  
  // Add ROAS references (will add new section)
];

// Apply replacements
let modifiedXml = docXml;
for (const repl of replacements) {
  modifiedXml = modifiedXml.split(repl.from).join(repl.to);
}

// Add ROAS section after CTR in key metrics
// Look for the CTR row and add ROAS after it
const ctrPattern = /(<w:tr[^>]*>.*?CTR.*?<w:t[^>]*>){%CTR%}(<\/w:t>.*?<\/w:tr>)/gs;
const roasRow = `$1<w:tr>
<w:tc>
<w:p>
<w:r>
<w:t>ROAS:</w:t>
</w:r>
</w:p>
</w:tc>
<w:tc>
<w:p>
<w:r>
<w:t>{%roas_week%}x</w:t>
</w:r>
</w:p>
</w:tc>
<w:tc>
<w:p>
<w:r>
<w:t>{%roas_month%}x</w:t>
</w:r>
</w:p>
</w:tc>
<w:tc>
<w:p>
<w:r>
<w:t>{%roas_alltime%}x</w:t>
</w:r>
</w:p>
</w:tc>
</w:tr>
<w:tr>
<w:tc>
<w:p>
<w:r>
<w:t>Revenue:</w:t>
</w:r>
</w:p>
</w:tc>
<w:tc>
<w:p>
<w:r>
<w:t>{%revenue_week%}</w:t>
</w:r>
</w:p>
</w:tc>
<w:tc>
<w:p>
<w:r>
<w:t>{%revenue_month%}</w:t>
</w:r>
</w:p>
</w:tc>
<w:tc>
<w:p>
<w:r>
<w:t>{%revenue_alltime%}</w:t>
</w:r>
</w:p>
</w:tc>
</w:tr>$2`;

modifiedXml = modifiedXml.replace(ctrPattern, roasRow);

// Update the zip with modified document.xml
zip.file('word/document.xml', modifiedXml);

// Generate the new template
const output = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

// Write the new template
fs.writeFileSync(OUTPUT_TEMPLATE, output);

console.log('✅ Created e-commerce template: template_tagged_ecom.docx');
console.log('Key changes:');
console.log('  - Leads → Purchases');
console.log('  - CPL → CPP (Cost Per Purchase)');
console.log('  - Added ROAS metrics (week/month/all-time)');
console.log('  - Added Revenue metrics');
