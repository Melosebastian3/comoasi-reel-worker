import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const milli = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${milli}`;
}

function safeSubtitle(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function socialSubtitle(text, maxChars = 28) {
  const words = safeSubtitle(text).split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

export async function createNarrationAudio(workDir, narration, voice = 'es-AR-ElenaNeural') {
  const textPath = path.join(workDir, 'narration.txt');
  const voicePath = path.join(workDir, 'voice.mp3');
  await fs.writeFile(textPath, narration, 'utf8');
  await run('edge-tts', [
    '--voice', voice,
    '--rate', '+18%',
    '--pitch', '+3Hz',
    '--volume', '+6%',
    '-f', textPath,
    '--write-media', voicePath,
  ]);
  return voicePath;
}

export async function createSubtitles(workDir, scenes, coverDuration = 0.95, totalDuration = 60) {
  const sceneDuration = (totalDuration - coverDuration) / scenes.length;
  const lines = [];
  scenes.forEach((scene, i) => {
    const start = i === 0 ? 0.55 : coverDuration + i * sceneDuration;
    const end = Math.min(totalDuration - 0.05, coverDuration + (i + 1) * sceneDuration);
    lines.push(String(i + 1), `${srtTime(start)} --> ${srtTime(end)}`, socialSubtitle(scene.narration), '');
  });
  const srtPath = path.join(workDir, 'captions.srt');
  await fs.writeFile(srtPath, lines.join('\n'), 'utf8');
  return srtPath;
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

export async function createProceduralMusic(workDir, category, duration = 60) {
  const out = path.join(workDir, 'music.wav');
  const palettes = {
    actualidad: [98, 146.83, 196],
    famosos: [110, 164.81, 220],
    cultura_pop: [130.81, 196, 261.63],
    internet: [123.47, 185, 246.94],
    bizarro: [92.5, 138.59, 207.65],
    humor_negro: [82.41, 123.47, 185],
  };
  const f = palettes[category] || palettes.actualidad;
  const expr = `0.020*sin(2*PI*${f[0]}*t)+0.014*sin(2*PI*${f[1]}*t)+0.010*sin(2*PI*${f[2]}*t)`;
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${duration}`, '-af', 'lowpass=f=2200,afade=t=in:st=0:d=2,afade=t=out:st=57:d=3', '-c:a', 'pcm_s16le', out]);
  return out;
}

export async function renderReel({ workDir, coverPath, scenePaths, scenes, narrationPath, category, title, coverDeck }) {
  const totalDuration = 60;
  const coverDuration = 0.95;
  const sceneDuration = (totalDuration - coverDuration) / scenePaths.length;
  const framedCover = await createCoverFrame(workDir, coverPath, title, coverDeck);
  const subtitles = await createSubtitles(workDir, scenes, coverDuration, totalDuration);
  const music = await createProceduralMusic(workDir, category, totalDuration);
  const concatFile = path.join(workDir, 'visuals.txt');
  const parts = [`file '${framedCover.replaceAll("'", "'\\''")}'`, `duration ${coverDuration.toFixed(4)}`];
  for (const scenePath of scenePaths) {
    parts.push(`file '${scenePath.replaceAll("'", "'\\''")}'`, `duration ${sceneDuration.toFixed(4)}`);
  }
  parts.push(`file '${scenePaths.at(-1).replaceAll("'", "'\\''")}'`);
  await fs.writeFile(concatFile, parts.join('\n'), 'utf8');

  const visualOnly = path.join(workDir, 'visual.mp4');
  const videoFilter = `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30,subtitles=${subtitles}:force_style='FontName=DejaVu Sans,FontSize=28,PrimaryColour=&H00FFFFFF,OutlineColour=&HAA000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=105,Alignment=2'`;
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-t', '60', '-vf', videoFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '29', '-pix_fmt', 'yuv420p', '-an', visualOnly]);

  const finalPath = path.join(workDir, 'final.mp4');
  await run('ffmpeg', [
    '-y', '-i', visualOnly, '-i', narrationPath, '-i', music,
    '-filter_complex', '[1:a]adelay=120|120,volume=1.0[voice];[2:a]volume=0.12[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=2[a]',
    '-map', '0:v:0', '-map', '[a]', '-t', '60', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', finalPath,
  ]);

  const stat = await fs.stat(finalPath);
  if (stat.size > 4600000) {
    const compact = path.join(workDir, 'final-compact.mp4');
    await run('ffmpeg', ['-y', '-i', finalPath, '-c:v', 'libx264', '-b:v', '430k', '-maxrate', '500k', '-bufsize', '1000k', '-c:a', 'aac', '-b:a', '56k', '-movflags', '+faststart', compact]);
    return compact;
  }
  return finalPath;
}
