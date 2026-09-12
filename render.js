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
    actualidad: { bpm: 112, rootMidi: 45, progression: [0, 5, 3, 7], brightness: 0.45, tension: 0.62 },
    famosos: { bpm: 120, rootMidi: 48, progression: [0, 8, 5, 7], brightness: 0.82, tension: 0.34 },
    chisme_polemica: { bpm: 124, rootMidi: 47, progression: [0, 3, 8, 7], brightness: 0.68, tension: 0.72 },
    viral_internet: { bpm: 132, rootMidi: 50, progression: [0, 7, 10, 5], brightness: 0.88, tension: 0.48 },
    internet: { bpm: 132, rootMidi: 50, progression: [0, 7, 10, 5], brightness: 0.88, tension: 0.48 },
    bizarro_wtf: { bpm: 108, rootMidi: 43, progression: [0, 1, 6, 5], brightness: 0.38, tension: 0.9 },
    bizarro: { bpm: 108, rootMidi: 43, progression: [0, 1, 6, 5], brightness: 0.38, tension: 0.9 },
    humor_negro: { bpm: 94, rootMidi: 41, progression: [0, 3, 1, 6], brightness: 0.2, tension: 0.84 },
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
  if (delivery === 'suspenso' || delivery === 'veneno') return `${clean}...`;
  if (delivery === 'golpe' || delivery === 'incredula') return `¡${clean}!`;
  return `${clean}.`;
}

