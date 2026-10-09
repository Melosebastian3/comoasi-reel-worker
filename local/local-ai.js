// Open-source replacement for the AppDeploy SDK (ai.generate / ai.imageGen / ai.scrape).
// Text: any OpenAI-compatible server (llama.cpp `llama-server`, Ollama, vLLM...).
// Images: a local diffusion script (scripts/imagegen.py) or a mock for tests.
// No paid API is required; every endpoint is configured by environment variables.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const llmBase = () => (process.env.LLM_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const llmModel = () => process.env.LLM_MODEL || 'local';
// llamacpp: response_format {type:'json_object', schema}; openai: json_schema; prompt: schema only in the prompt.
const llmJsonMode = () => process.env.LLM_JSON_MODE || 'llamacpp';

function stripFences(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function extractJson(text) {
  const cleaned = stripFences(text);
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error('llm_invalid_json');
}

function missingRequired(schema, value, at = '') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return at || 'root';
    for (const key of schema.required || []) {
      if (!(key in value)) return `${at}${key}`;
      const nested = missingRequired(schema.properties?.[key], value[key], `${at}${key}.`);
      if (nested) return nested;
    }
  }
  if (schema.type === 'array' && !Array.isArray(value)) return at || 'root';
  return null;
}

function responseFormat(schema) {
  const mode = llmJsonMode();
  if (mode === 'openai') return { type: 'json_schema', json_schema: { name: 'result', schema } };
  if (mode === 'llamacpp') return { type: 'json_object', schema };
  return undefined;
}

