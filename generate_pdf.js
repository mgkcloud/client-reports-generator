
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
