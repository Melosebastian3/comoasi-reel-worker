import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback(value);
    };
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => finish(reject, error));
    child.on('close', code => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`));
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

function cleanSpeech(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function wrapCoverText(text, maxLength = 18, maxLines = 2) {
  const words = cleanSpeech(text).split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLength || current.length === 0) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }
  if (current && lines.length < maxLines) {
    const consumed = lines.join(' ').split(' ').filter(Boolean).length;
    const remaining = words.slice(consumed).join(' ');
    lines.push(remaining.length > maxLength + 5 ? `${remaining.slice(0, maxLength + 2).trim()}…` : remaining);
  }
  return lines.slice(0, maxLines).join('\n');
}

async function synthesizeEdgeTts(text, voice, style, inputPath, outputPath) {
  const rate = `${style.rate >= 0 ? '+' : ''}${style.rate}%`;
  const pitch = `${style.pitch >= 0 ? '+' : ''}${style.pitch}Hz`;
  const volume = `${style.volume >= 0 ? '+' : ''}${style.volume}%`;
  const args = [
    '-m', 'edge_tts',
    '--voice', voice,
    `--rate=${rate}`,
    `--pitch=${pitch}`,
    `--volume=${volume}`,
    '--file', inputPath,
    '--write-media', outputPath,
  ];
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log(`[como-asi] voice block started (attempt ${attempt}, ${text.length} chars)`);
    try {
      await run('python3', args, { timeoutMs: 90000 });
      const stat = await fs.stat(outputPath);
      if (stat.size < 1000) throw new Error('voice_block_empty');
      console.log(`[como-asi] voice block completed (${stat.size} bytes)`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[como-asi] voice block attempt ${attempt} failed`, error instanceof Error ? error.message : String(error));
      await fs.rm(outputPath, { force: true }).catch(() => {});
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError || new Error('voice_block_failed');
}

async function probeDuration(filePath) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