async function chat({ system, prompt, schema, maxTokens, temperature }) {
  const body = {
    model: llmModel(),
    messages: [
      { role: 'system', content: `${system || ''}\n\nResponde únicamente con un objeto JSON válido que cumpla este JSON Schema:\n${JSON.stringify(schema)}`.trim() },
      { role: 'user', content: prompt },
    ],
    max_tokens: Number(process.env.LLM_MAX_TOKENS || maxTokens || 4000),
    temperature: temperature ?? 0.45,
  };
  const format = responseFormat(schema);
  if (format) body.response_format = format;
  // Stream so the HTTP headers arrive at once: Node's fetch aborts after 300 s without headers,
  // and a CPU model can take far longer than that to write a 16-scene story.
  body.stream = true;
  const headers = { 'content-type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.authorization = `Bearer ${process.env.LLM_API_KEY}`;
  const response = await fetch(`${llmBase()}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 1800000)),
  });
  if (!response.ok) {
    const text = await response.text();
    const failure = new Error(`llm_http_${response.status}: ${text.slice(0, 300)}`);
    failure.status = response.status;
    throw failure;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return content;
      try { content += JSON.parse(data)?.choices?.[0]?.delta?.content || ''; } catch { /* partial line */ }
    }
  }
  return content;
}

export async function generateJson({ system, prompt, schema, maxTokens, temperature }) {
  const attempts = Number(process.env.LLM_JSON_ATTEMPTS || 3);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = extractJson(await chat({ system, prompt, schema, maxTokens, temperature }));
      const missing = missingRequired(schema, value);
      if (missing) throw new Error(`llm_missing_field:${missing}`);
      return value;
    } catch (attemptError) {
      lastError = attemptError;
      console.warn(`[como-asi] local llm attempt ${attempt}/${attempts} failed: ${attemptError.message}`);
    }
  }
  throw lastError;
}

// Fixed English description so the host looks the same in every video.
export const MALA_FAMA_HOST = 'adult male devil talk show host, angular bright crimson red face and skin, two polished black horns curving back, acid green eyes, slicked black hair with one white streak, short pointed beard, fitted black suit, magenta shirt, black gloves, acid green pocket square, blackened metal microphone, sly sideways executioner smile, raised eyebrow';
export const STYLE_SUFFIX = '2D adult editorial illustration, torn paper collage, expressive ink, halftone, photocopy grain, hard shadows, paparazzi flash, palette of ink black, ivory, acid green, electric magenta, cobalt blue';
// CLIP-based models (SDXL) only read the first ~77 tokens, so the look goes first and short.
export const STYLE_LEAD = 'pop art comic caricature, medium-wide scene with action, bold black ink outlines, halftone dots, torn paper collage background, magenta and cobalt blue backdrop with acid green accents, natural skin tones, no lettering or captions';
export const MALA_FAMA_HOST_SHORT = 'devil talk show host with crimson red face, two black horns, glowing green eyes, slicked black hair, black suit, magenta shirt, holding a microphone, sly grin';
export const NEGATIVE_PROMPT = 'text, letters, words, logo, watermark, caption, grid, split screen, ui, 3d render, pixar, disney, chibi, anime, plastic, child, nudity, lingerie, photo, blurry, deformed';

// Diffusion models read ~77 English tokens; the Spanish Studio prompts are far longer.
async function condensePrompt(prompt) {
  const isHost = /HOST SCENE de MALA FAMA|Mala Fama domina/i.test(prompt);
  if (process.env.IMAGE_CONDENSE === 'off') {
    return isHost ? `${MALA_FAMA_HOST}, ${STYLE_SUFFIX}` : `${prompt.slice(0, 300)}, ${STYLE_SUFFIX}`;
  }
  const schema = { type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'] };
  const result = await generateJson({
    system: `You write prompts for an image model. Output one English description of at most ${Number(process.env.IMAGE_PROMPT_WORDS || 30)} words starting with what the people are doing and the absurd symbolic objects around them, then the setting and emotion; show bodies and action, not a close-up portrait. Keep celebrity names exactly as given. No style words, no brand logos, no text instructions.`,
    prompt,
    schema,
    maxTokens: 200,
    temperature: 0.2,
  });
  const subject = String(result.subject || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  if (/sdxl|sd15|lcm/i.test(process.env.IMAGE_MODEL || '')) {
    return isHost ? `${STYLE_LEAD}, ${MALA_FAMA_HOST_SHORT}, ${subject}` : `${STYLE_LEAD}, ${subject}`;
  }
  return isHost ? `${STYLE_LEAD}, ${MALA_FAMA_HOST}, ${subject}, ${STYLE_SUFFIX}` : `${STYLE_LEAD}, ${subject}, ${STYLE_SUFFIX}`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))));
  });
}

let imageCounter = 0;

export async function generateImage({ prompt }) {
  const backend = process.env.IMAGE_BACKEND || 'diffusers';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comoasi-img-'));
  const out = path.join(dir, 'image.png');
  try {
    if (backend === 'mock') {
      // Test-only: a flat brand-coloured frame, no model download.
      const palette = ['0x5a0f1e', '0x101010', '0x9cff2e', '0xd61f8c', '0x1f3fbf'];
      const color = palette[imageCounter++ % palette.length];
      await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=768x1344`, '-frames:v', '1', out]);
    } else if (backend === 'server') {
      // scripts/imagegen_server.py keeps the model loaded on the GPU between images.
      const condensed = await condensePrompt(prompt);
      const response = await fetch(`${(process.env.IMAGE_SERVER_URL || 'http://127.0.0.1:7860').replace(/\/$/, '')}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: condensed,
          negative: NEGATIVE_PROMPT,
          width: Number(process.env.IMAGE_WIDTH || 768),
          height: Number(process.env.IMAGE_HEIGHT || 1344),
          steps: Number(process.env.IMAGE_STEPS || 4),
        }),
        signal: AbortSignal.timeout(Number(process.env.IMAGE_TIMEOUT_MS || 600000)),
      });
      if (!response.ok) throw new Error(`image_server_${response.status}: ${(await response.text()).slice(0, 300)}`);
      await fs.writeFile(out, Buffer.from(await response.arrayBuffer()));
    } else {
      const condensed = await condensePrompt(prompt);
      await run(process.env.IMAGE_PYTHON || 'python3', [
        path.join(repoRoot, 'scripts', 'imagegen.py'),
        '--prompt', condensed,
        '--negative', NEGATIVE_PROMPT,
        '--out', out,
      ], { timeout: Number(process.env.IMAGE_TIMEOUT_MS || 1800000) });
    }
    const bytes = await fs.readFile(out);
    return { image: { data: bytes.toString('base64'), mimeType: 'image/png', bytes: bytes.length } };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function scrapePage({ url }) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ComoAsiBot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const html = await response.text();
    return { status: response.status, text: htmlToText(html) };
  } catch {
    return { status: 599, text: '' };
  }
}
