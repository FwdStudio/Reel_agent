#!/usr/bin/env node
/**
 * orchestrate.js
 *
 * L'ultimo pezzo della catena: prende i reel "in coda" (uno per cartella,
 * ognuno con un manifest.json), per ognuno genera la voce (Edge TTS),
 * assembla il video (Reel Animator via Puppeteer), e pubblica il risultato
 * nella pagina di riepilogo statica (docs/) — pronta per essere pubblicata
 * su GitHub Pages, dove tu scarichi il video e copi la caption a mano.
 *
 * STRUTTURA CARTELLE ATTESA:
 *
 *   queue/
 *     2026-08-05-fordy-misterboard/
 *       manifest.json
 *       frame1.jpg
 *       frame2.jpg
 *       bgmusic.mp3        (opzionale)
 *
 *   docs/                  <- questa è la cartella da pubblicare su GitHub Pages
 *     index.html           (pagina di riepilogo, fornita separatamente)
 *     reels.json           (manifest che alimenta la pagina — aggiornato da questo script)
 *     reels/
 *       2026-08-05-fordy-misterboard.mp4
 *
 * manifest.json — esempio:
 * {
 *   "pageUrl": "https://fwdstudio.github.io/reel-animator/index.html",
 *   "script": "Testo che Fordy legge nel reel...",
 *   "caption": "Testo della caption/didascalia per Instagram, con hashtag.",
 *   "voice": "it-IT-DiegoNeural",
 *   "images": [
 *     { "file": "frame1.jpg", "duration": 3, "effect": "zoom-in" },
 *     { "file": "frame2.jpg", "duration": 3.5, "effect": "pan-right" }
 *   ],
 *   "music": { "file": "bgmusic.mp3" },
 *   "texts": [
 *     { "text": "Fordy presenta Mister Board", "start": 0, "end": 2.5, "position": "bottom" }
 *   ]
 * }
 *
 * USO:
 *   node orchestrate.js
 *   (processa tutte le cartelle dentro queue/ e le sposta in queue/done/ una volta fatte)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const QUEUE_DIR = path.join(__dirname, 'queue');
const DONE_DIR = path.join(QUEUE_DIR, 'done');
const DOCS_DIR = path.join(__dirname, 'docs');
const REELS_DIR = path.join(DOCS_DIR, 'reels');
const REELS_JSON = path.join(DOCS_DIR, 'reels.json');

function readReelsManifest() {
  if (!fs.existsSync(REELS_JSON)) return [];
  return JSON.parse(fs.readFileSync(REELS_JSON, 'utf8'));
}

function writeReelsManifest(list) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(REELS_JSON, JSON.stringify(list, null, 2));
}

function processReelFolder(folderName) {
  const folderPath = path.join(QUEUE_DIR, folderName);
  const manifestPath = path.join(folderPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn(`⚠️  Salto "${folderName}": nessun manifest.json trovato.`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\n=== Elaboro: ${folderName} ===`);

  // ---- 1. Voce ----
  const voicePath = path.join(folderPath, 'voiceover.mp3');
  if (manifest.script) {
    console.log('Genero la voce…');
    execFileSync('node', [
      path.join(__dirname, 'generate-voice.js'),
      manifest.script,
      voicePath,
      ...(manifest.voice ? ['--voice', manifest.voice] : [])
    ], { stdio: 'inherit' });
  }

  // ---- 2. Config per generate-reel.js ----
  const config = {
    pageUrl: manifest.pageUrl,
    images: (manifest.images || []).map(im => ({
      path: path.join(folderPath, im.file),
      duration: im.duration,
      effect: im.effect,
      transition: im.transition,
      trimStart: im.trimStart,
      trimEnd: im.trimEnd,
      includeAudio: im.includeAudio
    })),
    voice: manifest.script ? { path: voicePath } : undefined,
    music: manifest.music ? { path: path.join(folderPath, manifest.music.file), name: manifest.music.file } : undefined,
    texts: manifest.texts || []
  };
  const configPath = path.join(folderPath, 'config.generated.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // ---- 3. Assembla il video ----
  console.log('Assemblo il video (Puppeteer + Reel Animator)…');
  fs.mkdirSync(REELS_DIR, { recursive: true });
  const outputPath = path.join(REELS_DIR, `${folderName}.mp4`);
  execFileSync('node', [
    path.join(__dirname, 'generate-reel.js'),
    configPath,
    outputPath
  ], { stdio: 'inherit' });

  // ---- 4. Aggiorna reels.json (la pagina di riepilogo lo legge) ----
  const reels = readReelsManifest();
  reels.unshift({
    id: folderName,
    video: `reels/${path.basename(outputPath)}`,
    caption: manifest.caption || '',
    createdAt: new Date().toISOString()
  });
  writeReelsManifest(reels);

  // ---- 5. Sposta la cartella tra i completati ----
  fs.mkdirSync(DONE_DIR, { recursive: true });
  fs.renameSync(folderPath, path.join(DONE_DIR, folderName));

  console.log(`✅ Pronto: docs/reels/${folderName}.mp4`);
}

function main() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const entries = fs.readdirSync(QUEUE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'done');

  if (entries.length === 0) {
    console.log('Nessun reel in coda (cartella queue/ vuota).');
    return;
  }

  entries.forEach(e => processReelFolder(e.name));
  console.log(`\nFatto. ${entries.length} reel elaborati — vedi docs/reels.json.`);
}

main();
