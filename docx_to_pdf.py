#!/usr/bin/env python3
"""
Convert DOCX to PDF by first converting to HTML with mammoth, then using Puppeteer
This preserves the DOCX formatting better than raw HTML
"""

import sys
import os
import json
import subprocess
from pathlib import Path

def docx_to_html(docx_path: str) -> str:
    """Convert DOCX to HTML using mammoth

    Args:
        docx_path: Path to DOCX file

    Returns:
        HTML string
    """
    import mammoth

    with open(docx_path, "rb") as docx_file:
        result = mammoth.convert_to_html(docx_file)
        html = result.value
        messages = result.messages

        if messages:
            print(f"Conversion messages: {messages}", file=sys.stderr)

        return html

def docx_to_pdf_via_puppeteer(docx_path: str, output_pdf: str = None) -> str:
    """Convert DOCX to PDF using mammoth + Puppeteer

    Args:
        docx_path: Path to DOCX file
        output_pdf: Optional output PDF path

    Returns:
        Path to generated PDF
    """
    docx_path = Path(docx_path).resolve()

    if not docx_path.exists():
        raise FileNotFoundError(f"DOCX file not found: {docx_path}")

    if output_pdf is None:
        output_pdf = docx_path.with_suffix(".pdf")
    else:
        output_pdf = Path(output_pdf).resolve()

    # Convert DOCX to HTML
    html = docx_to_html(docx_path)

    # Create styled HTML document
    styled_html = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

        body {{
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            line-height: 1.6;
            color: #2d3436;
            max-width: 900px;
            margin: 0 auto;
            padding: 40px;
        }}

        table {{
            border-collapse: collapse;
            width: 100%;
            margin: 20px 0;
        }}

        td, th {{
            border: 1px solid #ddd;
            padding: 12px;
            text-align: left;
        }}

        h1, h2, h3, h4 {{
            margin-top: 24px;
            margin-bottom: 16px;
            font-weight: 600;
        }}

        p {{
            margin: 12px 0;
        }}

        strong {{
            font-weight: 600;
        }}
    </style>
</head>
<body>
    {html}
</body>
</html>
    """

    # Write HTML to temp file
    temp_html = Path("/tmp") / f"docx-{os.getpid()}-{int(Path(docx_path).stat().st_mtime)}.html"
    temp_html.write_text(styled_html, encoding="utf-8")

    try:
        # Use Puppeteer Node script to generate PDF
        node_script = Path(__file__).parent / "generate_pdf.js"

        if not node_script.exists():
            # Create Node.js script
            node_script.write_text("""
const puppeteer = require('puppeteer');

const htmlPath = process.argv[2];
const pdfPath = process.argv[3];

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, {
        waitUntil: 'networkidle0',
        timeout: 30000
    });

    const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
            top: '0.5cm',
            right: '0.5cm',
            bottom: '0.5cm',
            left: '0.5cm'
        }
    });

    require('fs').writeFileSync(pdfPath, pdf);
    await browser.close();

    console.log(JSON.stringify({success: true, path: pdfPath}));
})();
""")

        # Run Node.js script
        result = subprocess.run(
            ["node", str(node_script), str(temp_html), str(output_pdf)],
            capture_output=True,
            text=True,
            timeout=60
        )

        if result.returncode != 0:
            raise RuntimeError(f"Puppeteer failed: {result.stderr}")

        # Cleanup
        temp_html.unlink()

        if not output_pdf.exists():
            raise RuntimeError("PDF was not created")

        return str(output_pdf)

    except Exception as e:
        # Cleanup on error
        if temp_html.exists():
            temp_html.unlink()
        raise e


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: docx_to_pdf.py <input.docx> [output.pdf]")
        sys.exit(1)

    input_docx = sys.argv[1]
    output_pdf = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        result = docx_to_pdf_via_puppeteer(input_docx, output_pdf)
        print(f"✓ PDF created: {result}")
    except Exception as e:
        print(f"✗ Error: {e}", file=sys.stderr)
        sys.exit(1)
