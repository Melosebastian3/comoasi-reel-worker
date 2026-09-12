import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from './db.js';
import { failJob, setJobProgress, setJobStage } from './pipeline.js';
import { getAssetUrl, studioCall, uploadAsset, writeBase64File } from './engine.js';
import { createNarrationAudio, renderReel } from './render.js';

const running = new Set();

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
  return index === 19 ? 'remate' : index % 4 === 0 ? 'golpe' : index % 4 === 1 ? 'suspenso' : index % 4 === 2 ? 'veneno' : 'incredula';
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

function storyValidationIssue(story) {
  if (!story || !Array.isArray(story.scenes) || story.scenes.length !== 20) return 'scene_shape';
  if (story.scenes.some(scene => !validDeliveries.has(String(scene?.delivery || '')))) return 'delivery';
  const stats = storyLanguageStats(story);
  if (stats.english >= 6 && stats.english > Math.max(5, Math.ceil(stats.spanish * 0.55))) return 'language';
  return null;
}

function storyNeedsRegeneration(story) {
  return Boolean(storyValidationIssue(normalizeStory(story)));
}

async function downloadTo(url, filePath) {
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
  if (job.reel_id) {
    const { rows } = await query(
      `update comoasi.reels set category=$2, topic=$3, title=$4, hook=$5, viral_score=$6, visual_score=$7, status='researching', updated_at=now() where id=$1 returning *`,
      [job.reel_id, topicData.category, topicData.topic, topicData.title || null, topicData.hook || null, topicData.viralScore ?? null, topicData.visualScore ?? null]
    );
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

async function resolveTopic(payload) {
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

async function obtainSceneImage({ reelId, scene, index, workDir, topic, protagonist }) {
  const assetPath = `reels/${reelId}/scenes/scene-${String(index + 1).padStart(2, '0')}.png`;
  const localPath = path.join(workDir, `scene-${String(index + 1).padStart(2, '0')}.png`);
  if (scene.assetPath) {
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
      { topic, protagonist, visualPrompt: scene.visualPrompt },
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

async function processJob(id) {
  if (running.has(id)) return;
  running.add(id);
  let workDir;
  try {
    let job = await getJob(id);
    if (!job) throw new Error('job_not_found');
    const payload = job.payload || {};
    workDir = path.join(os.tmpdir(), 'comoasi', String(id));
    await fs.mkdir(workDir, { recursive: true });

    await setJobStage(id, 'topic');
    const topicData = job.result?.topicData || await resolveTopic(payload);
    await ensureNoHardDuplicate(topicData, Boolean(payload.force));
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
      for (let storyAttempt = 1; storyAttempt <= 3; storyAttempt += 1) {
        const candidate = normalizeStory(await studioCall('/api/engine/story', {
          topic: topicData.topic,
          title: topicData.title,
          hook: topicData.hook,
          protagonist: topicData.protagonist,
          research,
          strictSpanish: storyAttempt > 1,
        }, { timeoutMs: 240000, attempts: 5 }));
        const issue = storyValidationIssue(candidate);
        if (!issue) {
          story = candidate;
          break;
        }
        const stats = storyLanguageStats(candidate);
        console.warn(`[como-asi] story validation rejected attempt ${storyAttempt}`, { issue, english: stats.english, spanish: stats.spanish, sample: stats.sample });
      }
    }
    if (!story) throw new Error('story_validation_failed_after_3_attempts');
    await persistJobResult(id, { story });

    const existingReel = await query('select storyboard from comoasi.reels where id=$1', [reel.id]);
    const savedScenes = reuseSavedStory && Array.isArray(existingReel.rows[0]?.storyboard) ? existingReel.rows[0].storyboard : [];
    const scenes = story.scenes.map((scene, index) => ({
      ...scene,
      index: index + 1,
      ...(savedScenes[index]?.assetPath ? { assetPath: savedScenes[index].assetPath } : {}),
    }));

    await query(
      `update comoasi.reels set title=$2, hook=$3, narration=$4, storyboard=$5::jsonb, scene_count=20, updated_at=now() where id=$1`,
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
    const voicePath = await createNarrationAudio(
      workDir,
      scenes,
      process.env.TTS_VOICE || 'es-CO-SalomeNeural',
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
    let coverAssetPath = job.result?.coverAssetPath;
    const coverLocal = path.join(workDir, 'cover.png');
    if (coverAssetPath) {
      try {
        await downloadTo(await getAssetUrl(coverAssetPath), coverLocal);
      } catch {
        coverAssetPath = null;
      }
    }
    if (!coverAssetPath) {
      const cover = await studioCall('/api/engine/cover', { topic: topicData.topic, title: story.title || topicData.title, protagonist: topicData.protagonist }, { timeoutMs: 240000, attempts: 5 });
      await writeBase64File(coverLocal, cover.data);
      coverAssetPath = `covers/${reel.id}/cover.png`;
      await uploadAsset(coverAssetPath, coverLocal, cover.mimeType || 'image/png');
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
  const { rows } = await query(
    `select id from comoasi.reel_jobs
      where status='queued'
      order by created_at asc
      limit 2`
  );
  rows.forEach(row => startJob(row.id));
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
  const { rows } = await query(`select id from comoasi.reel_jobs where status in ('queued','running') order by created_at asc limit 10`);
  rows.forEach(row => startJob(row.id));
  return rows.length;
}
