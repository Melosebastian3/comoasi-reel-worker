import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EdgeTTS } from '@travisvn/edge-tts';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

function cleanSpeech(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function synthesizeEdgeTts(text, voice, style, outputPath) {
  const tts = new EdgeTTS(text, voice, {
    rate: `+${style.rate}%`,
    pitch: `${style.pitch >= 0 ? '+' : ''}${style.pitch}Hz`,
    volume: `+${style.volume}%`,
  });
  const result = await tts.synthesize();
  const audioBuffer = Buffer.from(await result.audio.arrayBuffer());
  await fs.writeFile(outputPath, audioBuffer);
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

export async function createNarrationAudio(workDir, scenesOrNarration, voice = 'es-MX-DaliaNeural', category = 'actualidad') {
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
    blocks.push({
      text: pair.map(line => performLine(line.text, line.delivery)).join(' '),
      delivery: pair.at(-1)?.delivery || lead.delivery,
    });
  }

  const profile = categoryProfile(category);
  const tensionLift = profile.tension > 0.75 ? 2 : 0;
  const deliveryStyles = {
    golpe: { rate: 21 + tensionLift, pitch: 4, volume: 10 },
    veneno: { rate: 14 + tensionLift, pitch: 1, volume: 8 },
    suspenso: { rate: 8 + tensionLift, pitch: -2, volume: 7 },
    incredula: { rate: 18 + tensionLift, pitch: 5, volume: 9 },
    remate: { rate: 11 + tensionLift, pitch: -3, volume: 10 },
  };

  const clipPaths = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const textPath = path.join(workDir, `voice-block-${index + 1}.txt`);
    const clipPath = path.join(workDir, `voice-block-${index + 1}.mp3`);
    const block = blocks[index];
    const style = deliveryStyles[block.delivery] || deliveryStyles.veneno;
    await fs.writeFile(textPath, block.text, 'utf8');
    await synthesizeEdgeTts(block.text, voice, style, clipPath);
    clipPaths.push(clipPath);
  }

  const concatFile = path.join(workDir, 'voice-parts.txt');
  await fs.writeFile(concatFile, clipPaths.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
  const voicePath = path.join(workDir, 'voice.mp3');
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-af', 'highpass=f=80,lowpass=f=12500,acompressor=threshold=-18dB:ratio=2.4:attack=8:release=90,loudnorm=I=-16:LRA=7:TP=-1.5',
    '-c:a', 'libmp3lame', '-b:a', '96k', voicePath,
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
  const audioFilter = `[1:a]${tempoFilter}adelay=100|100,volume=1.08,acompressor=threshold=-16dB:ratio=2.2:attack=6:release=70,asplit=2[voice_mix][voice_sc];[2:a]volume=0.25[musicbed];[musicbed][voice_sc]sidechaincompress=threshold=0.025:ratio=7:attack=15:release=220[ducked];[voice_mix][ducked]amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-14:LRA=8:TP=-1.2[a]`;

  const finalPath = path.join(workDir, 'final.mp4');
  await run('ffmpeg', [
    '-y', '-i', visualOnly, '-i', narrationPath, '-i', music,
    '-filter_complex', audioFilter,
    '-map', '0:v:0', '-map', '[a]', '-t', '60', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', finalPath,
  ]);

  const stat = await fs.stat(finalPath);
  if (stat.size > 4600000) {
    const compact = path.join(workDir, 'final-compact.mp4');
    await run('ffmpeg', ['-y', '-i', finalPath, '-c:v', 'libx264', '-b:v', '430k', '-maxrate', '500k', '-bufsize', '1000k', '-c:a', 'aac', '-b:a', '72k', '-movflags', '+faststart', compact]);
    return compact;
  }
  return finalPath;
}
