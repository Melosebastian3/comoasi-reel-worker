import fs from 'node:fs/promises';

const path = new URL('./render.js', import.meta.url);
let source = await fs.readFile(path, 'utf8');

const oldArgs = "      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',\n      '-threads:v', '2', '-x264-params', 'threads=2:lookahead_threads=1:sliced_threads=0',";
const newArgs = "      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '5M', '-bufsize', '10M',\n      '-threads:v', '2', '-x264-params', 'threads=2:lookahead_threads=1:sliced_threads=0',";
if (source.includes(oldArgs)) source = source.replace(oldArgs, newArgs);

const oldAudio = "'-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', finalPath,";
const newAudio = "'-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', finalPath,";
if (source.includes(oldAudio)) source = source.replace(oldAudio, newAudio);

if (!source.includes("'-maxrate', '5M', '-bufsize', '10M'")) {
  throw new Error('render_output_hardening_target_not_found');
}
if (!source.includes("'-c:a', 'aac', '-b:a', '128k'")) {
  throw new Error('render_audio_hardening_target_not_found');
}

await fs.writeFile(path, source, 'utf8');
console.log('[como-asi] social render bitrate hardening applied (video 5M / audio 128k)');
