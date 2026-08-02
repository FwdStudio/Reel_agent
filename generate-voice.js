#!/usr/bin/env node
/**
 * generate-voice.js
 *
 * Genera un file audio di narrazione in italiano usando le voci neurali
 * gratuite di Microsoft Edge (via il pacchetto npm "msedge-tts"), da
 * collegare poi a generate-reel.js come voce del reel.
 *
 * USO:
 *   node generate-voice.js "Il testo da leggere" output/voiceover.mp3
 *   node generate-voice.js --file script.txt output/voiceover.mp3
 *   node generate-voice.js --list-voices        (elenca le voci italiane disponibili)
 *
 * Opzioni:
 *   --voice <nome>   Voce da usare (default: it-IT-DiegoNeural)
 *                     Altre voci italiane comuni: it-IT-ElsaNeural, it-IT-IsabellaNeural
 *   --rate <valore>  Velocità, es. "+10%" o "-5%" (default: nessuna modifica)
 *   --pitch <valore> Tono, es. "+2Hz" o "-2Hz" (default: nessuna modifica)
 *
 * Nota: msedge-tts non è un servizio ufficiale Microsoft — è una libreria
 * che dialoga con lo stesso endpoint usato dalla funzione "Leggi ad alta
 * voce" di Edge. È gratuita e senza chiave API, ma non essendo un prodotto
 * ufficiale può cambiare o smettere di funzionare senza preavviso.
 */

const fs = require('fs');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const DEFAULT_VOICE = 'it-IT-DiegoNeural';

function parseArgs(argv) {
  const args = { voice: DEFAULT_VOICE, rate: undefined, pitch: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') { args.voice = argv[++i]; }
    else if (a === '--rate') { args.rate = argv[++i]; }
    else if (a === '--pitch') { args.pitch = argv[++i]; }
    else if (a === '--file') { args.textFile = argv[++i]; }
    else if (a === '--list-voices') { args.listVoices = true; }
    else { positional.push(a); }
  }
  args.text = positional[0];
  args.outputPath = positional[1];
  return args;
}

async function listItalianVoices() {
  const tts = new MsEdgeTTS();
  const voices = await tts.getVoices();
  const italian = voices.filter(v => v.Locale.startsWith('it-'));
  console.log('Voci italiane disponibili:');
  italian.forEach(v => console.log(`  ${v.ShortName}  (${v.Gender})`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.listVoices) {
    await listItalianVoices();
    return;
  }

  let text = args.text;
  if (args.textFile) {
    text = fs.readFileSync(args.textFile, 'utf8');
  }
  if (!text || !args.outputPath) {
    console.error('Uso: node generate-voice.js "testo" output/voiceover.mp3');
    console.error('     node generate-voice.js --file script.txt output/voiceover.mp3');
    console.error('     node generate-voice.js --list-voices');
    process.exit(1);
  }

  console.log(`Genero narrazione con voce "${args.voice}"…`);
  const tts = new MsEdgeTTS();
  await tts.setMetadata(args.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  const outDir = path.dirname(args.outputPath);
  const baseName = path.basename(args.outputPath, path.extname(args.outputPath));

  const result = await tts.toFile(path.join(outDir, baseName), text, {
    rate: args.rate,
    pitch: args.pitch
  });

  // msedge-tts salva come <baseName>.mp3 accanto a un file .json di metadati
  const producedPath = path.join(outDir, `${baseName}.mp3`);
  const finalPath = args.outputPath.endsWith('.mp3') ? args.outputPath : `${args.outputPath}.mp3`;
  if (producedPath !== finalPath) fs.renameSync(producedPath, finalPath);

  console.log(`✅ Audio salvato in: ${finalPath}`);
}

main().catch(err => {
  console.error('Errore:', err);
  process.exit(1);
});
