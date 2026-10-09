import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';
import { failJob, setJobProgress, setJobStage } from './pipeline.js';
import { getAssetUrl, studioCall, uploadAsset, writeBase64File } from './engine.js';
import { createNarrationAudio, renderReel } from './render.js';

const running = new Set();
const VISUAL_STYLE_REV = 'mala-fama-devil-v1';
const NARRATOR_VOICE = 'es-MX-JorgeNeural';

function normalizeTopic(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const validDeliveries = new Set(['golpe', 'veneno', 'suspenso', 'incredula', 'remate']);

function normalizeDelivery(value, index) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (validDeliveries.has(normalized)) return normalized;
  if (/incredul|sorpresa|asombro/.test(normalized)) return 'incredula';
  if (/veneno|sarcas|ironi/.test(normalized)) return 'veneno';
  if (/suspenso|tension|pausa/.test(normalized)) return 'suspenso';
  if (/remate|cierre|punch/.test(normalized)) return 'remate';
  return index === 15 ? 'remate' : index % 4 === 0 ? 'golpe' : index % 4 === 1 ? 'suspenso' : index % 4 === 2 ? 'veneno' : 'incredula';
}

function normalizeStory(story) {
  if (!story || !Array.isArray(story.scenes)) return story;
  return {
    ...story,
    scenes: story.scenes.map((scene, index) => ({
      ...scene,
      delivery: normalizeDelivery(scene?.delivery, index),
    })),
  };
}

