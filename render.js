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
    `${labels}concat=n=${clipPaths.length}:v=0:a=1,highpass=f=55,lowpass=f=11200,equalizer=f=105:t=q:w=1.0:g=4.5,equalizer=f=720:t=q:w=1.2:g=1.2,equalizer=f=3050:t=q:w=1:g=-3.4,acompressor=threshold=-19dB:ratio=1.55:attack=22:release=220,loudnorm=I=-17:LRA=12:TP=-1.5[voice]`,
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
  const titleFile = path.join(workDir, 'cover-title.txt');
  const deckFile = path.join(workDir, 'cover-deck.txt');
  const out = path.join(workDir, 'cover-framed.jpg');
  await fs.writeFile(brandFile, 'EXCLUSIVA  ·  ¿CÓMO ASÍ?', 'utf8');
  await fs.writeFile(titleFile, wrapCoverText(title, 16, 3).toUpperCase(), 'utf8');
  await fs.writeFile(deckFile, wrapCoverText(deck || 'EL CHISME QUE NADIE VIO VENIR', 27, 2).toUpperCase(), 'utf8');
  const filter = [
    'scale=720:1280:force_original_aspect_ratio=increase',
    'crop=720:1280',
    'eq=contrast=1.10:saturation=1.18:brightness=-0.015',
    'vignette=PI/5',
    'drawbox=x=0:y=0:w=720:h=1280:color=black@0.07:t=fill',
    'drawbox=x=38:y=54:w=360:h=58:color=black@0.82:t=fill',
    'drawbox=x=38:y=54:w=9:h=58:color=0xCBFF33@1:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${brandFile}:fontcolor=0xCBFF33:fontsize=24:x=62:y=68:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
    'drawbox=x=28:y=660:w=664:h=586:color=black@0.80:t=fill',
    'drawbox=x=42:y=690:w=10:h=480:color=0xCBFF33@1:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${titleFile}:fontcolor=white:fontsize=54:x=76:y=720:line_spacing=10:shadowcolor=black@0.95:shadowx=3:shadowy=3`,
    'drawbox=x=76:y=1025:w=180:h=6:color=0xCBFF33@1:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=${deckFile}:fontcolor=0xDDFE73:fontsize=26:x=76:y=1058:line_spacing=8:shadowcolor=black@0.95:shadowx=2:shadowy=2`,
  ].join(',');
  await run('ffmpeg', ['-y', '-i', coverPath, '-vf', filter, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

export async function createProceduralMusic(workDir, category, duration = 60, seedText = '') {
  const out = path.join(workDir, 'music.wav');
  const sampleRate = 44100;
  const sampleCount = Math.floor(duration * sampleRate);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  writeWavHeader(buffer, sampleRate, sampleCount);

  const profile = categoryProfile(category);
  const seed = hashString(`${category}|${seedText}`) || 1;
  const bpm = Math.max(118, profile.bpm + Math.round(profile.tension * 5) + (seed % 4));
  const beatSeconds = 60 / bpm;
  const barSeconds = beatSeconds * 4;
  const phraseSeconds = barSeconds * 2;
  const bassSteps = [0, 0, 3, 5, 0, 7, 3, 1];
  const bassRoot = profile.rootMidi - 12;
  let noiseState = seed;
  let previousNoise = 0;
  let smoothNoise = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const beatFloat = t / beatSeconds;
    const beatIndex = Math.floor(beatFloat);
    const beatPhase = beatFloat % 1;
    const eighthFloat = t / (beatSeconds / 2);
    const eighthIndex = Math.floor(eighthFloat);
    const eighthPhase = eighthFloat % 1;
    const barPhase = (t % barSeconds) / barSeconds;
    const phrasePhaseSeconds = t % phraseSeconds;
    const phraseIndex = Math.floor(t / phraseSeconds);

    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
    const noise = (noiseState / 0xffffffff) * 2 - 1;
    const brightNoise = noise - previousNoise * 0.82;
    previousNoise = noise;
    smoothNoise += (noise - smoothNoise) * 0.008;

    const fadeIn = Math.min(1, t / 0.10);
    const fadeOut = Math.min(1, Math.max(0, (duration - t) / 1.2));
    const globalEnv = fadeIn * fadeOut;

    // Bajo con actitud de late-night: insistente, sincopado y nada sentimental.
    const bassStep = bassSteps[beatIndex % bassSteps.length];
    const bassFreq = midiToFreq(bassRoot + bassStep);
    const bassEnv = Math.exp(-beatPhase * 4.8);
    const bass = (
      Math.sin(2 * Math.PI * bassFreq * t) * 0.105 +
      Math.sin(2 * Math.PI * bassFreq * 2 * t) * 0.025
    ) * bassEnv;

    // Kick seco en cada pulso y clap burlón en dos y cuatro.
    const kickFreq = 50 + 54 * Math.exp(-beatPhase * 15);
    const kick = Math.sin(2 * Math.PI * kickFreq * t) * Math.exp(-beatPhase * 16) * 0.18;
    const backbeat = beatIndex % 4 === 1 || beatIndex % 4 === 3;
    const clap = backbeat ? brightNoise * Math.exp(-beatPhase * 34) * 0.078 : 0;

    // Hi-hat nervioso: mantiene avance aun debajo de la narración.
    const hatAccent = eighthIndex % 2 === 0 ? 0.030 : 0.018;
    const hat = brightNoise * Math.exp(-eighthPhase * 52) * hatAccent;

    // Cuerda grave corta: tensión de chisme sin volver a documental solemne.
    const drone = (
      Math.sin(2 * Math.PI * midiToFreq(bassRoot - 5) * t) * 0.020 +
      smoothNoise * 0.010
    ) * (0.72 + 0.28 * Math.sin(2 * Math.PI * 0.10 * t));

    // Golpe cómico de metales al inicio de cada frase musical.
    const stingT = phrasePhaseSeconds;
    const stingEnv = Math.exp(-stingT * 5.6);
    const stingBase = midiToFreq(profile.rootMidi + (phraseIndex % 2 ? 1 : 0));
    const brass = (
      Math.sin(2 * Math.PI * stingBase * t) +
      Math.sin(2 * Math.PI * stingBase * 1.5 * t) * 0.55 +
      Math.sin(2 * Math.PI * stingBase * 2 * t) * 0.28
    ) * stingEnv * 0.082;

    // Riser, corte de aire y obturador: preparan y cobran cada remate.
    const riserStart = phraseSeconds - beatSeconds * 1.35;
    const riserProgress = phrasePhaseSeconds > riserStart
      ? (phrasePhaseSeconds - riserStart) / (phraseSeconds - riserStart)
      : 0;
    const riser = brightNoise * (riserProgress ** 2.2) * 0.065;
    const prePunchDip = phrasePhaseSeconds > phraseSeconds - 0.095 ? 0.08 : 1;
    const shutter = beatIndex % 8 === 6
      ? (brightNoise * 0.070 + Math.sin(2 * Math.PI * 1450 * t) * 0.018) * Math.exp(-beatPhase * 55)
      : 0;

    // Pequeño rayón satírico cada cuatro compases; breve para no cansar.
    const scratchPhase = t % (barSeconds * 4);
    const scratch = scratchPhase < 0.16
      ? brightNoise * Math.sin(2 * Math.PI * (1900 - scratchPhase * 7800) * t) * Math.exp(-scratchPhase * 17) * 0.028
      : 0;

    // Cierre seco: el programa termina, no se desvanece pidiendo permiso.
    const finalStart = Math.max(0, duration - 1.7);
    const finalT = Math.max(0, t - finalStart);
    const finalHit = t >= finalStart
      ? (
        Math.sin(2 * Math.PI * 58 * t) * 0.20 +
        Math.sin(2 * Math.PI * 116 * t) * 0.055 +
        brightNoise * 0.030
      ) * Math.exp(-finalT * 2.8)
      : 0;

    const grooveLift = 0.92 + 0.12 * Math.sin(2 * Math.PI * barPhase);
    let sample = (bass + kick + clap + hat + drone + brass + riser + shutter + scratch + finalHit)
      * globalEnv * grooveLift * prePunchDip;
    sample = Math.tanh(sample * 1.55) * 0.82;
    const intSample = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  await fs.writeFile(out, buffer);
  return out;
}

export async function renderReel({ workDir, coverPath, scenePaths, scenes, narrationPath, category, title, coverDeck }) {
  const narrationDuration = await probeDuration(narrationPath);
  const totalDuration = Math.max(55, Math.ceil((narrationDuration || 62) + 2.2));
  const coverDuration = 1.80;
  const visualDuration = totalDuration - coverDuration;
  const rawWeights = scenes.map(scene => {
    const requested = Number(scene?.durationSeconds);
    if (Number.isFinite(requested) && requested > 0) return Math.max(1.8, Math.min(4.2, requested));
    const words = cleanSpeech(scene?.narration).split(/\s+/).filter(Boolean).length;
    return Math.max(1.8, Math.min(4.2, 0.75 + words * 0.34));
  });
  const weightTotal = rawWeights.reduce((sum, value) => sum + value, 0) || scenePaths.length;
  const sceneDurations = rawWeights.map(value => visualDuration * value / weightTotal);
  const framedCover = await createCoverFrame(workDir, coverPath, title, coverDeck);
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
  await fs.writeFile(
    concatFile,
    clipPaths.map(clipPath => `file '${clipPath.replaceAll("'", "'\\''")}'`).join('\n'),
    'utf8'
  );
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-t', String(totalDuration), '-c:v', 'copy', '-an', visualOnly,
  ]);

  const narrationTarget = totalDuration - 0.45;
  const narrationTempo = narrationDuration && narrationDuration > narrationTarget
    ? Math.min(1.04, narrationDuration / narrationTarget)
    : 1;
  const tempoFilter = narrationTempo > 1.0005
    ? `${buildAtempoChain(narrationTempo)},`
    : '';
  const audioFilter = `[1:a]${tempoFilter}adelay=50|50,volume=1.07,acompressor=threshold=-15dB:ratio=1.65:attack=12:release=180,asplit=2[voice_mix][voice_sc];[2:a]highpass=f=35,lowpass=f=9000,volume=0.62[musicbed];[musicbed][voice_sc]sidechaincompress=threshold=0.025:ratio=7.5:attack=8:release=260[ducked];[voice_mix][ducked]amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-14:LRA=11:TP=-1.2[a]`;

  const finalPath = path.join(workDir, 'final.mp4');
  await run('ffmpeg', [
    '-y', '-i', visualOnly, '-i', narrationPath, '-i', music,
    '-filter_complex', audioFilter,
    '-map', '0:v:0', '-map', '[a]', '-t', String(totalDuration), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '112k', '-ar', '48000', '-movflags', '+faststart', finalPath,
  ]);

  const stat = await fs.stat(finalPath);
  if (stat.size > 4600000) {
    const compact = path.join(workDir, 'final-compact.mp4');
    await run('ffmpeg', ['-y', '-i', finalPath, '-c:v', 'libx264', '-b:v', '430k', '-maxrate', '500k', '-bufsize', '1000k', '-c:a', 'aac', '-b:a', '72k', '-movflags', '+faststart', compact]);
    return compact;
  }
  return finalPath;
}
