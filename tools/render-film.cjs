// Optional asset regeneration: npm install --no-save playwright; install ffmpeg;
// start Bat Mode, then node tools/render-film.cjs. Runtime needs neither tool.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    // This page is an asset renderer, not an application test.
    await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.goto(process.argv[2] || 'http://127.0.0.1:8765');
    await page.evaluate(async () => {
      const { Sculpture } = await import('/scene.js');
      const canvas = document.createElement('canvas');
      canvas.style.width = '960px'; canvas.style.height = '540px';
      document.body.replaceChildren(canvas);
      window.filmCanvas = canvas; window.filmSculpture = new Sculpture(canvas);
    });
    const output = path.join(__dirname, '..', 'batmode', 'static', 'bloom.mp4');
    const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-g', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { stdio: ['pipe', 'inherit', 'inherit'] });
    const complete = once(ffmpeg, 'close');
    for (let frame = 0; frame < 180; frame++) {
      const png = await page.evaluate(t => {
        window.filmSculpture.draw(t, 'bloom', 1);
        return window.filmCanvas.toDataURL('image/png').split(',')[1];
      }, frame / 179);
      if (!ffmpeg.stdin.write(Buffer.from(png, 'base64'))) await once(ffmpeg.stdin, 'drain');
    }
    ffmpeg.stdin.end();
    const [code] = await complete;
    if (code) throw Error(`ffmpeg exited with ${code}`);
    console.log(`Rendered original 6-second, all-intra film: ${output}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