function storyLanguageStats(story) {
  const narration = Array.isArray(story?.scenes)
    ? story.scenes.map(scene => String(scene?.narration || '')).join(' ')
    : '';
  const englishSignals = narration.match(/\b(the|this|that|but|with|they|their|what|are|was|were|using|would|because|people|some|others|gets|paid|watch|buy|models|brand|sales|haven't|isn't|don't)\b/gi) || [];
  const spanishSignals = narration.match(/\b(el|la|los|las|esto|pero|con|que|por|para|una|un|es|son|esta|estas|este|está|están|porque|gente|marca|ventas|como|cuando|quien|ahora|hasta|nada|todo|dijo|hizo)\b/gi) || [];
  return { english: englishSignals.length, spanish: spanishSignals.length, sample: narration.slice(0, 220) };
}

// Tells the next attempt exactly what the validator rejected (local open models need it spelled out).
function storyRepairNote(story, issue) {
  const lines = Array.isArray(story?.scenes) ? story.scenes.map(scene => String(scene?.narration || '').trim()) : [];
  const words = lines.join(' ').split(/\s+/).filter(Boolean).length;
  const notes = {
    scene_shape: `devolvió ${lines.length} escenas; deben ser exactamente 16.`,
    runtime: `las narraciones sumaban ${words} palabras; deben sumar entre 150 y 240.`,
    weak_hook: 'la escena 1 era demasiado larga; debe tener menos de 20 palabras.',
    open_ending: 'la escena 16 terminaba en pregunta o era muy corta; debe cerrar con una afirmación de al menos 5 palabras.',
    too_many_questions: `había ${(lines.join(' ').match(/\?/g) || []).length} preguntas; como máximo 2.`,
    empty_scene: 'alguna escena no tenía narración.',
    language: 'había demasiadas palabras en inglés.',
    repetitive: 'repetía las mismas frases en varias escenas; cada escena debe decir algo distinto (un dato nuevo, una opinión o un remate).',
  };
  return notes[issue] || `fue rechazado por: ${issue}.`;
}

function storyValidationIssue(story) {
  if (!story || !Array.isArray(story.scenes) || story.scenes.length !== 16) return 'scene_shape';
  if (story.scenes.some(scene => !validDeliveries.has(String(scene?.delivery || '')))) return 'delivery';
  // A script repeating the same line is not publishable (2026-10-09 test: 16 scenes, 3 distinct lines).
  const distinct = new Set(story.scenes.map(scene => String(scene?.narration || '').toLowerCase().replace(/[^a-z0-9áéíóúñ]+/g, ' ').trim()));
  if (distinct.size < 14) return 'repetitive';
  const stats = storyLanguageStats(story);
  if (stats.english >= 6 && stats.english > Math.max(5, Math.ceil(stats.spanish * 0.55))) return 'language';

  const lines = story.scenes.map(scene => String(scene?.narration || '').replace(/\s+/g, ' ').trim());
  if (lines.some(line => !line)) return 'empty_scene';
  const narration = lines.join(' ');
  const words = narration.split(/\s+/).filter(Boolean).length;
  if (words < 100 || words > 275) return 'runtime';
  if (lines[0].split(/\s+/).length > 24) return 'weak_hook';
  if (/\?$/.test(lines[15]) || lines[15].split(/\s+/).length < 5) return 'open_ending';
  const questions = (narration.match(/\?/g) || []).length;
  if (questions > 3) return 'too_many_questions';

  const stalePhrases = [
    /para entender (esto|lo ocurrido)/i,
    /la historia comienza/i,
    /en este contexto/i,
    /cabe destacar/i,
    /por si fuera poco/i,
    /pero eso no es todo/i,
    /las redes (sociales )?(estallaron|explotaron)/i,
    /se desató la polémica/i,
    /sí,? leíste bien/i,
    /como si fuera poco/i,
    /solo el tiempo dirá/i,
    /¿qué opinas\??$/i,
  ];
  if (stalePhrases.some(pattern => pattern.test(narration))) return 'generic_news_voice';

  const roastDeliveries = story.scenes.filter(scene => ['veneno', 'remate'].includes(String(scene?.delivery || ''))).length;
  if (roastDeliveries < 5 || String(story.scenes[15]?.delivery || '') !== 'remate') return 'not_enough_payoffs';
  return null;
}

function storyNeedsRegeneration(story) {
  return Boolean(storyValidationIssue(normalizeStory(story)));
}

async function downloadTo(url, filePath) {
  if (String(url).startsWith('file:')) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.copyFile(fileURLToPath(url), filePath);
    return filePath;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`asset_download_failed_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return filePath;
}

async function getJob(id) {
  const { rows } = await query('select * from comoasi.reel_jobs where id=$1', [id]);
  return rows[0] || null;
}

async function persistJobResult(id, patch) {
  const { rows } = await query(
    `update comoasi.reel_jobs set result=result || $2::jsonb, updated_at=now() where id=$1 returning *`,
    [id, JSON.stringify(patch || {})]
  );
  return rows[0];
}

async function upsertReel(job, topicData) {
  let reelId = job.reel_id;
  if (!reelId) {
    const existing = await query('select id from comoasi.reels where worker_job_id=$1 limit 1', [String(job.id)]);
    reelId = existing.rows[0]?.id || null;
  }
  if (reelId) {
    const { rows } = await query(
      `update comoasi.reels set category=$2, topic=$3, title=$4, hook=$5, viral_score=$6, visual_score=$7, status='researching', updated_at=now() where id=$1 returning *`,
      [reelId, topicData.category, topicData.topic, topicData.title || null, topicData.hook || null, topicData.viralScore ?? null, topicData.visualScore ?? null]
    );
    await query('update comoasi.reel_jobs set reel_id=$2, updated_at=now() where id=$1', [job.id, reelId]);
    await persistJobResult(job.id, { reelId });
    return rows[0];
  }
  const { rows } = await query(
    `insert into comoasi.reels(category, topic, title, hook, viral_score, visual_score, status, worker_job_id)
     values($1,$2,$3,$4,$5,$6,'researching',$7) returning *`,
    [topicData.category, topicData.topic, topicData.title || null, topicData.hook || null, topicData.viralScore ?? null, topicData.visualScore ?? null, String(job.id)]
  );
  await query('update comoasi.reel_jobs set reel_id=$2, updated_at=now() where id=$1', [job.id, rows[0].id]);
  await persistJobResult(job.id, { reelId: rows[0].id });
  return rows[0];
}

async function loadMemory() {
  const [memory, learning] = await Promise.all([
    query(`select topic, normalized_topic as "normalizedTopic", category, protagonist, event_key as "eventKey", angle, subtopic, period_label as "periodLabel", narrative_question as "narrativeQuestion", created_at as "createdAt" from comoasi.editorial_memory order by created_at desc limit 60`),
    query(`select category, pattern_type as "patternType", pattern_key as "patternKey", score, sample_size as "sampleSize", metrics from comoasi.viral_learning order by score desc limit 40`),
  ]);
  return { memory: memory.rows, learning: learning.rows };
}

async function resolveTopic(payload, avoid = []) {
  const category = String(payload.category || 'actualidad');
  if (payload.topic) {
    const topic = String(payload.topic).trim();
    return {
      category,
      topic,
      normalizedTopic: normalizeTopic(topic),
      protagonist: payload.protagonist || '',
      eventKey: payload.eventKey || normalizeTopic(topic),
      angle: payload.angle || '',
      subtopic: payload.subtopic || '',
      periodLabel: payload.periodLabel || '',
      narrativeQuestion: payload.narrativeQuestion || '',
      hook: payload.hook || '',
      title: payload.title || topic,
      viralScore: payload.viralScore ?? null,
      visualScore: payload.visualScore ?? null,
      rationale: 'Tema manual del proyecto ¿Cómo Así?.',
    };
  }
  const context = await loadMemory();
  // Topics already rejected as duplicates in this job go first so the model sees them.
  context.memory = [...avoid, ...context.memory];
  context.avoid = avoid;
  return studioCall('/api/engine/topic', { category, ...context }, { timeoutMs: 180000, attempts: 5 });
}

async function ensureNoHardDuplicate(topicData, force = false) {
  if (force) return;
  const normalized = normalizeTopic(topicData.normalizedTopic || topicData.topic);
  const { rows } = await query(
    `select id, topic from comoasi.editorial_memory where normalized_topic=$1 and status in ('generated','published') order by created_at desc limit 1`,
    [normalized]
  );
  if (rows[0]) throw new Error(`duplicate_topic_blocked:${rows[0].topic}`);
}

const visualBeatDirections = [
  'Cold open de comedia: Mala Fama acciona una palanca, corta una cinta o destapa una evidencia mientras el famoso queda atrapado en la consecuencia visual del caso. Composición diagonal, acción congelada y golpe inmediato; evitar boca abierta genérica.',
  'Hecho uno: recrear una acción pública verificable del famoso con entorno, objetos y extras específicos. El humor nace de una escala absurdamente exagerada, no de una pose.',
  'Primer roast visual: convertir la contradicción pública en una metáfora física única —ego inflable, pedestal inestable, alfombra roja convertida en trampa o lujo que se derrumba— con el famoso intentando mantener la dignidad.',
  'Prueba: plano macro del objeto o gesto decisivo invadiendo el encuadre; detrás, el famoso intenta ocultarlo, arreglarlo o fingir normalidad. Expresión distinta a sorpresa.',
  'Escalada: el problema crece literalmente alrededor del protagonista como una máquina fuera de control, una montaña de consecuencias o un escenario que se desarma.',
  'Mala Fama en su mesa de autopsia del chisme: pincha el ego inflable del famoso con un alfiler verde mientras señala una prueba real. Sonrisa contenida, no cara de susto.',
  'Hecho dos: escena pública concreta vista con lente angular y movimiento; el famoso negocia, huye, presume o sostiene la fachada según el relato.',
  'Segundo roast visual: una comparación cruel del guion se vuelve una situación surrealista coherente en un solo espacio. Humor de estatus y contradicción, jamás collage.',
  'Giro de poder: el famoso sobre un pedestal demasiado alto que comienza a inclinarse mientras el entorno sigue con indiferencia. Gesto de control perdido, boca cerrada.',
  'Revelación: una puerta, telón, caja fuerte u objeto del caso descubre la pieza faltante; los demás reaccionan de formas diferentes, no todos sorprendidos.',
  'Mala Fama cobra el chiste: entra en acción con cronómetro, lupa o sello de veredicto y remata la consecuencia al fondo. Mirada de “ya lo sabía”, sonrisa venenosa.',
  'Choque: personajes reconocibles defienden versiones opuestas mediante lenguaje corporal fuerte en un lugar público; tensión absurda sin inventar agresión física.',
  'Daño al ego: mostrar reputación, lujo o pose desinflándose como metáfora editorial mientras el hecho comprobado permanece sólido en primer plano.',
  'Consecuencia real: el protagonista resuelve, niega, abandona o posa después del golpe; fotógrafos y público hacen cosas distintas para crear una escena viva.',
  'Callback visual: recuperar un objeto o metáfora de la apertura, ahora invertido y más ridículo, para preparar el cierre y hacer sentir que hubo historia.',
  'Veredicto con punto final: Mala Fama baja una cortina, apaga el micrófono o estampa un sello mientras el famoso queda dentro de la consecuencia final. Imagen icónica, sonrisa seca, cero pregunta abierta.'
];

function buildDynamicVisualPrompt({ scene, index, topic, protagonist }) {
  const hostScene = /\bHOST_SCENE\b/i.test(String(scene?.visualPrompt || '')) || [0, 4, 8, 12, 15].includes(index);
  const identity = hostScene
    ? 'Mala Fama es siempre el mismo presentador masculino y diablo animado editorial adulto: rostro anguloso color borgoña oscuro, dos cuernos negros pulidos curvados hacia atrás, ojos verde ácido, cabello negro peinado hacia atrás con una mecha blanca, barba puntiaguda corta, traje negro entallado, camisa magenta, guantes negros, pañuelo verde ácido, cola fina terminada en punta y micrófono de metal ennegrecido. Sonrisa lateral de verdugo, ceja levantada y presencia dominante. Debe señalar pruebas, accionar el gag o dictar sentencia; jamás parecer mujer, humano corriente, personaje infantil, monstruo realista ni copia de una franquicia.'
    : 'No mostrar al conductor Mala Fama en esta escena; concentrarse en el protagonista, la acción o la prueba.';
  const famous = protagonist
    ? `La figura pública ${protagonist} debe ser reconocible de inmediato: conservar forma del rostro, peinado, mirada y rasgos icónicos, pero exagerarlos con intención cómica y expresión escandalosa; jamás sustituirla por una persona genérica.`
    : 'Si existe una figura pública central, debe ser reconocible de inmediato y aparecer como caricatura exagerada; nunca usar rostros genéricos.';
  return [
    'Fotograma vertical 9:16 de una secuencia de chisme visual de ritmo alto.',
    visualBeatDirections[index % visualBeatDirections.length],
    famous,
    identity,
    `Tema: ${topic}.`,
    `Acción específica de esta escena: ${String(scene?.visualPrompt || scene?.narration || '').trim()}.`,
    'ESTILO OBLIGATORIO: caricatura editorial feroz y premium, exagerada como una portada satírica de alto presupuesto. El famoso debe conservar sus rasgos icónicos y ser reconocible, pero con cabeza, ego, accesorios y lenguaje corporal llevados al absurdo. La imagen tiene que contener un chiste visual específico, no limitarse a ilustrar el dato.',
    'Continuidad visual: tinta negra expresiva, recortes de papel, semitono impreso, paleta magenta, verde lima, crema y azul noche, luz teatral, lente angular, primer plano agresivo, profundidad y movimiento congelado.',
    'Rotar emociones en toda la secuencia: suficiencia, fastidio, falsa calma, pánico contenido, orgullo herido, cálculo y derrota elegante. Máximo dos escenas con boca abierta de sorpresa; evitar repetir manos en la cara.',
    'La burla recae en ego, pose, lujo, privilegio, dramatismo, estrategia pública o contradicción verificable; nunca en raza, nacionalidad, religión, discapacidad, cuerpo u otra característica protegida.',
    'Prohibido: fotorrealismo, anime, rostro genérico, retrato frontal estático, persona centrada posando, fondo vacío, póster, cuadrícula, díptico, viñetas, texto, titulares legibles, logos o marcas de agua.',
    'No inventar delitos, intimidad ni hechos dañinos: representar controversias no verificadas mediante reacción, contexto público o metáfora visual.'
  ].join(' ');
}

async function obtainSceneImage({ reelId, scene, index, workDir, topic, protagonist }) {
  const assetPath = `reels/${reelId}/scenes/${VISUAL_STYLE_REV}/scene-${String(index + 1).padStart(2, '0')}.png`;
  const localPath = path.join(workDir, `scene-${String(index + 1).padStart(2, '0')}.png`);
  if (scene.assetPath === assetPath) {
    try {
      const url = await getAssetUrl(scene.assetPath);
      await downloadTo(url, localPath);
      return { localPath, assetPath: scene.assetPath, reused: true };
    } catch {
      // Regenerate safely if a prior asset is unavailable.
    }
  }
  let generated;
  try {
    generated = await studioCall(
      '/api/engine/image',
      { topic, protagonist, visualPrompt: buildDynamicVisualPrompt({ scene, index, topic, protagonist }) },
      { timeoutMs: 240000, attempts: 3 }
    );
  } catch (primaryError) {
    console.warn(`[como-asi] scene ${index + 1} primary image failed; requesting symbolic fallback`, primaryError instanceof Error ? primaryError.message : String(primaryError));
    generated = await studioCall(
      '/api/engine/image',
      {
        topic: 'campaña viral y controversia de marketing',
        safeFallback: true,
        visualPrompt: 'Representación editorial simbólica mediante objetos, iluminación y metáforas visuales; ninguna persona real ni situación íntima.',
      },
      { timeoutMs: 240000, attempts: 4 }
    );
  }
  await writeBase64File(localPath, generated.data);
  await uploadAsset(assetPath, localPath, generated.mimeType || 'image/png');
  return { localPath, assetPath, reused: false };
}

export async function runJobNow(id) {
  return processJob(String(id));
}

async function processJob(id) {
  if (running.has(id) || running.size >= 1) return;
  running.add(id);
  let workDir;
  try {
    let job = await getJob(id);
    if (!job) throw new Error('job_not_found');
    const payload = job.payload || {};
    workDir = path.join(os.tmpdir(), 'comoasi', String(id));
    await fs.mkdir(workDir, { recursive: true });

    await setJobStage(id, 'topic');
    let topicData = job.result?.topicData;
    if (!topicData) {
      // A smaller model sometimes repeats a topic from the memory it was given; ask again
      // with the rejected topic listed instead of failing the whole slot.
      // Stories already made in the last two days are left out from the start, so the three
      // daily slots do not keep landing on the same dominant headline.
      const recent = await query(
        `select topic, normalized_topic as "normalizedTopic", protagonist, category, event_key as "eventKey" from comoasi.editorial_memory
         where status in ('generated','published') and created_at > now() - interval '48 hours' order by created_at desc limit 12`
      );
      const avoid = [...recent.rows];
      for (let attempt = 1; ; attempt += 1) {
        try {
          topicData = await resolveTopic(payload, avoid);
        } catch (topicError) {
          // The local model sometimes picks a story it cannot tie to a headline; just ask again.
          if (attempt >= 4 || !/topic_not_grounded_in_sources|recognizable_protagonist_unavailable/.test(String(topicError.message))) throw topicError;
          console.warn(`[como-asi] ${topicError.message}; asking for another topic (${attempt}/4)`);
          // An unsupported story is avoided on the next try, like a duplicate.
          const rejected = String(topicError.message).split('|')[1];
          if (rejected) { try { avoid.push(JSON.parse(rejected)); } catch {} }
          continue;
        }
        try {
          await ensureNoHardDuplicate(topicData, Boolean(payload.force));
          break;
        } catch (duplicateError) {
          if (attempt >= 4 || !String(duplicateError.message).startsWith('duplicate_topic_blocked')) throw duplicateError;
          console.warn(`[como-asi] ${duplicateError.message}; asking for another topic (${attempt}/4)`);
          avoid.push({ topic: topicData.topic, normalizedTopic: normalizeTopic(topicData.normalizedTopic || topicData.topic), protagonist: topicData.protagonist, category: topicData.category, eventKey: topicData.eventKey });
        }
      }
    } else {
      await ensureNoHardDuplicate(topicData, Boolean(payload.force));
    }
    await persistJobResult(id, { topicData });
    job = await getJob(id);
    const reel = await upsertReel(job, topicData);

    await setJobStage(id, 'research');
    const research = job.result?.research || await studioCall('/api/engine/research', {
      topic: topicData.topic,
      angle: topicData.angle,
      protagonist: topicData.protagonist,
      eventKey: topicData.eventKey,
      narrativeQuestion: topicData.narrativeQuestion,
      sources: Array.isArray(topicData.sources) ? topicData.sources : [],
    }, { timeoutMs: 180000, attempts: 5 });
    await persistJobResult(id, { research });
    await query(`update comoasi.reels set research=$2::jsonb, status='generating', updated_at=now() where id=$1`, [reel.id, JSON.stringify(research)]);

    await setJobStage(id, 'narration');
    const savedStory = normalizeStory(job.result?.story);
    let story = savedStory && !storyNeedsRegeneration(savedStory) ? savedStory : null;
    const reuseSavedStory = Boolean(story);
    if (!story) {
      let repairNote = '';
      for (let storyAttempt = 1; storyAttempt <= 4; storyAttempt += 1) {
        const candidate = normalizeStory(await studioCall('/api/engine/story', {
          topic: topicData.topic,
          title: topicData.title,
          hook: topicData.hook,
          protagonist: topicData.protagonist,
          research: {
            ...research,
            editorialMandate: {
              show: '¿Cómo Así?',
              host: 'Mala Fama',
              identity: 'Mala Fama es un presentador masculino y diablo animado adulto: elegante, siniestro, voz de ultratumba, humor de verdugo y cero tono de amiga chismosa. Abre el expediente, exhibe la contradicción y dicta sentencia.',
              genre: 'Comedia negra de actualidad y roast de celebridades. El dato es la munición; el entretenimiento es el producto.',
              intensity: storyAttempt === 1 ? 'alto' : storyAttempt === 2 ? 'muy alto' : 'sin piedad editorial',
              architecture: [
                'Escena 1: cold open de 7 a 14 palabras con nombre, desastre y una sentencia cómica; nada de contexto.',
                'Escenas 2-4: tres hechos concretos. Cada hecho recibe un remate breve en la misma frase o en la siguiente.',
                'Escena 5: primer golpe fuerte: comparación visual inesperada que rebaje la pose, no a la persona.',
                'Escenas 6-8: Mala Fama conecta pruebas, escala el absurdo y cierra el primer acto con un punchline.',
                'Escenas 9-11: giro o contradicción. Alternar dato y roast; jamás encadenar más de dos frases informativas.',
                'Escenas 12-14: consecuencia verificable y el remate más negro permitido por el tema, sin bromear con víctimas ni tragedias.',
                'Escena 15: callback exacto a una imagen, objeto o frase de la apertura.',
                'Escena 16: veredicto de Mala Fama, corto, citable y definitivo. Punto final; no pregunta ni invitación a comentar.'
              ],
              jokeMechanics: [
                'Construir al menos seis payoffs claros: exageración, analogía cruel, inversión de estatus, regla de tres, falsa solemnidad y callback.',
                'La premisa factual debe entenderse antes del chiste; el remate debe ir al final de la frase.',
                'Atacar ego, pose, privilegio, lujo absurdo, oportunismo o contradicción pública. Punch up, nunca contra víctimas.',
                'Usar imágenes mentales concretas y comparaciones nuevas. Si un remate podría servir para cualquier famoso, reescribirlo.',
                'Mala Fama habla como un fiscal del infierno con sentido del humor: presenta el hecho, saborea la contradicción y ejecuta el remate. Nunca suena amable, asombrado ni institucional.'
              ],
              voiceRules: [
                'Español latinoamericano neutro, natural al oído y sin modismos de Colombia, México, Argentina, España ni otro país.',
                'Frases hablables de 8 a 18 palabras, contracciones naturales, verbos activos y cambios de cadencia.',
                'No decir “sí, leíste bien”: es audio. Tampoco “por si fuera poco”, “pero eso no es todo”, “las redes explotaron” ni “se desató la polémica”.',
                'No usar insultos vacíos, moralejas, lenguaje escolar, frases de IA ni admiración de fan.',
                'No inventar delitos, romances, citas, intenciones ni hechos; la comedia interpreta únicamente información verificada.'
              ],
              forbiddenTone: ['documental', 'locutora institucional', 'resumen de noticias', 'hilo explicativo', 'prudencia aburrida', 'chisme genérico sin remates']
            }
          },
          hostName: 'Mala Fama',
          tone: 'sátira negra panlatina, masculina, elegante, siniestra y despiadadamente venenosa',
          strictSpanish: storyAttempt > 1,
          repairNote,
        }, { timeoutMs: 240000, attempts: 5 }));
        const issue = storyValidationIssue(candidate);
        if (!issue) {
          story = candidate;
          break;
        }
        const stats = storyLanguageStats(candidate);
        console.warn(`[como-asi] story validation rejected attempt ${storyAttempt}`, { issue, english: stats.english, spanish: stats.spanish, sample: stats.sample });
        repairNote = storyRepairNote(candidate, issue);
        console.warn(`[como-asi] story repair note: ${repairNote}`);
      }
    }
    if (!story) throw new Error('story_validation_failed_after_4_attempts');
    await persistJobResult(id, { story });

    const existingReel = await query('select storyboard from comoasi.reels where id=$1', [reel.id]);
    const savedScenes = reuseSavedStory && Array.isArray(existingReel.rows[0]?.storyboard) ? existingReel.rows[0].storyboard : [];
    const scenes = story.scenes.map((scene, index) => ({
      ...scene,
      index: index + 1,
      ...(savedScenes[index]?.assetPath ? { assetPath: savedScenes[index].assetPath } : {}),
    }));

    await query(
      `update comoasi.reels set title=$2, hook=$3, narration=$4, storyboard=$5::jsonb, scene_count=16, updated_at=now() where id=$1`,
      [reel.id, story.title || topicData.title, story.hook || topicData.hook, story.narration || '', JSON.stringify(scenes)]
    );

    await setJobStage(id, 'storyboard');
    await setJobStage(id, 'scenes');
    const scenePaths = [];
    let reusedScenes = 0;
    for (let index = 0; index < scenes.length; index += 1) {
      const sceneResult = await obtainSceneImage({ reelId: reel.id, scene: scenes[index], index, workDir, topic: topicData.topic, protagonist: topicData.protagonist });
      if (sceneResult.reused) reusedScenes += 1;
      scenes[index].assetPath = sceneResult.assetPath;
      scenePaths.push(sceneResult.localPath);
      await query('update comoasi.reels set storyboard=$2::jsonb, updated_at=now() where id=$1', [reel.id, JSON.stringify(scenes)]);
      const sceneProgress = 48 + Math.round(((index + 1) / scenes.length) * 24);
      await setJobProgress(id, 'scenes', sceneProgress, { scenesCompleted: index + 1, reusedScenes });
    }

    await setJobStage(id, 'voice');
    console.info(`[como-asi] narrator voice locked: ${NARRATOR_VOICE}`);
    const voicePath = await createNarrationAudio(
      workDir,
      scenes,
      NARRATOR_VOICE,
      topicData.category,
      async (completed, total) => {
        const voiceProgress = 80 + Math.min(6, Math.round((completed / total) * 6));
        await setJobProgress(id, 'voice', voiceProgress, {
          voiceBlocksCompleted: completed,
          voiceBlocksTotal: total,
        });
      }
    );
    const voiceAssetPath = `audio/${reel.id}/voice.mp3`;
    await uploadAsset(voiceAssetPath, voicePath, 'audio/mpeg');
    await persistJobResult(id, { voiceAssetPath });

    await setJobStage(id, 'cover');
    const expectedCoverAssetPath = `covers/${reel.id}/${VISUAL_STYLE_REV}/cover.png`;
    let coverAssetPath = job.result?.coverAssetPath === expectedCoverAssetPath
      ? expectedCoverAssetPath
      : null;
    const coverLocal = path.join(workDir, 'cover.png');
    if (coverAssetPath) {
      try {
        await downloadTo(await getAssetUrl(coverAssetPath), coverLocal);
      } catch {
        coverAssetPath = null;
      }
    }
    if (!coverAssetPath) {
      const coverPrompt = [
        'HOST_SCENE: Portada vertical 9:16 para un show latino de sátira de celebridades, sin texto.',
        'Mala Fama domina el primer plano: presentador masculino y diablo animado editorial adulto, rostro anguloso borgoña oscuro, dos cuernos negros pulidos curvados hacia atrás, ojos verde ácido, cabello negro hacia atrás con una mecha blanca, barba puntiaguda corta, traje negro entallado, camisa magenta, guantes negros, pañuelo verde ácido, cola fina terminada en punta y micrófono de metal ennegrecido.',
        'Expresión de desprecio divertido: sonrisa lateral de verdugo, una ceja levantada, mirada dominante y boca cerrada. Nunca mujer, humano corriente, personaje infantil, monstruo terrorífico realista ni copia de una franquicia.',
        topicData.protagonist
          ? `A su lado aparece ${topicData.protagonist}, reconocible de inmediato pero caricaturizado de forma feroz, atrapado en una metáfora visual específica del escándalo.`
          : 'A su lado aparece la figura pública central, reconocible y caricaturizada de forma feroz, atrapada en una metáfora visual específica del escándalo.',
        `Tema: ${topicData.topic}. Conflicto visual: ${story.coverDeck || story.hook || topicData.hook || story.title || topicData.title}.`,
        'Composición premium de póster editorial: choque cara a cara, diagonales fuertes, profundidad, iluminación teatral, espacio limpio en el tercio inferior para el titular añadido después.',
        'Caricatura editorial exagerada de alto presupuesto, tinta negra expresiva, recortes de papel, semitono fino, magenta, verde lima, crema y azul noche.',
        'Una sola escena coherente. Prohibido: texto, logos, marcas de agua, collage, cuadrícula, anime, fotorrealismo, pose frontal estática o boca abierta genérica.'
      ].join(' ');
      try {
        const generatedCover = await studioCall(
          '/api/engine/image',
          {
            topic: topicData.topic,
            protagonist: topicData.protagonist,
            visualPrompt: coverPrompt,
            visualStyleRevision: VISUAL_STYLE_REV,
          },
          { timeoutMs: 240000, attempts: 4 }
        );
        await writeBase64File(coverLocal, generatedCover.data);
      } catch (coverError) {
        console.warn('[como-asi] dedicated cover failed; using fresh opening scene', coverError instanceof Error ? coverError.message : String(coverError));
        await fs.copyFile(scenePaths[0], coverLocal);
      }
      coverAssetPath = expectedCoverAssetPath;
      await uploadAsset(coverAssetPath, coverLocal, 'image/png');
      await persistJobResult(id, { coverAssetPath });
    }
    await query('update comoasi.reels set cover=$2::jsonb, updated_at=now() where id=$1', [reel.id, JSON.stringify({ assetPath: coverAssetPath, title: story.title || topicData.title, deck: story.coverDeck || '' })]);

    await setJobStage(id, 'render');
    await query(`update comoasi.reels set status='rendering', updated_at=now() where id=$1`, [reel.id]);
    const finalPath = await renderReel({
      workDir,
      coverPath: coverLocal,
      scenePaths,
      scenes,
      narrationPath: voicePath,
      category: topicData.category,
      title: story.title || topicData.title,
      coverDeck: story.coverDeck || '',
    });
    const videoAssetPath = `reels/${reel.id}/final.mp4`;
    await uploadAsset(videoAssetPath, finalPath, 'video/mp4');
    await persistJobResult(id, { videoAssetPath });

    await setJobStage(id, 'publishing-kit');
    const publishingKit = await studioCall('/api/engine/publishing-kit', {
      topic: topicData.topic,
      title: story.title || topicData.title,
      narration: story.narration || '',
    }, { timeoutMs: 180000, attempts: 5 });
    await query(
      `update comoasi.reels set publishing_kit=$2::jsonb, video_object_key=$3, status='ready', updated_at=now() where id=$1`,
      [reel.id, JSON.stringify(publishingKit), videoAssetPath]
    );

    await query(
      `insert into comoasi.editorial_memory(topic, normalized_topic, category, protagonist, event_key, angle, subtopic, period_label, narrative_question, status, source)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated','comoasi')`,
      [topicData.topic, normalizeTopic(topicData.normalizedTopic || topicData.topic), topicData.category, topicData.protagonist || null, topicData.eventKey || null, topicData.angle || null, topicData.subtopic || null, topicData.periodLabel || null, topicData.narrativeQuestion || null]
    );

    await setJobStage(id, 'completed', { reelId: reel.id, videoAssetPath, publishingKit });
  } catch (jobError) {
    console.error('[como-asi] job failed', id, jobError);
    await failJob(id, jobError instanceof Error ? jobError.message : String(jobError));
  } finally {
    running.delete(id);
    if (workDir) fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function startJob(id) {
  processJob(String(id)).catch(jobError => console.error('[como-asi] background job crash', id, jobError));
}

async function dispatchQueuedJobs() {
  if (running.size >= 1) return 0;
  const { rows } = await query(
    `select id from comoasi.reel_jobs
      where status='queued'
      order by created_at asc
      limit 1`
  );
  if (rows[0]) startJob(rows[0].id);
  return rows.length;
}

let dispatcherTimer = null;
let dispatcherBusy = false;

export function startQueueDispatcher(intervalMs = 5000) {
  if (dispatcherTimer) return;
  const tick = async () => {
    if (dispatcherBusy) return;
    dispatcherBusy = true;
    try {
      await dispatchQueuedJobs();
    } catch (error) {
      console.error('[como-asi] queue dispatcher failed', error);
    } finally {
      dispatcherBusy = false;
    }
  };
  void tick();
  dispatcherTimer = setInterval(tick, intervalMs);
  dispatcherTimer.unref?.();
  console.log(`[como-asi] durable queue dispatcher active every ${intervalMs}ms`);
}

export async function recoverJobs() {
  const { rows: orphanedRunning } = await query(`
    update comoasi.reel_jobs
       set status='queued',
           stage='queued',
           error=null,
           updated_at=now()
     where status='running'
     returning id
  `);
  if (orphanedRunning.length) {
    console.info(`[como-asi] requeued ${orphanedRunning.length} orphaned running job(s) after restart`);
  }
  const { rows: recoveredUploads } = await query(`
    update comoasi.reel_jobs
       set status='queued',
           stage='queued',
           progress=0,
           error=null,
           completed_at=null,
           result=coalesce(result, '{}'::jsonb) || jsonb_build_object('assetUploadAutoRecoveryV2At', now()),
           updated_at=now()
     where status='failed'
       and (
         error like '%/api/assets/write failed%'
         or error like '%/api/assets/chunk failed%'
         or error like '%/api/assets/commit failed%'
       )
       and updated_at > now() - interval '24 hours'
       and not (coalesce(result, '{}'::jsonb) ? 'assetUploadAutoRecoveryV2At')
     returning id
  `);
  if (recoveredUploads.length) {
    console.info(`[como-asi] auto-requeued ${recoveredUploads.length} asset upload job(s) after transport fix`);
  }
  const { rows: recoveredRenders } = await query(`
    update comoasi.reel_jobs
       set status='queued',
           stage='queued',
           progress=0,
           error=null,
           completed_at=null,
           result=coalesce(result, '{}'::jsonb) || jsonb_build_object('ffmpegRecoveryAt', now()),
           updated_at=now()
     where status='failed'
       and (error like '%ffmpeg exited%' or error like '%signal SIGKILL%' or error like '%timed out after%')
       and updated_at > now() - interval '24 hours'
       and not (coalesce(result, '{}'::jsonb) ? 'ffmpegRecoveryAt')
     returning id
  `);
  if (recoveredRenders.length) {
    console.info(`[como-asi] auto-requeued ${recoveredRenders.length} interrupted render job(s) with bounded resources`);
  }
  const { rows } = await query(`select id from comoasi.reel_jobs where status='queued' order by created_at asc limit 10`);
  if (rows[0]) startJob(rows[0].id);
  return rows.length;
}