export async function createNarrationAudio(workDir, scenesOrNarration, voice = 'es-CO-SalomeNeural', category = 'actualidad', onBlockProgress = null) {
  const lines = Array.isArray(scenesOrNarration)
    ? scenesOrNarration
      .map(scene => ({ text: cleanSpeech(scene?.narration), delivery: normalizeDelivery(scene?.delivery) }))
      .filter(line => Boolean(line.text))
    : [{ text: cleanSpeech(scenesOrNarration), delivery: 'veneno' }].filter(line => Boolean(line.text));
  if (lines.length === 0) throw new Error('narration_required');

  const blocks = [];
  for (let index = 0; index < lines.length; index += 2) {
    const pair = lines.slice(index, index + 2);
    const lead = pair[0];
    const isFirst = index === 0;
    const isLast = index + 2 >= lines.length;
    blocks.push({
      text: pair.map(line => performLine(line.text, line.delivery)).join(' '),
      // La intención de apertura y cierre manda; en el medio conservamos la intención
      // de la primera frase para que no se pierda el ataque al agrupar dos escenas.
      delivery: isFirst ? 'golpe' : isLast ? 'remate' : lead.delivery,
    });
  }

  const profile = categoryProfile(category);
  const tensionLift = profile.tension > 0.75 ? 2 : 0;
  // Menos velocidad artificial y más contraste: ataque, complicidad, pausa y remate.
  const deliveryStyles = {
    golpe: { rate: 17 + tensionLift, pitch: 3, volume: 8 },
    veneno: { rate: 8 + tensionLift, pitch: 0, volume: 6 },
    suspenso: { rate: 1 + tensionLift, pitch: -2, volume: 5 },
    incredula: { rate: 14 + tensionLift, pitch: 4, volume: 7 },
    remate: { rate: 6 + tensionLift, pitch: -2, volume: 8 },
  };

  const pauseAfter = (block, index) => {
    if (index === blocks.length - 1) return 0;
    if (index === 0) return 0.22;
    if (block.delivery === 'suspenso') return 0.34;
    if (block.delivery === 'remate') return 0.27;
    if (block.delivery === 'incredula') return 0.20;
    if (block.delivery === 'golpe') return 0.18;
    return 0.14;
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
    `${labels}concat=n=${clipPaths.length}:v=0:a=1,highpass=f=75,lowpass=f=14000,equalizer=f=3500:t=q:w=1:g=-1.5,loudnorm=I=-17:LRA=10:TP=-1.5[voice]`,
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
  const titleFile = path.join(workDir, 'cover-title.txt');
  const deckFile = path.join(workDir, 'cover-deck.txt');
  const out = path.join(workDir, 'cover-framed.jpg');
  await fs.writeFile(titleFile, String(title || '').toUpperCase(), 'utf8');
  await fs.writeFile(deckFile, String(deck || '').toUpperCase(), 'utf8');
  const filter = [
    'scale=720:1280:force_original_aspect_ratio=increase',
    'crop=720:1280',
    'drawbox=x=0:y=760:w=720:h=520:color=black@0.50:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${titleFile}:fontcolor=white:fontsize=54:x=48:y=830:line_spacing=10`,
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=${deckFile}:fontcolor=white:fontsize=28:x=48:y=1010:line_spacing=8`,
  ].join(',');
  await run('ffmpeg', ['-y', '-i', coverPath, '-vf', filter, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

export async function createProceduralMusic(workDir, category, duration = 60, seedText = '') {
  const out = path.join(workDir, 'music.wav');
  const sampleRate = 22050;
  const sampleCount = Math.floor(duration * sampleRate);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  writeWavHeader(buffer, sampleRate, sampleCount);

  const profile = categoryProfile(category);
  const seed = hashString(`${category}|${seedText}`) || 1;
  const bpm = profile.bpm + (seed % 5) - 2;
  const beatSeconds = 60 / bpm;
  const barSeconds = beatSeconds * 4;
  const scale = [0, 3, 5, 7, 10, 12];
  const motif = [0, 2, 4, 1, 3, 5, 2, 4].map((value, index) => scale[(value + ((seed >>> (index % 16)) & 1)) % scale.length]);
  let noiseState = seed;

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const beatPos = (t / beatSeconds) % 1;
    const halfBeatPos = (t / (beatSeconds / 2)) % 1;
    const beatIndex = Math.floor(t / beatSeconds);
    const barIndex = Math.floor(t / barSeconds);
    const chordOffset = profile.progression[barIndex % profile.progression.length];
    const root = profile.rootMidi + chordOffset;
    const bassFreq = midiToFreq(root - 12);
    const fifthFreq = midiToFreq(root + 7);
    const thirdFreq = midiToFreq(root + 3);
    const motifFreq = midiToFreq(root + 12 + motif[Math.floor(t / (beatSeconds / 2)) % motif.length]);

    const fadeIn = Math.min(1, t / 0.7);
    const fadeOut = Math.min(1, Math.max(0, (duration - t) / 2.5));
    const globalEnv = fadeIn * fadeOut;
    const sectionLift = t > 45 ? 1.15 : t > 28 ? 1.08 : 1;

    const kickEnv = Math.exp(-beatPos * 12) * ((beatIndex % 4 === 0 || beatIndex % 4 === 2) ? 1 : 0.42);
    const kick = Math.sin(2 * Math.PI * (52 + 35 * (1 - beatPos)) * t) * kickEnv * 0.19;

    const snareGate = (beatIndex % 4 === 1 || beatIndex % 4 === 3) ? Math.exp(-beatPos * 18) : 0;
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
    const noise = ((noiseState / 0xffffffff) * 2 - 1);
    const snare = noise * snareGate * (0.075 + profile.tension * 0.035);

    const hatGate = Math.exp(-halfBeatPos * 30);
    const hat = noise * hatGate * (0.025 + profile.brightness * 0.018);

    const bassGate = 0.35 + 0.65 * Math.exp(-beatPos * 3.5);
    const bass = (Math.sin(2 * Math.PI * bassFreq * t) + 0.22 * Math.sin(2 * Math.PI * bassFreq * 2 * t)) * bassGate * 0.085;

    const padLfo = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.08 * t);
    const pad = (
      Math.sin(2 * Math.PI * midiToFreq(root) * t) +
      0.7 * Math.sin(2 * Math.PI * thirdFreq * t) +
      0.55 * Math.sin(2 * Math.PI * fifthFreq * t)
    ) * padLfo * (0.022 + profile.brightness * 0.012);

    const pluckEnv = Math.exp(-halfBeatPos * (5.5 + profile.tension * 2));
    const pluck = Math.sin(2 * Math.PI * motifFreq * t) * pluckEnv * (0.025 + profile.brightness * 0.03);

    const glitchPulse = profile.tension > 0.75 && ((beatIndex + seed) % 7 === 0)
      ? Math.sin(2 * Math.PI * (motifFreq * 1.5) * t) * Math.exp(-beatPos * 16) * 0.025
      : 0;

    let sample = (kick + snare + hat + bass + pad + pluck + glitchPulse) * globalEnv * sectionLift;
    sample = Math.tanh(sample * 1.45) * 0.72;
    const intSample = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  await fs.writeFile(out, buffer);
  return out;
}

export async function renderReel({ workDir, coverPath, scenePaths, scenes, narrationPath, category, title, coverDeck }) {
  const totalDuration = 60;
  const coverDuration = 0.95;
  const sceneDuration = (totalDuration - coverDuration) / scenePaths.length;
  const framedCover = await createCoverFrame(workDir, coverPath, title, coverDeck);
  const music = await createProceduralMusic(workDir, category, totalDuration, `${title}|${coverDeck}`);
  const concatFile = path.join(workDir, 'visuals.txt');
  const parts = [`file '${framedCover.replaceAll("'", "'\\''")}'`, `duration ${coverDuration.toFixed(4)}`];
  for (const scenePath of scenePaths) {
    parts.push(`file '${scenePath.replaceAll("'", "'\\''")}'`, `duration ${sceneDuration.toFixed(4)}`);
  }
  parts.push(`file '${scenePaths.at(-1).replaceAll("'", "'\\''")}'`);
  await fs.writeFile(concatFile, parts.join('\n'), 'utf8');

  const visualOnly = path.join(workDir, 'visual.mp4');
  const videoFilter = 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30';
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-t', '60', '-vf', videoFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '29', '-pix_fmt', 'yuv420p', '-an', visualOnly]);

  const narrationDuration = await probeDuration(narrationPath);
  const narrationTarget = totalDuration - 0.25;
  const narrationTempo = narrationDuration && narrationDuration > narrationTarget
    ? narrationDuration / narrationTarget
    : 1;
  const tempoFilter = narrationTempo > 1.0005
    ? `${buildAtempoChain(narrationTempo)},`
    : '';
  const audioFilter = `[1:a]${tempoFilter}adelay=100|100,volume=1.07,acompressor=threshold=-15dB:ratio=1.65:attack=12:release=140,asplit=2[voice_mix][voice_sc];[2:a]volume=0.25[musicbed];[musicbed][voice_sc]sidechaincompress=threshold=0.025:ratio=7:attack=15:release=220[ducked];[voice_mix][ducked]amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-14:LRA=9:TP=-1.2[a]`;

  const finalPath = path.join(workDir, 'final.mp4');
  await run('ffmpeg', [
    '-y', '-i', visualOnly, '-i', narrationPath, '-i', music,
    '-filter_complex', audioFilter,
    '-map', '0:v:0', '-map', '[a]', '-t', '60', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '112k', '-ar', '48000', '-movflags', '+faststart', finalPath,
  ]);

  const stat = await fs.stat(finalPath);
  if (stat.size > 4600000) {
    const compact = path.join(workDir, 'final-compact.mp4');
    await run('ffmpeg', ['-y', '-i', finalPath, '-c:v', 'libx264', '-b:v', '430k', '-maxrate', '500k', '-bufsize', '1000k', '-c:a', 'aac', '-b:a', '72k', '-movflags', '+faststart', compact]);
    return compact;
  }
  return finalPath;
}