function buildAtempoChain(rate) {
  const filters = [];
  let remaining = rate;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters.join(',');
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function categoryProfile(category) {
  const key = String(category || '').toLowerCase();
  const profiles = {
    actualidad: { bpm: 114, rootMidi: 45, progression: [0, 5, 3, 7], brightness: 0.45, tension: 0.66 },
    famosos: { bpm: 122, rootMidi: 48, progression: [0, 8, 5, 7], brightness: 0.84, tension: 0.50 },
    chisme_polemica: { bpm: 126, rootMidi: 47, progression: [0, 3, 8, 7], brightness: 0.72, tension: 0.82 },
    viral_internet: { bpm: 132, rootMidi: 50, progression: [0, 7, 10, 5], brightness: 0.88, tension: 0.48 },
    internet: { bpm: 132, rootMidi: 50, progression: [0, 7, 10, 5], brightness: 0.88, tension: 0.48 },
    bizarro_wtf: { bpm: 108, rootMidi: 43, progression: [0, 1, 6, 5], brightness: 0.38, tension: 0.9 },
    bizarro: { bpm: 108, rootMidi: 43, progression: [0, 1, 6, 5], brightness: 0.38, tension: 0.9 },
    humor_negro: { bpm: 122, rootMidi: 41, progression: [0, 3, 1, 6], brightness: 0.34, tension: 0.88 },
    cultura_pop_actualidad: { bpm: 126, rootMidi: 50, progression: [0, 5, 8, 7], brightness: 0.9, tension: 0.3 },
    cultura_pop: { bpm: 126, rootMidi: 50, progression: [0, 5, 8, 7], brightness: 0.9, tension: 0.3 },
  };
  return profiles[key] || profiles.actualidad;
}

function midiToFreq(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

function writeWavHeader(buffer, sampleRate, sampleCount) {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const dataSize = sampleCount * blockAlign;
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
}

function normalizeDelivery(value) {
  const delivery = String(value || '').toLowerCase();
  return ['golpe', 'veneno', 'suspenso', 'incredula', 'remate'].includes(delivery) ? delivery : 'veneno';
}

function performLine(text, delivery) {
  const clean = cleanSpeech(text).replace(/[.!?…]+$/u, '');
  if (delivery === 'suspenso') return `${clean}...`;
  if (delivery === 'golpe' || delivery === 'incredula') return `¡${clean}!`;
  return `${clean}.`;
}

export async function createNarrationAudio(workDir, scenesOrNarration, voice = 'es-MX-JorgeNeural', category = 'actualidad', onBlockProgress = null) {
  console.info(`[como-asi] synthesizing narrator with locked voice: ${voice}`);
  const lines = Array.isArray(scenesOrNarration)
    ? scenesOrNarration
      .map(scene => ({ text: cleanSpeech(scene?.narration), delivery: normalizeDelivery(scene?.delivery) }))
      .filter(line => Boolean(line.text))
    : [{ text: cleanSpeech(scenesOrNarration), delivery: 'veneno' }].filter(line => Boolean(line.text));
  if (lines.length === 0) throw new Error('narration_required');

  const blocks = [];
  const actSizes = [1, 4, 4, 4, 3];
  for (let index = 0, actIndex = 0; index < lines.length; actIndex += 1) {
    const size = Math.min(actSizes[actIndex] || 3, lines.length - index);
    const group = lines.slice(index, index + size);
    const isFirst = index === 0;
    const isLast = index + group.length >= lines.length;
    const delivery = isFirst
      ? 'golpe'
      : isLast
        ? 'remate'
        : group.some(line => line.delivery === 'suspenso')
          ? 'suspenso'
          : group.some(line => line.delivery === 'incredula')
            ? 'incredula'
            : group[0].delivery;
    blocks.push({
      text: group.map(line => performLine(line.text, line.delivery)).join(' '),
      delivery,
    });
    index += group.length;
  }

  const profile = categoryProfile(category);
  const tensionLift = profile.tension > 0.75 ? 2 : 0;
  // Ritmo conversado y teatral: la energía viene del contraste, no de correr.
  const deliveryStyles = {
    golpe: { rate: -7 + tensionLift, pitch: -14, volume: 12 },
    veneno: { rate: -11 + tensionLift, pitch: -17, volume: 11 },
    suspenso: { rate: -15 + tensionLift, pitch: -20, volume: 10 },
    incredula: { rate: -8 + tensionLift, pitch: -12, volume: 12 },
    remate: { rate: -12 + tensionLift, pitch: -22, volume: 13 },
  };

  const pauseAfter = (block, index) => {
    if (index === blocks.length - 1) return 0;
    if (index === 0) return 0.48;
    if (block.delivery === 'suspenso') return 0.78;
    if (block.delivery === 'remate') return 0.58;
    if (block.delivery === 'incredula') return 0.50;
    if (block.delivery === 'golpe') return 0.44;
    return 0.38;
  };

  const clipPaths = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const textPath = path.join(workDir, `voice-block-${index + 1}.txt`);
    const clipPath = path.join(workDir, `voice-block-${index + 1}.mp3`);
    const block = blocks[index];
    const style = deliveryStyles[block.delivery] || deliveryStyles.veneno;
    await fs.writeFile(textPath, block.text, 'utf8');
    await synthesizeEdgeTts(block.text, voice, style, textPath, clipPath);
    clipPaths.push(clipPath);
    if (typeof onBlockProgress === 'function') await onBlockProgress(index + 1, blocks.length);
  }

  const voicePath = path.join(workDir, 'voice.mp3');
  const inputs = clipPaths.flatMap(file => ['-i', file]);
  const prepared = clipPaths.map((_, index) => {
    const pause = pauseAfter(blocks[index], index);
    const padding = pause > 0 ? `,apad=pad_dur=${pause.toFixed(2)}` : '';
    return `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono${padding}[part${index}]`;
  });
  const labels = clipPaths.map((_, index) => `[part${index}]`).join('');
  const filter = [
    ...prepared,
    `${labels}concat=n=${clipPaths.length}:v=0:a=1,asetrate=44160,aresample=48000,atempo=1.08696,highpass=f=48,lowpass=f=10400,equalizer=f=92:t=q:w=0.9:g=5.8,equalizer=f=185:t=q:w=1.1:g=2.2,equalizer=f=2650:t=q:w=1:g=-2.6,acompressor=threshold=-20dB:ratio=1.7:attack=18:release=240,loudnorm=I=-17:LRA=11:TP=-1.5[voice]`,
  ].join(';');
  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filter,
    '-map', '[voice]', '-ar', '48000',
    '-c:a', 'libmp3lame', '-b:a', '112k', voicePath,
  ]);
  return voicePath;
}

