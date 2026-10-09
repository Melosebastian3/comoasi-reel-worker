import { generateJson } from './local/local-ai.js';
const t = Date.now();
const out = await generateJson({
  system: 'Eres MALA FAMA, un diablo presentador de chismes con humor negro.',
  prompt: 'Escribí un remate de humor negro de 12 palabras sobre un famoso que anuncia su quinto "último show" de despedida. Devolvé JSON.',
  schema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
  maxTokens: 400,
});
console.log('GROQ_PROBE', Date.now() - t, 'ms', JSON.stringify(out));
