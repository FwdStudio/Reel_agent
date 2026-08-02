#!/usr/bin/env node
/**
 * generate-reel.js
 *
 * Pilota Reel Animator (tramite window.ReelAnimatorAPI) con Puppeteer per
 * assemblare un reel in automatico, partendo da un file di configurazione
 * JSON con immagini/video, voce (es. generata con Edge TTS), musica e testi.
 *
 * USO:
 *   node generate-reel.js config.json output/reel-2026-08-05.mp4
 *
 * config.json — esempio:
 * {
 *   "pageUrl": "https://fwdstudio.github.io/reel-animator/index.html",
 *   "images": [
 *     { "path": "assets/frame1.jpg", "duration": 3, "effect": "zoom-in", "transition": "dissolve" },
 *     { "path": "assets/frame2.jpg", "duration": 3.5, "effect": "pan-right" }
 *   ],
 *   "voice": { "path": "assets/voiceover.wav" },
 *   "music": { "path": "assets/bgmusic.mp3", "name": "traccia.mp3" },
 *   "texts": [
 *     { "text": "Fordy presenta Mister Board", "start": 0, "end": 2.5, "position": "bottom" }
 *   ]
 * }
 *
 * Note:
 * - "pageUrl" può essere l'URL pubblico su GitHub Pages oppure un path
 *   locale tipo "file:///home/tuo-utente/reel-animator/index.html" per i test.
 * - Tutti i path dentro "images"/"voice"/"music" sono relativi alla cartella
 *   da cui lanci lo script (o assoluti).
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function fileToDataURL(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeByExt = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg'
  };
  const mime = mimeByExt[ext];
  if (!mime) throw new Error(`Estensione non riconosciuta per ${filePath} (${ext})`);
  const data = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${data}`;
}

async function main() {
  const [, , configPath, outputPath] = process.argv;
  if (!configPath || !outputPath) {
    console.error('Uso: node generate-reel.js config.json output/reel.mp4');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.pageUrl) throw new Error('config.json deve specificare "pageUrl"');

  console.log('Avvio browser headless…');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream']
    // --use-fake-ui-for-media-stream evita eventuali prompt di permesso
    // microfono, anche se con la nuova API non dovremmo mai registrare dal vivo.
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 }); // dimensioni "telefono"

    page.on('console', msg => console.log('  [pagina]', msg.text()));
    page.on('pageerror', err => console.error('  [errore pagina]', err.message));

    console.log(`Apro ${config.pageUrl} …`);
    await page.goto(config.pageUrl, { waitUntil: 'networkidle0' });

    // Aspetta che l'API sia effettivamente disponibile prima di procedere.
    await page.waitForFunction('window.ReelAnimatorAPI !== undefined', { timeout: 10000 });

    // ---- 1. Immagini e video ----
    for (const item of (config.images || [])) {
      const dataUrl = fileToDataURL(item.path);
      const isVideo = dataUrl.startsWith('data:video/');
      console.log(`Aggiungo ${isVideo ? 'video' : 'immagine'}: ${item.path}`);
      await page.evaluate(async (dataUrl, isVideo, opts) => {
        if (isVideo) {
          await window.ReelAnimatorAPI.addVideoFromDataURL(dataUrl, opts);
        } else {
          await window.ReelAnimatorAPI.addImageFromDataURL(dataUrl, opts);
        }
        // Piccola pausa per lasciare che onload/onloadedmetadata scattino
        // prima di passare al file successivo (evita race condition).
        await new Promise(r => setTimeout(r, 300));
      }, dataUrl, isVideo, {
        duration: item.duration,
        effect: item.effect,
        transition: item.transition,
        trimStart: item.trimStart,
        trimEnd: item.trimEnd,
        includeAudio: item.includeAudio
      });
    }

    // ---- 2. Voce (es. narrazione generata con Edge TTS) ----
    if (config.voice && config.voice.path) {
      console.log(`Carico voce: ${config.voice.path}`);
      const voiceDataUrl = fileToDataURL(config.voice.path);
      await page.evaluate(async (dataUrl) => {
        await window.ReelAnimatorAPI.setVoiceFromDataURL(dataUrl);
      }, voiceDataUrl);
    }

    // ---- 3. Musica di sottofondo ----
    if (config.music && config.music.path) {
      console.log(`Carico musica: ${config.music.path}`);
      const musicDataUrl = fileToDataURL(config.music.path);
      await page.evaluate(async (dataUrl, name) => {
        window.ReelAnimatorAPI.setMusicFromDataURL(dataUrl, name);
      }, musicDataUrl, config.music.name || path.basename(config.music.path));
    }

    // ---- 4. Testi/sottotitoli ----
    for (const t of (config.texts || [])) {
      console.log(`Aggiungo testo: "${t.text}"`);
      await page.evaluate((opts) => {
        window.ReelAnimatorAPI.addTextOverlay(opts);
      }, t);
    }

    // ---- 5. Export ----
    console.log('Avvio export (può richiedere qualche decina di secondi, dipende dalla durata del reel)…');
    const result = await page.evaluate(async () => {
      return await window.ReelAnimatorAPI.triggerExport();
    });

    // ---- 6. Salva il file su disco ----
    const base64 = result.dataUrl.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const finalPath = outputPath.endsWith(`.${result.ext}`)
      ? outputPath
      : outputPath.replace(/\.[^.]+$/, '') + `.${result.ext}`;
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, buffer);

    console.log(`✅ Video salvato in: ${finalPath}`);
    console.log(`   Formato: ${result.mime} · Audio incluso: ${result.includesAudio ? 'sì' : 'no'}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Errore:', err);
  process.exit(1);
});