export async function createCoverFrame(workDir, coverPath, title, deck) {
  const brandFile = path.join(workDir, 'cover-brand.txt');
  const showFile = path.join(workDir, 'cover-show.txt');
  const titleFile = path.join(workDir, 'cover-title.txt');
  const deckFile = path.join(workDir, 'cover-deck.txt');
  const out = path.join(workDir, 'cover-framed.jpg');
  await fs.writeFile(brandFile, 'MALA FAMA PRESENTA', 'utf8');
  await fs.writeFile(showFile, '¿CÓMO ASÍ?', 'utf8');
  await fs.writeFile(titleFile, wrapCoverText(title, 14, 4).toUpperCase(), 'utf8');
  await fs.writeFile(deckFile, wrapCoverText(deck || 'EL EGO ENTRÓ PRIMERO', 25, 2).toUpperCase(), 'utf8');
  const filter = [
    'scale=720:1280:force_original_aspect_ratio=increase',
    'crop=720:1280',
    'eq=contrast=1.16:saturation=1.20:brightness=-0.025',
    'vignette=PI/4.4',
    'drawbox=x=0:y=0:w=720:h=1280:color=0x071018@0.10:t=fill',
    'drawbox=x=30:y=42:w=392:h=54:color=black@0.82:t=fill',
    'drawbox=x=30:y=42:w=8:h=54:color=0xCBFF33@1:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${brandFile}:fontcolor=0xCBFF33:fontsize=22:x=54:y=57:shadowcolor=black@0.95:shadowx=2:shadowy=2`,
    'drawbox=x=510:y=42:w=180:h=54:color=0xB51570@0.92:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${showFile}:fontcolor=white:fontsize=22:x=526:y=57:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
    'drawbox=x=24:y=750:w=672:h=486:color=0x07090D@0.80:t=fill',
    'drawbox=x=24:y=750:w=672:h=8:color=0xCBFF33@1:t=fill',
    'drawbox=x=43:y=785:w=10:h=310:color=0xB51570@1:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${titleFile}:fontcolor=white:fontsize=48:x=70:y=785:line_spacing=6:fix_bounds=true:shadowcolor=black@0.98:shadowx=3:shadowy=3`,
    'drawbox=x=76:y=1128:w=520:h=2:color=white@0.26:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${deckFile}:fontcolor=0xDFFF75:fontsize=25:x=76:y=1150:line_spacing=7:shadowcolor=black@0.98:shadowx=2:shadowy=2`,
  ].join(',');
  await run('ffmpeg', ['-y', '-i', coverPath, '-vf', filter, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

export async function createOutroFrame(workDir, hostScenePath) {
  const showFile = path.join(workDir, 'outro-show.txt');
  const hostFile = path.join(workDir, 'outro-host.txt');
  const taglineFile = path.join(workDir, 'outro-tagline.txt');
  const out = path.join(workDir, 'outro-framed.jpg');
  await fs.writeFile(showFile, '¿CÓMO ASÍ?', 'utf8');
  await fs.writeFile(hostFile, 'MALA FAMA', 'utf8');
  await fs.writeFile(taglineFile, 'EL CHISME BAJÓ AL INFIERNO', 'utf8');
  const filter = [
    'scale=720:1280:force_original_aspect_ratio=increase',
    'crop=720:1280',
    'eq=contrast=1.18:saturation=1.22:brightness=-0.035',
    'vignette=PI/4.2',
    'drawbox=x=0:y=0:w=720:h=1280:color=0x05070A@0.28:t=fill',
    'drawbox=x=38:y=842:w=644:h=330:color=black@0.82:t=fill',
    'drawbox=x=38:y=842:w=644:h=8:color=0xCBFF33@1:t=fill',
    'drawbox=x=38:y=850:w=9:h=322:color=0xB51570@1:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${hostFile}:fontcolor=0xCBFF33:fontsize=27:x=(w-text_w)/2:y=888:shadowcolor=black@0.98:shadowx=2:shadowy=2`,
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${showFile}:fontcolor=white:fontsize=70:x=(w-text_w)/2:y=944:fix_bounds=true:shadowcolor=black@0.98:shadowx=4:shadowy=4`,
    'drawbox=x=166:y=1042:w=388:h=3:color=white@0.34:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${taglineFile}:fontcolor=0xE6FF91:fontsize=23:x=(w-text_w)/2:y=1075:fix_bounds=true:shadowcolor=black@0.98:shadowx=2:shadowy=2`,
  ].join(',');
  await run('ffmpeg', ['-y', '-i', hostScenePath, '-vf', filter, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

async function createInfernalSignature(workDir) {
  const out = path.join(workDir, 'infernal-signature.wav');
  const sampleRate = 48000;
  const duration = 2.25;
  const sampleCount = Math.floor(duration * sampleRate);
  const dry = new Float64Array(sampleCount);
  let noiseState = 0x6d2b79f5;
  let lowNoise = 0;
  let previousNoise = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
    const noise = (noiseState / 0xffffffff) * 2 - 1;
    lowNoise += (noise - lowNoise) * 0.018;
    const brightNoise = noise - previousNoise * 0.88;
    previousNoise = noise;

    // Aspiración invertida: abre el sello sin fingir una carcajada humana.
    const inhaleProgress = Math.min(1, t / 0.62);
    const inhale = t < 0.62
      ? (brightNoise * 0.055 + lowNoise * 0.085) * (inhaleProgress ** 2.4)
      : 0;

    // Golpe subgrave con caída de tono, como una puerta cerrándose en el infierno.
    const impactT = t - 0.58;
    const impactFrequency = 32 + 74 * Math.exp(-Math.max(0, impactT) * 8.5);
    const impact = impactT >= 0
      ? (
        Math.sin(2 * Math.PI * impactFrequency * impactT) * 0.42 +
        brightNoise * 0.10
      ) * Math.exp(-impactT * 4.8)
      : 0;

    // Gruñido corto y no verbal: textura de personaje, no TTS diciendo «ja».
    const growlT = t - 0.68;
    const growlEnvelope = growlT >= 0 && growlT < 1.02
      ? Math.sin(Math.PI * Math.min(1, growlT / 0.11)) * Math.exp(-growlT * 1.7)
      : 0;
    const growlFrequency = 63 - Math.min(18, Math.max(0, growlT) * 20);
    const growlPhase = 2 * Math.PI * growlFrequency * Math.max(0, growlT);
    const growlPulse = 0.58 + 0.42 * Math.sin(2 * Math.PI * 6.2 * Math.max(0, growlT));
    const growl = growlEnvelope * growlPulse * (
      Math.sin(growlPhase) * 0.19 +
      Math.sin(growlPhase * 2.01) * 0.075 +
      Math.sin(growlPhase * 3.04) * 0.035 +
      lowNoise * 0.055
    );

    // Firma metálica disonante: breve, reconocible y con cola.
    const chimeT = t - 1.24;
    const chime = chimeT >= 0
      ? (
        Math.sin(2 * Math.PI * 389 * chimeT) * 0.050 +
        Math.sin(2 * Math.PI * 523 * chimeT) * 0.034 +
        Math.sin(2 * Math.PI * 731 * chimeT) * 0.020
      ) * Math.exp(-chimeT * 3.8)
      : 0;

    dry[i] = inhale + impact + growl + chime;
  }

  const buffer = Buffer.alloc(44 + sampleCount * 2);
  writeWavHeader(buffer, sampleRate, sampleCount);
  const echoA = Math.round(sampleRate * 0.095);
  const echoB = Math.round(sampleRate * 0.215);
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const tail = Math.min(1, Math.max(0, (duration - t) / 0.30));
    const wet = dry[i]
      + (i >= echoA ? dry[i - echoA] * 0.24 : 0)
      + (i >= echoB ? dry[i - echoB] * 0.12 : 0);
    const sample = Math.tanh(wet * 1.55) * 0.84 * tail;
    const intSample = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  await fs.writeFile(out, buffer);
  return out;
}

export async function createProceduralMusic(workDir, category, duration = 60, seedText = '') {
  const out = path.join(workDir, 'music.wav');
  const sampleRate = 44100;
  const sampleCount = Math.floor(duration * sampleRate);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  writeWavHeader(buffer, sampleRate, sampleCount);

  const profile = categoryProfile(category);
  const seed = hashString(`${category}|${seedText}|dark-noir-v2`) || 1;
  const bpm = Math.max(106, Math.min(118, 106 + Math.round(profile.tension * 8) + (seed % 4)));
  const beatSeconds = 60 / bpm;
  const barSeconds = beatSeconds * 4;
  const phraseSeconds = barSeconds * 4;
  const root = profile.rootMidi - 24;
  const bassPattern = [0, 0, 0, 3, 0, 0, 6, 5, 0, 0, 3, 1, 0, 7, 6, 3];
  const kickPattern = new Set([0, 6, 8, 11, 14]);
  const hatPattern = new Set([0, 2, 4, 7, 8, 10, 12, 15]);
  let noiseState = seed;
  let lastNoise = 0;
  let lowNoise = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const beatFloat = t / beatSeconds;
    const beatIndex = Math.floor(beatFloat);
    const beatPhase = beatFloat % 1;
    const sixteenthFloat = t / (beatSeconds / 4);
    const sixteenthIndex = Math.floor(sixteenthFloat);
    const sixteenthStep = sixteenthIndex % 16;
    const sixteenthPhase = sixteenthFloat % 1;
    const barIndex = Math.floor(t / barSeconds);
    const phraseTime = t % phraseSeconds;

    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
    const noise = (noiseState / 0xffffffff) * 2 - 1;
    const brightNoise = noise - lastNoise * 0.92;
    lastNoise = noise;
    lowNoise += (noise - lowNoise) * 0.0025;

    const fadeIn = Math.min(1, t / 0.16);
    const fadeOut = Math.min(1, Math.max(0, (duration - t) / 0.8));
    const globalEnv = fadeIn * fadeOut;

    // Subgrave 808: pocas notas, mucho espacio y una caída corta al inicio.
    const bassStep = bassPattern[beatIndex % bassPattern.length];
    const bassFreq = midiToFreq(root + bassStep);
    const bassEnv = Math.exp(-beatPhase * 2.35);
    const bassPhase = 2 * Math.PI * bassFreq * t;
    const sub = (Math.sin(bassPhase) * 0.145 + Math.sin(bassPhase * 2) * 0.020) * bassEnv;

    // Kick grave sincopado; rim seco en dos y cuatro.
    const kickOn = kickPattern.has(sixteenthStep);
    const kickFreq = 43 + 78 * Math.exp(-sixteenthPhase * 18);
    const kick = kickOn
      ? Math.sin(2 * Math.PI * kickFreq * t) * Math.exp(-sixteenthPhase * 21) * 0.24
      : 0;
    const rimOn = sixteenthStep === 4 || sixteenthStep === 12;
    const rim = rimOn
      ? (brightNoise * 0.050 + Math.sin(2 * Math.PI * 1680 * t) * 0.025) * Math.exp(-sixteenthPhase * 48)
      : 0;

    // Hats con huecos: avance moderno sin ametralladora constante.
    const hatOn = hatPattern.has(sixteenthStep);
    const hat = hatOn ? brightNoise * Math.exp(-sixteenthPhase * 70) * (sixteenthStep % 4 === 0 ? 0.024 : 0.013) : 0;

    // Pulso noir: dos notas graves desafinadas y una textura respirando.
    const padRoot = midiToFreq(root - 5);
    const pad = (
      Math.sin(2 * Math.PI * padRoot * t) * 0.020 +
      Math.sin(2 * Math.PI * padRoot * 1.498 * t) * 0.011 +
      lowNoise * 0.009
    ) * (0.58 + 0.42 * Math.sin(2 * Math.PI * 0.075 * t));

    // Campana procesada, una vez por compás; firma, no melodía de ascensor.
    const bellTime = t % barSeconds;
    const bellNote = midiToFreq(profile.rootMidi + (barIndex % 4 === 3 ? 1 : 0));
    const bellEnv = Math.exp(-bellTime * 4.6);
    const bell = (
      Math.sin(2 * Math.PI * bellNote * t) * 0.020 +
      Math.sin(2 * Math.PI * bellNote * 2.71 * t) * 0.009
    ) * bellEnv;

    // Tensión antes del remate y golpe de subgrave al cerrar cada frase.
    const riserStart = phraseSeconds - beatSeconds * 1.5;
    const riserProgress = phraseTime > riserStart
      ? (phraseTime - riserStart) / (phraseSeconds - riserStart)
      : 0;
    const riser = brightNoise * (riserProgress ** 2.7) * 0.040;
    const silencePocket = phraseTime > phraseSeconds - 0.115 ? 0.03 : 1;
    const impactTime = phraseTime;
    const impact = (
      Math.sin(2 * Math.PI * 37 * t) * 0.24 +
      brightNoise * 0.045
    ) * Math.exp(-impactTime * 7.2);

    // Final seco con caída subgrave: termina con autoridad.
    const finalStart = Math.max(0, duration - 1.15);
    const finalT = Math.max(0, t - finalStart);
    const finalHit = t >= finalStart
      ? (Math.sin(2 * Math.PI * 34 * t) * 0.27 + brightNoise * 0.030) * Math.exp(-finalT * 3.7)
      : 0;

    let sample = (sub + kick + rim + hat + pad + bell + riser + impact + finalHit)
      * globalEnv * silencePocket;
    sample = Math.tanh(sample * 1.42) * 0.78;
    const intSample = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  await fs.writeFile(out, buffer);
  return out;
}

export async function renderReel({ workDir, coverPath, scenePaths, scenes, narrationPath, category, title, coverDeck }) {
  const narrationDuration = await probeDuration(narrationPath);
  const outroDuration = 2.65;
  const totalDuration = Math.max(58, Math.ceil((narrationDuration || 62) + outroDuration + 0.5));
  const coverDuration = 1.80;
  const visualDuration = totalDuration - coverDuration - outroDuration;
  const rawWeights = scenes.map(scene => {
    const requested = Number(scene?.durationSeconds);
    if (Number.isFinite(requested) && requested > 0) return Math.max(1.8, Math.min(4.2, requested));
    const words = cleanSpeech(scene?.narration).split(/\s+/).filter(Boolean).length;
    return Math.max(1.8, Math.min(4.2, 0.75 + words * 0.34));
  });
  const weightTotal = rawWeights.reduce((sum, value) => sum + value, 0) || scenePaths.length;
  const sceneDurations = rawWeights.map(value => visualDuration * value / weightTotal);
  const framedCover = await createCoverFrame(workDir, coverPath, title, coverDeck);
  const outroFrame = await createOutroFrame(workDir, scenePaths.at(-1) || coverPath);
  const infernalSignature = await createInfernalSignature(workDir);
  const music = await createProceduralMusic(workDir, category, totalDuration, `${title}|${coverDeck}`);
  const concatFile = path.join(workDir, 'visual-clips.txt');
  const visualOnly = path.join(workDir, 'visual.mp4');
  const clipPaths = [];
  const motionFor = (index, frames, isCover = false) => {
    if (isCover) {
      return "scale=900:1600,zoompan=z='min(zoom+0.0012,1.09)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30";
    }
    const safeFrames = Math.max(1, frames);
    const motions = [
      "scale=940:1680,zoompan=z='min(zoom+0.0042,1.24)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30",
      `scale=940:1680,zoompan=z='1.16':x='(iw-iw/zoom)*on/${safeFrames}':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30`,
      "scale=940:1680,zoompan=z='max(1.24-on*0.0035,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30",
      `scale=940:1680,zoompan=z='1.16':x='(iw-iw/zoom)*(1-on/${safeFrames})':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30`,
      `scale=940:1680,zoompan=z='1.17':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${safeFrames}':d=1:s=720x1280:fps=30`,
      `scale=940:1680,zoompan=z='if(lt(on,${Math.round(safeFrames * 0.56)}),1.05+on*0.0014,1.22)':x='iw/2-(iw/zoom/2)':y='ih*0.40-(ih/zoom/2)':d=1:s=720x1280:fps=30`
    ];
    return motions[index % motions.length];
  };

  const makeMotionClip = async (inputPath, duration, index, isCover = false) => {
    const out = path.join(workDir, `motion-${String(index).padStart(2, '0')}.mp4`);
    const frames = Math.max(1, Math.round(duration * 30));
    const flash = !isCover && [0, 2, 4, 7, 10, 12, 14].includes(index)
      ? ',fade=t=in:st=0:d=0.065:color=white'
      : '';
    const colorGrade = isCover ? '' : ',eq=contrast=1.07:saturation=1.12:brightness=-0.01';
    await run('ffmpeg', [
      '-y', '-loop', '1', '-framerate', '30', '-i', inputPath,
      '-t', duration.toFixed(4),
      '-vf', `${motionFor(index, frames, isCover)}${colorGrade}${flash},format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
      '-r', '30', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', out,
    ]);
    clipPaths.push(out);
  };

  await makeMotionClip(framedCover, coverDuration, -1, true);
  for (let index = 0; index < scenePaths.length; index += 1) {
    await makeMotionClip(scenePaths[index], sceneDurations[index], index, false);
  }
  await makeMotionClip(outroFrame, outroDuration, 99, true);
  await fs.writeFile(
    concatFile,
    clipPaths.map(clipPath => `file '${clipPath.replaceAll("'", "'\\''")}'`).join('\n'),
    'utf8'
  );
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-t', String(totalDuration), '-c:v', 'copy', '-an', visualOnly,
  ]);

  const narrationTarget = totalDuration - outroDuration - 0.35;
  const narrationTempo = narrationDuration && narrationDuration > narrationTarget
    ? Math.min(1.04, narrationDuration / narrationTarget)
    : 1;
  const tempoFilter = narrationTempo > 1.0005
    ? `${buildAtempoChain(narrationTempo)},`
    : '';
  const signatureDelayMs = Math.max(0, Math.round((totalDuration - outroDuration + 0.10) * 1000));
  const audioFilter = `[1:a]${tempoFilter}adelay=50|50,volume=1.07,acompressor=threshold=-15dB:ratio=1.65:attack=12:release=180,asplit=2[voice_mix][voice_sc];[3:a]adelay=${signatureDelayMs},volume=0.98,asplit=2[signature_mix][signature_sc];[voice_sc][signature_sc]amix=inputs=2:duration=longest:dropout_transition=0[duck_trigger];[2:a]highpass=f=28,lowpass=f=8200,volume=0.48,acompressor=threshold=-18dB:ratio=1.35:attack=18:release=260[musicbed];[musicbed][duck_trigger]sidechaincompress=threshold=0.030:ratio=7.0:attack=8:release=390[ducked];[voice_mix][signature_mix][ducked]amix=inputs=3:duration=longest:dropout_transition=2,loudnorm=I=-14:LRA=11:TP=-1.2[a]`;

  const finalPath = path.join(workDir, 'final.mp4');
  await run('ffmpeg', [
    '-y', '-i', visualOnly, '-i', narrationPath, '-i', music, '-i', infernalSignature,
    '-filter_complex', audioFilter,
    '-map', '0:v:0', '-map', '[a]', '-t', String(totalDuration), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '112k', '-ar', '48000', '-movflags', '+faststart', finalPath,
  ]);

  const stat = await fs.stat(finalPath);
  const maxUploadBytes = 3450000;
  console.info(`[como-asi] rendered MP4 size: ${stat.size} bytes for ${totalDuration}s`);
  if (stat.size > maxUploadBytes) {
    const compact = path.join(workDir, 'final-compact.mp4');
    const audioKbps = 64;
    const containerMarginKbps = 18;
    const targetTotalKbps = Math.floor((maxUploadBytes * 8) / (totalDuration * 1000));
    const videoKbps = Math.max(140, Math.min(360, targetTotalKbps - audioKbps - containerMarginKbps));
    const maxRateKbps = Math.max(videoKbps + 20, Math.round(videoKbps * 1.12));
    const bufferKbps = Math.round(maxRateKbps * 2.2);
    console.info(`[como-asi] compacting MP4 for JSON transport at ${videoKbps}k video + ${audioKbps}k audio`);
    await run('ffmpeg', [
      '-y', '-i', finalPath,
      '-c:v', 'libx264', '-preset', 'medium',
      '-b:v', `${videoKbps}k`,
      '-maxrate', `${maxRateKbps}k`,
      '-bufsize', `${bufferKbps}k`,
      '-c:a', 'aac', '-b:a', `${audioKbps}k`,
      '-movflags', '+faststart', compact,
    ]);
    const compactStat = await fs.stat(compact);
    console.info(`[como-asi] compact MP4 size: ${compactStat.size} bytes; base64 estimate: ${Math.ceil(compactStat.size / 3) * 4} bytes`);
    if (compactStat.size > 3900000) {
      throw new Error(`final_video_exceeds_transport_limit:${compactStat.size}`);
    }
    return compact;
  }
  console.info(`[como-asi] MP4 base64 estimate: ${Math.ceil(stat.size / 3) * 4} bytes`);
  return finalPath;
}
