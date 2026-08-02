#!/usr/bin/env node
/**
 * generate-content.js
 *
 * Il "cervello" dello scheduler: decide il tema del prossimo reel
 * (alternando Fordy-testimonial e presentazione-prodotto), genera script +
 * caption con Gemini, genera l'immagine di Fordy (o fa lo screenshot della
 * PWA per i reel prodotto), e scrive tutto già pronto in una cartella
 * dentro queue/ — che orchestrate.js poi trasforma nel video finito.
 *
 * REQUISITI UNA TANTUM (da fare tu, una sola volta):
 *   - una variabile d'ambiente GEMINI_API_KEY con la tua chiave gratuita
 *     da Google AI Studio (https://aistudio.google.com/apikey)
 *   - fordy-brief.json compilato (tono di voce + immagine di riferimento di Fordy)
 *   - products.json compilato con le tue PWA (nome, URL pubblico, descrizione)
 *   - un history.json (creato automaticamente) per non ripetere gli stessi temi
 *
 * NOTA: il nome del modello Gemini per la generazione immagini ("Nano
 * Banana", attualmente gemini-2.5-flash-image) può cambiare nel tempo —
 * controlla la pagina "Image generation" di ai.google.dev se lo script
 * smette di funzionare, e aggiorna la costante IMAGE_MODEL qui sotto.
 *
 * USO:
 *   node generate-content.js fordy
 *   node generate-content.js prodotto
 *   node generate-content.js auto      (alterna da solo in base alla cronologia)
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const puppeteer = require('puppeteer');

const TEXT_MODEL = 'gemini-2.5-flash';
const IMAGE_MODEL = 'gemini-2.5-flash-image'; // verificare su ai.google.dev se cambia

const ROOT = __dirname;
const QUEUE_DIR = path.join(ROOT, 'queue');
const HISTORY_PATH = path.join(ROOT, 'history.json');
const FORDY_BRIEF_PATH = path.join(ROOT, 'fordy-brief.json');
const PRODUCTS_PATH = path.join(ROOT, 'products.json');
const PAGE_URL = process.env.REEL_ANIMATOR_URL || 'https://fwdstudio.github.io/reel-animator/index.html';

function readJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function slugify(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Manca la variabile d\'ambiente GEMINI_API_KEY.');
  return new GoogleGenAI({ apiKey });
}

// Chiede a Gemini di scrivere script + caption in JSON, dato un brief testuale.
async function generateScriptAndCaption(ai, brief) {
  const prompt = `Sei un copywriter social per un brand chiamato Fwd Studio.
${brief}

Rispondi SOLO con un oggetto JSON valido, senza markdown, con questa forma esatta:
{"script": "...", "caption": "..."}
- "script": il testo che verrà letto a voce alta nel reel (15-25 secondi di parlato)
- "caption": la didascalia da pubblicare su Instagram, con 3-5 hashtag pertinenti in italiano`;

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: prompt
  });
  const text = response.text.trim().replace(/^```json\s*|```$/g, '');
  return JSON.parse(text);
}

// Genera un'immagine di Fordy con Gemini, usando l'immagine di riferimento
// per mantenere lo stesso personaggio (stessa tecnica che già usi a mano).
async function generateFordyImage(ai, referenceImagePath, scenePrompt) {
  const imageBytes = fs.readFileSync(referenceImagePath);
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [
      { text: `Usa la stessa persona/personaggio dell'immagine allegata. Scena: ${scenePrompt}. Formato verticale 9:16, stile coerente con un reel Instagram.` },
      { inlineData: { mimeType: 'image/jpeg', data: imageBytes.toString('base64') } }
    ]
  });
  const parts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);
  if (!imagePart) throw new Error('Gemini non ha restituito un\'immagine.');
  return Buffer.from(imagePart.inlineData.data, 'base64');
}

// Screenshot dal vivo di una PWA pubblica, per i reel "presentazione prodotto".
async function screenshotProduct(url) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 }); // proporzioni iPhone
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500)); // lascia assestare eventuali animazioni
    return await page.screenshot({ type: 'jpeg', quality: 90 });
  } finally {
    await browser.close();
  }
}

function decideNextType(history) {
  const last = history.length ? history[history.length - 1].type : null;
  return last === 'fordy' ? 'prodotto' : 'fordy';
}

async function buildFordyReel(ai, history) {
  const brief = readJSON(FORDY_BRIEF_PATH, null);
  if (!brief) throw new Error('Manca fordy-brief.json (vedi fordy-brief.example.json).');

  const usedThemes = history.filter(h => h.type === 'fordy').map(h => h.theme).slice(-8);
  const { script, caption } = await generateScriptAndCaption(ai,
    `${brief.toneBrief}\n\nTemi già usati di recente (evita di ripeterli): ${usedThemes.join(', ') || 'nessuno'}.\nInventa un nuovo angolo/tema per questo reel testimonial.`
  );

  // Chiediamo a Gemini anche una breve descrizione della scena, riusando lo script.
  const scenePrompt = `Fordy che parla a camera, espressione ${['sorridente','entusiasta','complice'][Math.floor(Math.random()*3)]}, ambientazione semplice e pulita, coerente con: "${script.slice(0, 80)}..."`;
  const imageBuffer = await generateFordyImage(ai, path.join(ROOT, brief.referenceImage), scenePrompt);

  const slug = `${todayStr()}-fordy-${slugify(script.slice(0, 24))}`;
  const folder = path.join(QUEUE_DIR, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'frame1.jpg'), imageBuffer);

  const manifest = {
    pageUrl: PAGE_URL,
    script,
    caption,
    voice: 'it-IT-DiegoNeural',
    images: [{ file: 'frame1.jpg', duration: 6, effect: 'zoom-in' }],
    texts: []
  };
  writeJSON(path.join(folder, 'manifest.json'), manifest);

  return { slug, theme: script.slice(0, 60) };
}

async function buildProductReel(ai, history) {
  const products = readJSON(PRODUCTS_PATH, null);
  if (!products || !products.length) throw new Error('Manca products.json (vedi products.example.json).');

  const usedSlugs = history.filter(h => h.type === 'prodotto').map(h => h.productSlug);
  const lastUsed = usedSlugs.length ? usedSlugs[usedSlugs.length - 1] : null;
  const idx = products.findIndex(p => p.slug === lastUsed);
  const next = products[(idx + 1) % products.length]; // round-robin

  const type = next.type || 'pwa'; // retrocompatibile: le voci senza "type" restano PWA

  const promptExtra = type === 'book'
    ? `Scrivi un reel che presenta questo libro: "${next.name}" — ${next.description}\nMetti in risalto un beneficio concreto per chi lo legge, con un hook nei primi 2 secondi. Chiudi con una call-to-action verso il link in Amazon/bio.`
    : `Scrivi un reel che presenta questa app: "${next.name}" — ${next.description}\nMetti in risalto un beneficio concreto per chi la usa, con un hook nei primi 2 secondi.`;

  const { script, caption } = await generateScriptAndCaption(ai, promptExtra);

  // Per le PWA facciamo uno screenshot dal vivo; per i libri usiamo la
  // copertina già pronta (nessuna pagina web da fotografare).
  const imageBuffer = type === 'book'
    ? fs.readFileSync(path.join(ROOT, next.coverImage))
    : await screenshotProduct(next.url);

  const slug = `${todayStr()}-prodotto-${next.slug}`;
  const folder = path.join(QUEUE_DIR, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'frame1.jpg'), imageBuffer);

  const manifest = {
    pageUrl: PAGE_URL,
    script,
    caption,
    voice: 'it-IT-DiegoNeural',
    images: [{ file: 'frame1.jpg', duration: 6, effect: type === 'book' ? 'zoom-in' : 'pan-up' }],
    texts: [{ text: next.name, start: 0, end: 2, position: 'top' }]
  };
  writeJSON(path.join(folder, 'manifest.json'), manifest);

  return { slug, productSlug: next.slug };
}

async function main() {
  const mode = process.argv[2] || 'auto';
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const history = readJSON(HISTORY_PATH, []);
  const ai = getAI();

  const type = mode === 'auto' ? decideNextType(history) : mode;
  console.log(`Genero un reel di tipo: ${type}`);

  let result;
  if (type === 'fordy') {
    result = await buildFordyReel(ai, history);
    history.push({ type: 'fordy', theme: result.theme, date: todayStr() });
  } else if (type === 'prodotto') {
    result = await buildProductReel(ai, history);
    history.push({ type: 'prodotto', productSlug: result.productSlug, date: todayStr() });
  } else {
    throw new Error(`Tipo sconosciuto: ${type} (usa fordy, prodotto o auto)`);
  }

  writeJSON(HISTORY_PATH, history);
  console.log(`✅ Reel messo in coda: queue/${result.slug}/`);
  console.log('   Lancia ora "node orchestrate.js" per montarlo.');
}

main().catch(err => {
  console.error('Errore:', err);
  process.exit(1);
});
