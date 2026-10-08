// Test-only OpenAI-compatible server. Returns schema-shaped JSON with a fictional story
// so the batch can run end to end without downloading a model.
import http from 'node:http';

const DELIVERIES = ['golpe', 'veneno', 'suspenso', 'incredula', 'veneno', 'golpe', 'veneno', 'suspenso',
  'incredula', 'veneno', 'golpe', 'suspenso', 'veneno', 'incredula', 'golpe', 'remate'];
const LINES = [
  'Lucho Brillo vendió su gira y la cancelo dos veces',
  'El cantante ficticio anunció un regreso que nadie pidió',
  'Las entradas costaban como un auto usado',
  'Pero el escenario era un garaje con luces de feria',
  'Mala Fama abre el expediente con una sonrisa',
  'El público pagó por la nostalgia y recibió excusas',
  'Su equipo dijo que todo era una estrategia de marketing',
  'Una estrategia que consistía en no aparecer nunca',
  'La marca de agua patrocinadora retiró su logo en vivo',
  'Y él publicó una foto comiendo langosta esa noche',
  'Los fans pidieron reembolso y recibieron un sticker',
  'Giro total: la gira tenía un documental pagado aparte',
  'El documental mostraba ensayos para un show que no existió',
  'Hasta aquí todo normal para el ego más caro del pop',
  'El reembolso llegó, pero en cupones para su próxima gira',
  'Sentencia final: Lucho Brillo cobra por desaparecer con estilo',
];
const HOST = new Set([0, 4, 8, 12, 15]);

function fromSchema(schema, key = '') {
  if (!schema) return 'texto';
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object') {
    const out = {};
    for (const [name, sub] of Object.entries(schema.properties || {})) out[name] = fromSchema(sub, name);
    return out;
  }
  if (key === 'sourceIndexes') return [0, 1];
  if (schema.type === 'array') {
    const n = schema.minItems || 2;
    return Array.from({ length: n }, () => fromSchema(schema.items, key));
  }
  if (schema.type === 'number' || schema.type === 'integer') return 95;
  if (schema.type === 'boolean') return true;
  return `Dato ficticio de prueba para ${key || 'campo'} sobre Lucho Brillo`;
}

function answer(schema) {
  const props = schema?.properties || {};
  if (props.scenes) {
    const scenes = LINES.map((narration, index) => ({
      index: index + 1,
      narration,
      visualPrompt: HOST.has(index) ? 'HOST_SCENE: Mala Fama sonríe con desprecio' : 'Cantante ficticio frente a un garaje con luces de feria',
      purpose: 'prueba',
      durationSeconds: 4,
      delivery: DELIVERIES[index],
    }));
    return { title: 'Lucho Brillo y la gira fantasma', coverDeck: 'Gira fantasma', hook: LINES[0], narration: LINES.join(' '), scenes, closingLine: LINES[15] };
  }
  if (props.subject) return { subject: 'fictional pop singer on a tiny garage stage with carnival lights' };
  const value = fromSchema(schema);
  if ('recognitionReason' in value) value.recognitionReason = 'Personaje ficticio usado solo en pruebas.';
  for (const key of ['topic', 'title', 'protagonist']) if (key in value) value[key] = key === 'protagonist' ? 'Lucho Brillo (ficticio)' : 'La gira fantasma de Lucho Brillo';
  return value;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const request = JSON.parse(body || '{}');
    const content = JSON.stringify(answer(request.response_format?.schema));
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < content.length; i += 200) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 200) } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
}).listen(Number(process.env.PORT || 8089), () => console.log('mock llm ready'));
