import { generateJson, generateImage, scrapePage } from "./local-ai.js";
const ai = {
  generate: (opts) => generateJson(opts),
  imageGen: (opts) => generateImage(opts),
  scrape: (opts) => scrapePage(opts)
};
class EngineError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
const json = (data) => data;
const error = (message, status = 500) => {
  throw new EngineError(message, status);
};
function asBody(value) {
  return value && typeof value === "object" ? value : {};
}
function asString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function parseJsonText(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}
async function generateStructured(system, prompt, schema, maxTokens = 5e3) {
  return ai.generate({ system, prompt, schema, maxTokens, temperature: 0.45 });
}
function normalizedHashtags(platformValue) {
  const platform = asBody(platformValue);
  const tags = asArray(platform.hashtags).map((tag) => asString(tag).replace(/^#+/, "").replace(/\s+/g, "")).filter(Boolean);
  if (!tags.some((tag) => tag.toLowerCase() === "comoasi")) tags.push("ComoAsi");
  return [...new Set(tags.map((tag) => `#${tag}`))].slice(0, 6);
}
function appendMissingHashtags(textValue, platformValue) {
  const text = asString(textValue).trim();
  const lower = text.toLocaleLowerCase("es");
  const missing = normalizedHashtags(platformValue).filter((tag) => !lower.includes(tag.toLocaleLowerCase("es")));
  return [text, missing.join(" ")].filter(Boolean).join("\n\n").trim();
}
function publishingKitWithHashtags(value) {
  const kit = asBody(value);
  const instagram = asBody(kit.instagram);
  const tiktok = asBody(kit.tiktok);
  const youtube = asBody(kit.youtube);
  return {
    ...kit,
    instagram: { ...instagram, hashtags: normalizedHashtags(instagram).map((tag) => tag.slice(1)), caption: appendMissingHashtags(instagram.caption, instagram) },
    tiktok: { ...tiktok, hashtags: normalizedHashtags(tiktok).map((tag) => tag.slice(1)), caption: appendMissingHashtags(tiktok.caption, tiktok) },
    youtube: { ...youtube, hashtags: normalizedHashtags(youtube).map((tag) => tag.slice(1)), description: appendMissingHashtags(youtube.description, youtube) }
  };
}
function parseTrendSignals(value) {
  return asArray(value).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item;
    const title = asString(row.title);
    const url = asString(row.url);
    const source = asString(row.source, "Fuente web");
    const publishedAt = asString(row.publishedAt);
    const providerValue = asString(row.provider);
    const validProviders = ["GDELT", "Google News", "Entertainment RSS"];
    if (!title || !url || !validProviders.includes(providerValue)) return [];
    const provider = providerValue;
    return [{ title, url, source, publishedAt, provider }];
  });
}
function mergeTrendSignals(...groups) {
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
  for (const signal of groups.flat()) {
    const key = `${signal.url}|${signal.title.toLowerCase().replace(/[^a-z0-9áéíóúñü]+/gi, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(signal);
  }
  return merged.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
}
const categoryQueries = {
  chisme_polemica: ["pelea p\xFAblica famosos esc\xE1ndalo", "celebrity feud public scandal", "famosos traici\xF3n pol\xE9mica confirmada", "celebrity public controversy feud"],
  famosos: ["famosos romance ruptura confirmada", "celebrity relationship breakup confirmed", "pareja famosa drama p\xFAblico", "celebrity couple public drama"],
  bizarro_wtf: ["famoso papel\xF3n momento absurdo", "celebrity bizarre public moment", "famoso campa\xF1a pol\xE9mica marketing", "celebrity embarrassing public stunt"],
  cultura_pop_actualidad: ["famoso ego regreso pol\xE9mica", "celebrity comeback public feud", "premios cultura pop esc\xE1ndalo famosos", "celebrity awards public controversy"],
  viral_internet: ["influencer masivo cancelaci\xF3n p\xFAblica", "globally famous creator public controversy", "celebrity viral public scandal"],
  humor_negro: ["celebrity downfall public irony", "famoso contradicci\xF3n p\xFAblica absurda", "celebrity ego scandal"]
};
const sourceHeaders = {
  "user-agent": "Mozilla/5.0 (compatible; ComoAsiRadar/1.0)",
  accept: "application/json, application/rss+xml, application/xml, text/xml, text/plain;q=0.8, */*;q=0.5"
};
function decodeXml(value) {
  return value.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
function parseGdeltDate(value) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}
async function fetchGdelt(query) {
  const languages = ["spanish", "english"];
  const batches = await Promise.allSettled(languages.map(async (language) => {
    const q = `${query} sourcelang:${language}`;
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=15&format=json&sort=DateDesc`;
    const response = await fetch(url, { headers: sourceHeaders, signal: AbortSignal.timeout(9e3) });
    if (!response.ok) return [];
    const payload = await response.json();
    return (Array.isArray(payload.articles) ? payload.articles : []).flatMap((article) => {
      if (!article || typeof article !== "object") return [];
      const row = article;
      const title = asString(row.title);
      const articleUrl = asString(row.url);
      if (!title || !articleUrl) return [];
      return [{
        title,
        url: articleUrl,
        source: asString(row.domain, "Fuente web"),
        publishedAt: parseGdeltDate(asString(row.seendate)),
        provider: "GDELT"
      }];
    });
  }));
  return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
}
function rssTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}
async function fetchGoogleNews(query) {
  const locales = [
    { hl: "es-419", gl: "AR", ceid: "AR:es-419" },
    { hl: "en-US", gl: "US", ceid: "US:en" }
  ];
  const batches = await Promise.allSettled(locales.map(async (locale) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:2d`)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;
    const response = await fetch(url, { headers: sourceHeaders, signal: AbortSignal.timeout(9e3) });
    if (!response.ok) return [];
    const xml = await response.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    return items.slice(0, 15).flatMap((item) => {
      const title = rssTag(item, "title");
      const articleUrl = rssTag(item, "link");
      const published = rssTag(item, "pubDate");
      const source = rssTag(item, "source") || title.split(" - ").at(-1) || "Google News";
      if (!title || !articleUrl) return [];
      const parsedDate = new Date(published);
      return [{
        title,
        url: articleUrl,
        source,
        publishedAt: Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toISOString(),
        provider: "Google News"
      }];
    });
  }));
  return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
}
// Sebastian (2026-10-09): a wide radar, not one or two outlets. Every feed below answered from a
// GitHub runner on 2026-10-09; a feed that stops answering just contributes nothing.
const entertainmentFeeds = [
  { source: "Paparazzi", market: "argentina", url: "https://www.paparazzi.com.ar/feed/" },
  { source: "Infobae Teleshow", market: "argentina", url: "https://www.infobae.com/arc/outboundfeeds/rss/category/teleshow/?outputType=xml" },
  { source: "Clar\xEDn Espect\xE1culos", market: "argentina", url: "https://www.clarin.com/rss/espectaculos/" },
  { source: "La Naci\xF3n Espect\xE1culos", market: "argentina", url: "https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/espectaculos/?outputType=xml" },
  { source: "TN Show", market: "argentina", url: "https://tn.com.ar/arc/outboundfeeds/rss/category/show/?outputType=xml" },
  { source: "Exitoina", market: "argentina", url: "https://www.exitoina.com/rss" },
  { source: "Perfil Espect\xE1culos", market: "argentina", url: "https://www.perfil.com/feed/espectaculos" },
  { source: "Caras", market: "argentina", url: "https://caras.perfil.com/feed" },
  { source: "\xC1mbito Espect\xE1culos", market: "argentina", url: "https://www.ambito.com/rss/pages/espectaculos.xml" },
  { source: "Primicias Ya", market: "argentina", url: "https://www.primiciasya.com/rss/pages/home.xml" },
  { source: "Page Six", market: "internacional", url: "https://pagesix.com/feed/" },
  { source: "E! Online", market: "internacional", url: "https://www.eonline.com/syndication/feeds/rssfeeds/topstories.xml" },
  { source: "Just Jared", market: "internacional", url: "https://www.justjared.com/feed/" },
  { source: "TMZ", market: "internacional", url: "https://www.tmz.com/rss.xml" },
  { source: "Billboard", market: "internacional", url: "https://www.billboard.com/feed/" },
  { source: "Variety", market: "internacional", url: "https://variety.com/feed/" },
  { source: "Infobae Entretenimiento", market: "internacional", url: "https://www.infobae.com/arc/outboundfeeds/rss/category/america/entretenimiento/?outputType=xml" },
  { source: "Reddit popculturechat", market: "internacional", url: "https://www.reddit.com/r/popculturechat/hot/.rss" }
];
// What people are searching right now; each trend carries the news items behind it.
async function fetchGoogleTrends(geo) {
  try {
    const response = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, { headers: sourceHeaders, signal: AbortSignal.timeout(9e3) });
    if (!response.ok) return [];
    const xml = await response.text();
    return (xml.match(/<item>[\s\S]*?<\/item>/gi) || []).flatMap((item) => {
      const term = rssTag(item, "title");
      const traffic = rssTag(item, "ht:approx_traffic");
      const published = new Date(rssTag(item, "pubDate"));
      return (item.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/gi) || []).slice(0, 2).flatMap((news) => {
        const title = rssTag(news, "ht:news_item_title");
        const url = rssTag(news, "ht:news_item_url");
        if (!title || !url) return [];
        return [{
          title,
          url,
          source: rssTag(news, "ht:news_item_source") || "Google Trends",
          publishedAt: Number.isNaN(published.getTime()) ? "" : published.toISOString(),
          provider: "Google Trends",
          trending: `${term} (${traffic || "+"} b\xFAsquedas en ${geo})`
        }];
      });
    });
  } catch {
    return [];
  }
}
const entertainmentDomains = [
  // Argentina
  "paparazzi.com.ar",
  "ciudad.com.ar",
  "pronto.com.ar",
  "caras.perfil.com",
  "clarin.com/fama",
  "lanacion.com.ar/espectaculos",
  "infobae.com/teleshow",
  // Colombia
  "revistavea.com.co",
  "caracoltv.com/famosos",
  "canalrcn.com/super-like",
  "pulzo.com/entretenimiento",
  // México
  "tvynovelas.com",
  "quien.com",
  "lasestrellas.tv/famosos",
  "milenio.com/espectaculos/famosos",
  // Chile, Perú y otros mercados latinoamericanos
  "lacuarta.com/espectaculos",
  "pagina7.cl",
  "meganoticias.cl/tendencias",
  "trome.com/espectaculos",
  "elcomercio.pe/tvmas",
  "americatv.com.pe/espectaculos",
  "metroecuador.com.ec/entretenimiento",
  "elnuevodia.com/entretenimiento/farandula",
  // Cobertura panlatina e internacional de celebridades
  "peopleenespanol.com",
  "hola.com",
  "univision.com/famosos",
  "telemundo.com/entretenimiento",
  "eonline.com",
  "billboard.com",
  "variety.com",
  "deadline.com",
  "tmz.com"
];
async function fetchEntertainmentFeed(feed) {
  try {
    const response = await fetch(feed.url, { headers: sourceHeaders, signal: AbortSignal.timeout(9e3) });
    if (!response.ok) return [];
    const xml = await response.text();
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    return items.slice(0, 15).flatMap((item) => {
      const title = rssTag(item, "title");
      const articleUrl = rssTag(item, "link") || rssTag(item, "guid");
      const published = rssTag(item, "pubDate") || rssTag(item, "published") || rssTag(item, "updated");
      if (!title || !articleUrl) return [];
      const parsedDate = new Date(published);
      return [{
        title,
        url: articleUrl,
        source: feed.source,
        publishedAt: Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toISOString(),
        provider: "Entertainment RSS"
      }];
    });
  } catch {
    return [];
  }
}
async function fetchEntertainmentFeeds(market = "random") {
  const selectedFeeds = ["argentina", "internacional"].includes(market) ? entertainmentFeeds.filter((feed) => feed.market === market) : entertainmentFeeds;
  const trendGeos = market === "argentina" ? ["AR"] : market === "internacional" ? ["US", "MX"] : ["AR", "US"];
  const batches = await Promise.allSettled([...selectedFeeds.map(fetchEntertainmentFeed), ...trendGeos.map(fetchGoogleTrends)]);
  return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
}
// Buzz: how many different outlets carry the same story (shared proper names in the headline).
// A story five outlets are covering is more viral than one a single site posted.
const buzzStopwords = new Set(["argentina", "buenos", "aires", "estados", "unidos", "netflix", "video", "fotos", "mundial", "teleshow", "streaming", "instagram", "tiktok", "youtube", "after", "before", "their", "which", "where", "there", "about"]);
function headlineNames(title) {
  return new Set((asString(title).normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/\b[A-Z][a-zA-Z]{4,}\b/g) || []).map((word) => word.toLowerCase()).filter((word) => !buzzStopwords.has(word)));
}
function withBuzz(signals) {
  const names = signals.map((signal) => headlineNames(signal.title));
  return signals.map((signal, index) => {
    const outlets = new Set();
    signals.forEach((other, otherIndex) => {
      if (otherIndex === index || other.source === signal.source) return;
      for (const name of names[index]) if (names[otherIndex].has(name)) { outlets.add(other.source); break; }
    });
    return { ...signal, buzz: outlets.size + 1 };
  });
}
async function fetchCurrentSignals(category, topic = "", market = "random") {
  const compactTopic = topic.split(/\s+/).filter((word) => word.length > 2).slice(0, 7).join(" ");
  const argentinaFocused = market === "argentina";
  const specificQueries = topic ? [compactTopic || topic, `${compactTopic || topic} esc\xE1ndalo famosos`] : argentinaFocused ? (categoryQueries[category] || categoryQueries.chisme_polemica).map((query) => `${query} Argentina famosos argentinos`) : categoryQueries[category] || categoryQueries.chisme_polemica;
  const priorityQueries = [];
  const priorityDomains = argentinaFocused ? entertainmentDomains.slice(0, 7) : entertainmentDomains;
  for (let index = 0; index < priorityDomains.length; index += 3) {
    const sites = priorityDomains.slice(index, index + 3).map((domain) => `site:${domain}`).join(" OR ");
    priorityQueries.push(topic ? `(${sites}) ${compactTopic || topic}` : `(${sites}) ${argentinaFocused ? "famosos argentinos far\xE1ndula argentina pol\xE9mica romance" : "famosos esc\xE1ndalo romance pelea"}`);
  }
  const collect = async (queries) => {
    const batches = await Promise.allSettled(queries.flatMap((query) => [fetchGdelt(query), fetchGoogleNews(query)]));
    return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
  };
  const collectPriority = async (queries) => {
    const batches = await Promise.allSettled(queries.map(fetchGoogleNews));
    return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
  };
  const normalize = (signals, maxAgeDays) => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1e3;
    const seen = /* @__PURE__ */ new Set();
    const fresh = signals.filter((signal) => {
      const normalized2 = signal.title.toLowerCase().replace(/[^a-z0-9áéíóúñü]+/gi, " ").trim();
      if (!normalized2 || seen.has(normalized2)) return false;
      const date = signal.publishedAt ? new Date(signal.publishedAt).getTime() : Date.now();
      if (!Number.isNaN(date) && date < cutoff) return false;
      seen.add(normalized2);
      return true;
    });
    // Most-covered and trending stories first, at most 5 per outlet so no single site fills the radar.
    const perSource = new Map();
    return withBuzz(fresh)
      .sort((a, b) => b.buzz + (b.trending ? 2 : 0) - (a.buzz + (a.trending ? 2 : 0)) || (b.publishedAt || "").localeCompare(a.publishedAt || ""))
      .filter((signal) => {
        const count = perSource.get(signal.source) || 0;
        perSource.set(signal.source, count + 1);
        return count < 5;
      })
      .slice(0, 45);
  };
  const [generalSignals, prioritySignals, directFeedSignals] = await Promise.all([
    collect(specificQueries),
    collectPriority(priorityQueries),
    fetchEntertainmentFeeds(market)
  ]);
  // Gossip has to be fresh: by default only the last two days, widened by a day when too few.
  const maxAgeDays = Number(process.env.SIGNAL_MAX_AGE_DAYS || 2);
  let normalized = normalize([...directFeedSignals, ...prioritySignals, ...generalSignals], maxAgeDays);
  if (!topic && normalized.length < 8) {
    const fallbackSignals = await collect(argentinaFocused ? ["famosos argentinos actualidad", "farandula argentina famosos", "television argentina celebridades", "musica argentina famosos"] : ["celebrity gossip", "famosos chisme", "celebrity scandal", "famosos pareja"]);
    normalized = normalize([...normalized, ...fallbackSignals], maxAgeDays + 1);
  }
  return normalized;
}
async function scrapeTrendSources(signals) {
  const selected = signals.slice(0, 6);
  const scraped = await Promise.allSettled(selected.map(async (signal) => {
    const page = await ai.scrape({ url: signal.url });
    return { ...signal, text: page.status < 400 ? page.text.slice(0, 4500) : "" };
  }));
  return scraped.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
}
const editorialSystem = `Eres el motor editorial exclusivo de \xBFC\xF3mo As\xED?, un show vertical de s\xE1tira y humor negro sobre celebridades reconocibles. Trabaja \xFAnicamente con las fuentes recientes, la memoria y los recursos suministrados por este proyecto.

IDENTIDAD EDITORIAL: el presentador es MALA FAMA, un diablo animado masculino, elegante y cruel con el ego del poderoso. No es una amiga contando un chisme, no conversa con la celebridad y no habla como panelista de far\xE1ndula. Dicta el caso como maestro de ceremonias del inframundo: seguro, teatral, oscuro, preciso y con una sonrisa de verdugo. Convierte un conflicto p\xFAblico real en una ejecuci\xF3n c\xF3mica con premisa, escalada, giro, callback y sentencia final. Cero documental, noticiero, conversaci\xF3n entre amigos o art\xEDculo le\xEDdo.

ESPA\xD1OL LATINO NEUTRO: usa vocabulario comprensible en toda Latinoam\xE9rica y conjugaci\xF3n neutral. Prohibidos el voseo y los regionalismos argentinos, colombianos, mexicanos, espa\xF1oles, chilenos o de cualquier pa\xEDs. No uses \u201Cquilombo\u201D, \u201Cche\u201D, \u201Cboludo\u201D, \u201Cpibe\u201D, \u201Cmina\u201D, \u201Cparce\u201D, \u201Cvaina\u201D, \u201Cg\xFCey\u201D, \u201Cco\xF1o\u201D, \u201Ccachai\u201D, \u201Cac\xE1\u201D, \u201Csos\u201D, \u201Cten\xE9s\u201D, \u201Cpod\xE9s\u201D, \u201Cmir\xE1\u201D ni equivalentes regionales. El picante debe venir de la precisi\xF3n: \u201Cqu\xE9 mierda\u201D, \u201Ccarajo\u201D, \u201Cqu\xE9 desastre\u201D, \u201Ccirco\u201D, \u201Ccaradura\u201D, \u201Cse pas\xF3 de listo\u201D.

NICHO: solo microdramas p\xFAblicos de celebridades que la audiencia latinoamericana reconozca por nombre y rostro: peleas y esc\xE1ndalos; romances y rupturas; papelones y momentos WTF; ego, lujo e hipocres\xEDa de cultura pop. Nada de pol\xEDtica, econom\xEDa, noticias duras, tragedias, delitos, menores o v\xEDctimas vulnerables. Si hay que explicar qui\xE9n es el protagonista, se descarta.

HUMOR NEGRO: el hecho real es la premisa y el ego es el blanco. Incluye remates espec\xEDficos nacidos de la contradicci\xF3n comprobada; nunca chistes intercambiables. Puede ser despiadado con la pose, el privilegio, el oportunismo, la mentira p\xFAblica y las decisiones absurdas. Nunca ataques raza, nacionalidad, orientaci\xF3n sexual, discapacidad, cuerpo, religi\xF3n ni v\xEDctimas. No inventes delitos, citas, relaciones, intimidad ni intenciones.

RITMO: abre con nombre + conflicto + consecuencia en 1-2 segundos. Alterna dato verificable y remate; no encadenes dos bloques explicativos. Cada 7-10 segundos debe aparecer una revelaci\xF3n, inversi\xF3n de estatus o golpe c\xF3mico. Mala Fama no usa muletillas de amiga como \u201Cmi amor\u201D, \u201Cesc\xFAchame\u201D, \u201Cte cuento\u201D, \u201Camiga\u201D, \u201Creina\u201D o \u201Cbeb\xE9\u201D. Tampoco dice \u201Cs\xED, le\xEDste bien\u201D. Habla con frases cortas, pausas de amenaza, falsa solemnidad y sentencias citables. El cierre paga el gancho y termina con punto final.

RIGOR: Paparazzi y otros medios de espect\xE1culo sirven para detectar conversaciones, no para convertir rumores en hechos. Conserva atribuci\xF3n cuando una afirmaci\xF3n provenga de una sola fuente. Para afirmaciones sensibles exige corroboraci\xF3n independiente o decl\xE1ralas como versi\xF3n/rumor. Usa solo las se\xF1ales y fuentes recientes proporcionadas por el sistema; no fabriques informaci\xF3n para mejorar un chiste.`;
const routes = {
  "POST /api/engine/topic": [async ({ body }) => {
    const b = asBody(body);
    const rawCategory = asString(b.category, "viral_internet");
    const marketCategoryMatch = rawCategory.match(/^(argentina|random|internacional):(.*)$/i);
    const category = asString(marketCategoryMatch?.[2], rawCategory);
    const explicitMarket = asString(b.market).toLowerCase();
    const prefixedMarket = asString(marketCategoryMatch?.[1]).toLowerCase();
    const market = ["argentina", "random", "internacional"].includes(explicitMarket) ? explicitMarket : ["argentina", "internacional"].includes(prefixedMarket) ? prefixedMarket : "random";
    const memory = asArray(b.memory).slice(0, 60);
    const learning = asArray(b.learning).slice(0, 40);
    const liveSignals = await fetchCurrentSignals(category, "", market);
    if (liveSignals.length === 0) return error("current_sources_unavailable", 503);
    const currentDate = (/* @__PURE__ */ new Date()).toISOString();
    const marketInstruction = market === "internacional" ? "MERCADO INTERNACIONAL OBLIGATORIO: el protagonista debe ser una celebridad internacional (Hollywood, m\xFAsica global, K-pop, realeza, deporte mundial o estrellas latinas de otros pa\xEDses) reconocible para el p\xFAblico latinoamericano; NO puede ser argentino ni la historia puede ser de la far\xE1ndula argentina. Pol\xEDtica y noticias duras siguen prohibidas. recognitionScore m\xEDnimo 90 y preferencia editorial 93 o m\xE1s." : market === "argentina" ? "MERCADO ARGENTINA OBLIGATORIO: el tema debe involucrar a una celebridad de reconocimiento transversal para p\xFAblico general argentino o un evento de entretenimiento/cultura pop con v\xEDnculo directo, actual y verificable con Argentina. Prioriz\xE1 se\xF1ales de medios argentinos. No alcanza con que una noticia internacional haya sido republicada en Argentina. Pol\xEDtica y noticias duras siguen prohibidas. Busc\xE1 primero protagonistas de nivel masivo; el piso operativo de recognitionScore es 88, pero la preferencia editorial es 92 o m\xE1s." : "MERCADO RANDOM/GLOBAL: eleg\xED el mejor tema actual sin restricci\xF3n geogr\xE1fica, priorizando reconocimiento masivo latinoamericano o global. recognitionScore m\xEDnimo 90 y preferencia editorial 93 o m\xE1s.";
    const viralCalibration = "RADAR VIRAL: cada se\xF1al trae buzz (cu\xE1ntos medios distintos cubren esa misma historia) y algunas trending (b\xFAsquedas en Google ahora). Prioriz\xE1 la historia con m\xE1s buzz o tendencia que encaje en chisme con humor negro; una nota que public\xF3 un solo sitio pierde contra la que est\xE1 en todos lados. CALIBRACI\xD3N VIRAL: el patr\xF3n de alto rendimiento que queremos repetir NO es repetir a Wanda Nara ni un tema concreto; es repetir la mec\xE1nica que funcion\xF3: famoso que se reconoce al instante + conflicto que se entiende en una sola frase + tensi\xF3n de romance, ego, papel\xF3n o contradicci\xF3n p\xFAblica + una consecuencia concreta + im\xE1genes f\xE1ciles de exagerar. Si dos candidatos est\xE1n parejos, gana el que necesita menos contexto, genera una reacci\xF3n emocional m\xE1s r\xE1pida y permite un t\xEDtulo que cualquiera entiende en menos de dos segundos. Penaliz\xE1 fuerte historias de nicho, conflictos burocr\xE1ticos, contexto largo, protagonistas secundarios y temas que solo son interesantes para fans. La memoria editorial sigue mandando: no repitas protagonista, evento ni \xE1ngulo reciente cuando exista una alternativa fuerte.";
    // Local-model guard: topics rejected as duplicates in this job. Their protagonists' headlines are
    // dropped so a smaller model cannot keep picking the same story.
    const avoid = asArray(b.avoid);
    const plainTokens = (value) => asString(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((token) => token.length >= 4);
    const avoidTokens = new Set(avoid.flatMap((item) => plainTokens(item?.protagonist)));
    const freshSignals = liveSignals.filter((signal) => !plainTokens(`${signal.title} ${signal.text || ""}`).some((token) => avoidTokens.has(token)));
    const availableSignals = (freshSignals.length >= 5 ? freshSignals : liveSignals).slice(0, 40);
    // Sebastian (2026-10-09): dark humor can be strong, but abuse is off limits.
    const hardLimits = "\nL\xCDMITES DUROS: el humor negro puede ser fuerte, pero nunca elijas historias de abuso sexual, acoso u hostigamiento (ni denuncias de acoso), violencia de g\xE9nero, maltrato, menores en riesgo, muertes recientes ni enfermedades graves como tema.";
    const avoidInstruction = hardLimits + (avoid.length ? `\nPROHIBIDO repetir estos temas ya hechos ni a sus protagonistas: ${JSON.stringify(avoid.map((item) => ({ topic: item?.topic, protagonist: item?.protagonist })))}` : "");
    const prompt = `Fecha/hora actual UTC: ${currentDate}. Categor\xEDa solicitada: ${category}. Mercado editorial: ${market}. ${marketInstruction} ${viralCalibration}
SE\xD1ALES RECIENTES REALES (\xEDndice \u2192 titular/fuente/fecha): ${JSON.stringify(availableSignals.map((signal, index) => ({ index, ...signal })))}
Memoria editorial exclusiva de \xBFC\xF3mo As\xED? (evitar repeticiones): ${JSON.stringify(memory)}
Aprendizaje viral exclusivo de \xBFC\xF3mo As\xED?: ${JSON.stringify(learning)}${avoidInstruction}
Gener\xE1 internamente al menos 18 candidatos DERIVADOS de estas se\xF1ales y eleg\xED solamente uno que tenga una PERSONA FAMOSA REAL como protagonista central. El nombre y el rostro deben ser reconocibles de inmediato para audiencia masiva de Latinoam\xE9rica o global: cantante, actor, deportista, celebridad, figura televisiva, streamer o influencer verdaderamente masivo. Aplic\xE1 la prueba de una frase: famoso + conflicto o contradicci\xF3n p\xFAblica + consecuencia; si el drama no se entiende sin antecedentes, descartalo. No alcanza con que sea conocido dentro de un nicho, aparezca una vez en prensa o sea familiar de otro famoso. Prioriz\xE1 nombre propio + rostro reconocible + conflicto p\xFAblico f\xE1cil de entender. Eleg\xED exclusivamente uno de estos pilares: esc\xE1ndalo o pelea p\xFAblica; romance o ruptura respaldada; papel\xF3n o momento WTF; ego o conflicto de cultura pop. DESCART\xC1 protagonistas desconocidos, figuras de nicho, noticias duras, pol\xEDtica, econom\xEDa, delitos, accidentes, tragedias, menores, v\xEDctimas vulnerables y hechos sin conflicto de personalidad. No inventes el tema, el conflicto ni la fama. recognitionScore mide de 0 a 100 si el p\xFAblico general reconoce el NOMBRE Y EL ROSTRO del protagonista sin necesitar conocer su obra; prioriz\xE1 92 o m\xE1s en Argentina y 93 o m\xE1s en random/global, con piso operativo 88 para Argentina y 90 para random/global, y explic\xE1 por qu\xE9 en recognitionReason. viralScore debe medir espec\xEDficamente qu\xE9 tan r\xE1pido se entiende y comparte el conflicto: reconocimiento instant\xE1neo, tensi\xF3n emocional, consecuencia concreta y potencial visual; 90+ significa candidato excepcional. Una figura de culto, director conocido por una sola pel\xEDcula, familiar de un famoso o personalidad de nicho nunca supera 79. El title debe incluir literalmente el nombre completo del protagonista para que el gancho sea inmediato. No repitas evento+\xE1ngulo ni protagonista reciente si existen alternativas. sourceIndexes debe contener de 1 a 3 \xEDndices v\xE1lidos que respalden el tema. Puntualo de 0 a 100.`;
    const schema = {
      type: "object",
      properties: {
        category: { type: "string" },
        topic: { type: "string" },
        normalizedTopic: { type: "string" },
        protagonist: { type: "string" },
        eventKey: { type: "string" },
        angle: { type: "string" },
        subtopic: { type: "string" },
        periodLabel: { type: "string" },
        narrativeQuestion: { type: "string" },
        hook: { type: "string" },
        title: { type: "string" },
        viralScore: { type: "number" },
        visualScore: { type: "number" },
        rationale: { type: "string" },
        trendReason: { type: "string" },
        recognitionScore: { type: "number" },
        recognitionReason: { type: "string" },
        sourceIndexes: { type: "array", items: { type: "number" } }
      },
      required: ["category", "topic", "normalizedTopic", "protagonist", "angle", "narrativeQuestion", "hook", "title", "viralScore", "visualScore", "rationale", "trendReason", "recognitionScore", "recognitionReason", "sourceIndexes"]
    };
    let selected = await generateStructured(editorialSystem, prompt, schema, 3800);
    const minimumRecognition = market === "argentina" ? 88 : 90;
    const recognitionIsWeak = (candidate) => Number(candidate.recognitionScore || 0) < minimumRecognition || !asString(candidate.protagonist) || /(figura de culto|de culto|conocid[oa] por su obra|aunque no|dentro de su nicho|nicho|usuarios de internet|quienes conocen)/i.test(asString(candidate.recognitionReason));
    const viralFitIsWeak = (candidate) => Number(candidate.viralScore || 0) < 88 || Number(candidate.visualScore || 0) < 80;
    if (recognitionIsWeak(selected) || viralFitIsWeak(selected)) {
      selected = await generateStructured(editorialSystem, `${prompt}
REINTENTO OBLIGATORIO: la primera elecci\xF3n no alcanz\xF3 el est\xE1ndar de fama/viralidad. Eleg\xED una celebridad cuyo nombre y rostro reconozca el p\xFAblico general del mercado objetivo sin explicaci\xF3n; recognitionScore m\xEDnimo ${minimumRecognition}. Adem\xE1s, el conflicto debe entenderse en una frase, tener consecuencia concreta y viralScore m\xEDnimo 88. Prohibidas figuras de culto o nicho. No repitas un protagonista reciente solo porque ya funcion\xF3 antes.`, schema, 3800);
    }
    // Local-model guard: small open-source models can invent a celebrity story that is not in the
    // headlines. The protagonist must be named in at least one of the cited source headlines.
    const nameTokens = (value) => asString(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((token) => token.length >= 4);
    const isGrounded = (candidate) => {
      const tokens = nameTokens(asString(candidate.protagonist).replace(/\([^)]*\)/g, " ")).filter((token) => !["the", "with", "from", "junior"].includes(token));
      const cited = asArray(candidate.sourceIndexes).map((value) => availableSignals[Math.trunc(Number(value))]).filter(Boolean);
      return tokens.length > 0 && cited.some((signal) => {
        const headline = nameTokens(`${signal.title} ${signal.text || ""}`);
        return tokens.some((token) => headline.includes(token));
      });
    };
    if (!recognitionIsWeak(selected) && !isGrounded(selected)) {
      console.warn(`[como-asi] topic not grounded in cited headlines: ${asString(selected.protagonist)}`);
      selected = await generateStructured(editorialSystem, `${prompt}
CORRECCI\xD3N OBLIGATORIA: la elecci\xF3n anterior no aparec\xEDa en los titulares citados. El protagonista debe estar nombrado textualmente en el titular de al menos una de las se\xF1ales que pongas en sourceIndexes, y el conflicto debe ser el de ese titular. Prohibido inventar historias.`, schema, 3800);
    }
    if (recognitionIsWeak(selected)) return error("recognizable_protagonist_unavailable", 503);
    if (!isGrounded(selected)) return error("topic_not_grounded_in_sources", 503);
    // The name check above lets a real name carry an invented conflict (Gunna launching a label
    // became a "public war with an ex-partner"). A separate pass checks the claim itself.
    const citedSignals = asArray(selected.sourceIndexes).map((value) => availableSignals[Math.trunc(Number(value))]).filter(Boolean);
    const claimCheck = await generateStructured("Eres un verificador de datos estricto. Respond\xE9s solo con lo que dicen los textos dados.", `TEMA PROPUESTO: ${JSON.stringify({ topic: selected.topic, title: selected.title, angle: selected.angle })}
FUENTES CITADAS: ${JSON.stringify(citedSignals.map((signal) => ({ title: signal.title, text: asString(signal.text).slice(0, 1200) })))}
\xBFLas fuentes cuentan el mismo hecho central que el tema, aunque sea con otras palabras? Respond\xE9 supported=true si lo cuentan. Respond\xE9 supported=false SOLO si el tema afirma un hecho que las fuentes no dicen (por ejemplo una pelea, ruptura, acusaci\xF3n, socio o pareja que no aparece). Que la nota no tenga esc\xE1ndalo no es motivo para rechazar.
Adem\xE1s, isGossip=true solo si es chisme de famosos que la gente comenta: romance, ruptura, infidelidad, pelea personal, papel\xF3n, ego o pol\xE9mica de cultura pop. isGossip=false para pases, contratos o resultados deportivos, causas judiciales de negocios o tierras, pol\xEDtica, econom\xEDa o lanzamientos sin conflicto.`, {
      type: "object",
      properties: { supported: { type: "boolean" }, isGossip: { type: "boolean" }, reason: { type: "string" } },
      required: ["supported", "isGossip", "reason"]
    }, 400).catch(() => ({ supported: false, reason: "claim_check_failed" }));
    if (claimCheck.supported !== true || claimCheck.isGossip === false) {
      console.warn(`[como-asi] topic claim not supported by sources: ${asString(selected.topic)} (${asString(claimCheck.reason)})`);
      return error(`topic_not_grounded_in_sources|${JSON.stringify({ topic: asString(selected.topic), protagonist: asString(selected.protagonist) })}`, 503);
    }
    const protagonist = asString(selected.protagonist);
    const selectedTitle = asString(selected.title);
    if (!selectedTitle.toLocaleLowerCase("es").includes(protagonist.toLocaleLowerCase("es"))) selected.title = `${protagonist}: ${selectedTitle || asString(selected.topic)}`;
    const indexes = asArray(selected.sourceIndexes).map((value) => Math.trunc(Number(value))).filter((value) => Number.isFinite(value) && value >= 0 && value < availableSignals.length).slice(0, 3);
    if (indexes.length === 0) return error("topic_without_current_source", 503);
    return json({ ...selected, market, sources: indexes.map((index) => availableSignals[index]), currentCapturedAt: currentDate });
  }],
  "POST /api/engine/research": [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    const angle = asString(b.angle);
    const protagonist = asString(b.protagonist);
    const eventKey = asString(b.eventKey);
    const narrativeQuestion = asString(b.narrativeQuestion);
    if (!topic) return error("topic_required", 400);
    const inheritedSources = parseTrendSignals(b.sources);
    const searchSeed = [protagonist, eventKey].filter(Boolean).join(" ") || topic;
    const discoveredSignals = await fetchCurrentSignals("viral_internet", searchSeed);
    const liveSignals = mergeTrendSignals(inheritedSources, discoveredSignals).slice(0, 12);
    if (liveSignals.length === 0) return error("current_sources_unavailable", 503);
    const scrapedSources = await scrapeTrendSources(liveSignals);
    const scrapedByUrl = new Map(scrapedSources.map((source) => [source.url, source.text]));
    const sourcePackets = liveSignals.slice(0, 8).map((signal) => ({
      ...signal,
      text: scrapedByUrl.get(signal.url) || "",
      origin: inheritedSources.some((source) => source.url === signal.url) ? "selector" : "supplemental_search"
    }));
    const prompt = `Fecha/hora actual UTC: ${(/* @__PURE__ */ new Date()).toISOString()}. Investig\xE1 de forma conservadora este tema para un microdrama de celebridades (no un noticiero): ${topic}. \xC1ngulo: ${angle}. Protagonista: ${protagonist}. Evento clave: ${eventKey}. Pregunta narrativa: ${narrativeQuestion}. FUENTES DISPONIBLES: ${JSON.stringify(sourcePackets)}. Las fuentes marcadas como selector ya justificaron la elecci\xF3n del tema y deben conservarse como evidencia primaria; la b\xFAsqueda suplementaria solo ampl\xEDa cobertura. Produc\xED un brief factual usando \xFAnicamente informaci\xF3n respaldada por estos paquetes y sus titulares. Separ\xE1 hechos de contexto incierto. No inventes citas, fechas, delitos, relaciones personales ni intenciones. Si un dato no aparece con respaldo suficiente, excluilo o marc\xE1lo como incierto. No confundas rumor con hecho. Para que la historia se entienda sin contexto previo, verifiedFacts debe traer los datos concretos de las notas: qui\xE9nes son las personas y su v\xEDnculo, qu\xE9 pas\xF3 exactamente, citas textuales relevantes, cu\xE1ndo y d\xF3nde, y qu\xE9 consecuencia tuvo; nunca repitas el titular con otras palabras. Inclu\xED afirmaciones seguras, riesgos de precisi\xF3n, qu\xE9 fuente respalda el \xE1ngulo y qu\xE9 afirmaciones todav\xEDa requieren verificaci\xF3n adicional antes de publicar.`;
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        verifiedFacts: { type: "array", items: { type: "string" } },
        uncertainClaims: { type: "array", items: { type: "string" } },
        verificationQueries: { type: "array", items: { type: "string" } },
        visualEvidence: { type: "array", items: { type: "string" } },
        safeAngle: { type: "string" },
        sourceCoverage: { type: "string" }
      },
      required: ["summary", "verifiedFacts", "uncertainClaims", "verificationQueries", "visualEvidence", "safeAngle", "sourceCoverage"]
    };
    const research = await generateStructured(editorialSystem, prompt, schema, 4400);
    return json({
      ...research,
      sources: liveSignals.slice(0, 8),
      inheritedSourceCount: inheritedSources.length,
      discoveredSourceCount: discoveredSignals.length,
      researchedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }],
  "POST /api/engine/story": [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    if (!topic) return error("topic_required", 400);
    const research = b.research || {};
    const title = asString(b.title);
    const hook = asString(b.hook);
    const protagonist = asString(b.protagonist);
    const strictSpanish = Boolean(b.strictSpanish);
    const languageRepair = strictSpanish ? "REPARACI\xD3N DE IDIOMA: el intento anterior fue rechazado. Reescribe desde cero toda narraci\xF3n, t\xEDtulo, gancho, remates y prop\xF3sito de escena en espa\xF1ol latino neutro. No uses regionalismos, voseo, palabras ni construcciones inglesas salvo nombres propios inevitables. Los visualPrompt s\xED pueden estar en ingl\xE9s. " : "";
    // Local-model guard: open models miss the runtime window the validator enforces, so state it
    // up front and repeat the exact reason when a previous attempt was rejected.
    // Sebastian (2026-10-09): the first posted story repeated its headline and had no context.
    const contextRule = "CONTEXTO OBLIGATORIO: quien llega sin saber nada tiene que entender la historia. En las escenas 2-4 dec\xED qui\xE9n es cada persona y su v\xEDnculo (por ejemplo, que es su esposo, su ex o su socio) y qu\xE9 pas\xF3 exactamente, con el dato concreto del brief: qu\xE9 dijo, qu\xE9 hizo, cu\xE1ndo y por qu\xE9 importa. Cada escena aporta un dato o un remate NUEVO; prohibido repetir el mismo hecho con otras palabras. Si el brief trae una cita textual, usala. " +
      // Sebastian (2026-10-09): tell the gossip, do not read the article. Comment it, draw
      // conclusions and stir the scandal, as if telling it to friends.
      "ESTILO CHISME: Mala Fama no lee la nota, CUENTA el chisme y lo comenta como quien arma esc\xE1ndalo: interpreta, sospecha, compara con lo que el famoso dijo o hizo antes, saca conclusiones filosas y exagera las consecuencias para hacer re\xEDr, siempre con humor negro filoso: remates crueles con el ego, la pose y la hipocres\xEDa, nunca chistes blandos. Los hechos salen del brief; las conclusiones, sospechas y exageraciones van como opini\xF3n o burla de Mala Fama (\u201Cpara m\xED\u201D, \u201Cqu\xE9 casualidad\u201D, \u201Cy ahora viene lo bueno\u201D, \u201Cdigamos la verdad\u201D), nunca como un hecho nuevo inventado. Arco: gancho \u2192 qui\xE9n es qui\xE9n \u2192 qu\xE9 pas\xF3 \u2192 lo que nadie dice (la lectura de Mala Fama) \u2192 escalada \u2192 veredicto. ";
    const lengthRule = "LONGITUD OBLIGATORIA: entre 150 y 240 palabras sumando las 16 narraciones (de 9 a 15 palabras cada una), la escena 1 con menos de 20 palabras, la 16 cerrando con afirmaci\xF3n (sin pregunta) y como m\xE1ximo 2 preguntas en todo el guion. ";
    const repairNote = asString(b.repairNote) ? `CORRECCI\xD3N DEL INTENTO ANTERIOR: ${asString(b.repairNote)} ` : "";
    const prompt = `${repairNote}${contextRule}${lengthRule}${languageRepair}Tema: ${topic}. Protagonista p\xFAblico reconocido: ${protagonist}. T\xEDtulo sugerido: ${title}. Hook sugerido: ${hook}. Brief factual: ${JSON.stringify(research)}.
IDENTIDAD OBLIGATORIA: MALA FAMA es un presentador masculino, un diablo animado adulto y elegante; nunca una mujer, una amiga chismosa ni una conversaci\xF3n entre personas. IDIOMA OBLIGATORIO: devuelve title, coverDeck, hook, closingLine y las 16 narraciones exclusivamente en espa\xF1ol latino neutro. Traduce cualquier frase que haya quedado en ingl\xE9s. Los visualPrompt pueden escribirse en ingl\xE9s si mejora el resultado visual. Escribe un Reel de 55-70 segundos y EXACTAMENTE 16 escenas para retenci\xF3n m\xE1xima. La duraci\xF3n la decide la historia: puede superar un minuto cuando el drama necesita respirar, pero termina apenas pagues el gancho y nunca agregues relleno. NIVEL DE DRAMA: 10/10. NIVEL DE CHISME: 10/10. La voz pertenece a Mala Fama: presentador masculino de registro grave, oscuro y dominante. Habla como fiscal del inframundo y maestro de ceremonias, no como amiga chismosa. No saluda, no coquetea y no conversa con nadie: abre el expediente, exhibe la contradicci\xF3n y dicta sentencia. Usa silencios tensos, falsa solemnidad, desprecio divertido y remates secos. Prohibidas las muletillas \u201Cmi amor\u201D, \u201Camiga\u201D, \u201Creina\u201D, \u201Cbeb\xE9\u201D, \u201Cesc\xFAchame\u201D, \u201Cte cuento\u201D y cualquier frase que suene a dos amigas hablando. No aceleres ni atropelles las palabras. No uses tono de documental, noticiero, resumen ni art\xEDculo le\xEDdo. ESTRUCTURA DE MICRODRAMA: abre con una acusaci\xF3n factual o contradicci\xF3n imposible de ignorar; crea una deuda de curiosidad antes del segundo 4; entrega una revelaci\xF3n concreta cada 7-10 segundos; reserva el dato que cambia la lectura para el \xFAltimo tercio; cierra con un remate que haga volver mentalmente al gancho. Objetivo total: 125-150 palabras para una locuci\xF3n masculina lenta, oscura, expresiva y con silencios. Cada escena debe tener normalmente 3-7 palabras habladas; divide cualquier frase que supere 10 palabras. El title debe incluir al famoso y no superar 42 caracteres; coverDeck debe tener 2-5 palabras. ESCENA 1: gancho autosuficiente de 7-12 palabras con nombre del famoso + conflicto concreto + consecuencia inc\xF3moda; debe entenderse aunque el espectador llegue sin contexto. Sin saludo, fecha, introducci\xF3n, preguntas vagas ni frases como \u201Cno vas a creer\u201D. ESCENAS 2-3: entrega inmediatamente el primer hecho verificable y explica qu\xE9 est\xE1 en juego; no desperdicies una escena prometiendo que luego contar\xE1s algo. ESCENAS 4-6: revela qui\xE9n gana, qui\xE9n pierde o qu\xE9 est\xE1 realmente en juego, solo si el brief lo respalda. ESCENAS 7-11: intensifica el detalle m\xE1s inc\xF3modo, absurdo o hip\xF3crita; alterna dato verificado + reacci\xF3n filosa + dato nuevo. ESCENAS 12-14: introduce el giro, contraataque o consecuencia que cambie c\xF3mo se entiende todo. ESCENAS 15-16: la escena 15 entrega el \xFAltimo hecho o consecuencia que faltaba; la escena 16 dicta un veredicto breve, contundente y gracioso que paga el gancho. Est\xE1 prohibido terminar con pregunta, suspenso abierto, \u201C\xBFqu\xE9 opinas?\u201D, moraleja o informaci\xF3n inconclusa. closingLine debe ser exactamente la narraci\xF3n de la escena 16 y tener entre 6 y 12 palabras. No bajes la tensi\xF3n durante dos escenas consecutivas. Cada l\xEDnea debe soltar un dato fuerte, juzgar una contradicci\xF3n, aumentar lo que est\xE1 en juego o rematar con veneno. Si una l\xEDnea solo explica contexto como documental, reescr\xEDbela. La narradora toma partido editorial contra la hipocres\xEDa, el ego o la decisi\xF3n absurda, sin inventar acusaciones. Usa lenguaje hablado latino neutro, cambios de intenci\xF3n y frases que una persona realmente dir\xEDa. Puedes usar con moderaci\xF3n \u201Cs\xED, escuchaste bien\u201D, \u201Cpero espera\u201D, \u201Cporque claro\u201D, \u201Cgiro total\u201D o \u201Chasta aqu\xED todo normal\u201D, sin repetir f\xF3rmulas. Nunca uses \u201Cs\xED, le\xEDste bien\u201D porque la audiencia est\xE1 escuchando. PROHIBIDO: regionalismos, voseo, \u201Cla historia comienza\u201D, \u201Cpara entender esto\u201D, \u201Cen este contexto\u201D, \u201Ccabe destacar\u201D, \u201Cposteriormente\u201D, \u201Csin embargo\u201D, moralejas, resumen escolar, tono solemne o p\xE1rrafos largos. Incluye 5-7 micro-remates o contrastes, siempre pegados a un dato nuevo; elimina reacciones vac\xEDas que no hagan avanzar la historia. A\xF1ade 4-6 golpes de lenguaje picante, neutral y variado cuando el tema lo permita; la palabrota debe caer como remate, no como muletilla. Evita frases tibias como \u201Cesto gener\xF3 debate\u201D, \u201Clas opiniones est\xE1n divididas\u201D o \u201Csolo el tiempo dir\xE1\u201D: reempl\xE1zalas por la contradicci\xF3n concreta demostrada por el brief. Asigna a cada escena un delivery entre golpe, veneno, suspenso, incredula o remate. Usa solamente verifiedFacts como afirmaciones de hecho; uncertainClaims solo pueden aparecer como duda expl\xEDcita. Las opiniones, conclusiones y burlas de Mala Fama est\xE1n permitidas y son bienvenidas mientras suenen a opini\xF3n. DIRECCI\xD3N VISUAL \u201CFLASH CUT\u201D: cada escena debe parecer una p\xE1gina arrancada de una revista de chismes de lujo intervenida por un artista editorial: retrato ilustrado 2D de t\xE9cnica mixta, recortes de papel, tinta expresiva, tramas halftone, grano de fotocopia, sombras duras y destellos de paparazzi. Paleta de marca limitada: negro tinta, marfil, verde \xE1cido, magenta el\xE9ctrico y azul cobalto. Es adulta, filosa, imperfecta y editorial; nunca animaci\xF3n familiar, mu\xF1eco 3D, chibi, rostro pl\xE1stico ni p\xF3ster gen\xE9rico. El Reel alterna tres capas visuales exactas: MALA FAMA aparece en las escenas 1, 5, 9, 13 y 16; el protagonista famoso aparece en las escenas 2, 4, 7, 10, 12 y 15; las escenas 3, 6, 8, 11 y 14 son cortes simb\xF3licos sin rostros. Cada visualPrompt del presentador debe comenzar literalmente con \u201CHOST_SCENE:\u201D para activar su identidad fija. Cada HOST_SCENE representa siempre al mismo diablo animado masculino adulto: rostro anguloso color borgo\xF1a oscuro, dos cuernos negros pulidos curvados hacia atr\xE1s, ojos verde \xE1cido, cabello negro peinado hacia atr\xE1s con una mecha blanca, barba puntiaguda corta, traje negro entallado, camisa magenta, guantes negros, pa\xF1uelo verde \xE1cido, cola fina terminada en punta y micr\xF3fono de metal ennegrecido. Sonrisa lateral de verdugo, ceja levantada y presencia dominante. Est\xE9tica de animaci\xF3n editorial adulta 2D, nunca demonio terror\xEDfico realista, personaje infantil, mujer, humano corriente, mu\xF1eco 3D ni copia de una franquicia. No cambies rostro, cuernos, ojos, cabello, vestuario, accesorios ni colores entre escenas. Antes de escribir los visualPrompt, define internamente un ANCLA DE CONTINUIDAD con tres rasgos p\xFAblicos estables del famoso \u2014estructura facial, peinado/color de cabello y estilo caracter\xEDstico\u2014 y repite literalmente esa misma descripci\xF3n en cada escena donde aparezca. No cambies edad aparente, cabello, facciones ni identidad entre escenas salvo que el hecho verificado lo exija. Alterna primer\xEDsimo primer plano recortado, \xE1ngulo holand\xE9s, plano medio asim\xE9trico, plano amplio teatral, cenital de objetos, silueta a contraluz y macro simb\xF3lico. Nunca uses dos rostros centrados ni el mismo encuadre consecutivamente. Las escenas 1, 4, 8, 12 y 16 son interrupciones visuales radicales con cambio de escala, composici\xF3n o color. Cuando aparezca el famoso, repite su nombre exacto y el ancla de continuidad; debe ser reconocible, ilustrado y nunca fotorealista. Si interviene una persona real, nunca pidas desnudez, lencer\xEDa, ropa interior, pose sexualizada ni una situaci\xF3n \xEDntima o comprometedora; usa objetos, sets publicitarios, c\xE1maras, telas o met\xE1foras visuales. Se permite collage f\xEDsico/editorial dentro de una \xFAnica composici\xF3n, pero nunca cuadr\xEDcula, split screen, captura de red social, texto legible, letras, logos, marcas, carteles, captions ni UI. El campo narration debe ser exactamente la concatenaci\xF3n, en orden, de las 16 narraciones de escena. No inventes nada fuera del brief.`;
    const sceneSchema = {
      type: "object",
      properties: {
        index: { type: "number" },
        narration: { type: "string" },
        visualPrompt: { type: "string" },
        purpose: { type: "string" },
        durationSeconds: { type: "number" },
        delivery: { type: "string", enum: ["golpe", "veneno", "suspenso", "incredula", "remate"] }
      },
      required: ["index", "narration", "visualPrompt", "purpose", "durationSeconds", "delivery"]
    };
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        coverDeck: { type: "string" },
        hook: { type: "string" },
        narration: { type: "string" },
        scenes: { type: "array", minItems: 16, maxItems: 16, items: sceneSchema },
        closingLine: { type: "string" }
      },
      required: ["title", "coverDeck", "hook", "narration", "scenes", "closingLine"]
    };
    let data = await generateStructured(editorialSystem, prompt, schema, 7600);
    const audioWording = (value) => asString(value).replace(/\bsí\s*,?\s*leíste bien\b/giu, "s\xED, escuchaste bien");
    data.title = audioWording(data.title);
    data.coverDeck = audioWording(data.coverDeck);
    data.hook = audioWording(data.hook);
    data.closingLine = audioWording(data.closingLine);
    if (Array.isArray(data.scenes)) {
      data.scenes = data.scenes.map((scene) => {
        if (!scene || typeof scene !== "object") return scene;
        const item = scene;
        return { ...item, narration: audioWording(item.narration) };
      });
    }
    const regionalismPattern = /\b(quilombo|che|bolud[oa]s?|pelotud[oa]s?|pibes?|minas?|laburo|guita|bancar|copad[oa]s?|posta|acá|parce|vaina|chimba|berrac[oa]s?|güey|wey|órale|cachai|we[oó]n|sos|tenés|podés|querés|mirá|esperá|decí|hacé|meté|pagá)\b/iu;
    const spokenDraft = [data.title, data.coverDeck, data.hook, data.closingLine, ...Array.isArray(data.scenes) ? data.scenes.map((scene) => scene && typeof scene === "object" ? asString(scene.narration) : "") : []].filter(Boolean).join(" ");
    if (regionalismPattern.test(spokenDraft)) {
      data = await generateStructured(editorialSystem, `${prompt}
REPARACI\xD3N OBLIGATORIA: el borrador anterior conten\xEDa regionalismos. Reescribe todo el texto hablado en espa\xF1ol latino neutro, conserva los hechos y el picante, y elimina voseo y vocabulario local.`, schema, 7600);
    }
    if (!Array.isArray(data.scenes) || data.scenes.length !== 16) throw new Error("story_requires_exactly_16_scenes");
    const finalClosingLine = audioWording(data.closingLine).replace(/[?¿]+/g, "").trim();
    if (finalClosingLine) {
      const lastScene = data.scenes[15];
      if (lastScene && typeof lastScene === "object") {
        data.scenes[15] = { ...lastScene, narration: finalClosingLine, delivery: "remate" };
        data.closingLine = finalClosingLine;
      }
    }
    // Punch-up pass (Sebastian 2026-10-09): the first draft of a local model tends to read like a
    // news summary. A second pass rewrites the same facts in Mala Fama's voice; it is kept only if it
    // still fits the length and closing rules, otherwise the first draft stays.
    const draftLines = data.scenes.map((scene) => asString(scene?.narration));
    const punched = await generateStructured(editorialSystem, `Reescrib\xED estas 16 narraciones de un Reel de chisme como las dir\xEDa MALA FAMA, el diablo maestro de ceremonias: cuenta el chisme armando esc\xE1ndalo, opina, sospecha, compara y se burla con humor negro filoso del ego, la pose y la hipocres\xEDa. Mismos hechos y mismo orden; prohibido agregar hechos nuevos. Al menos 8 de las 16 l\xEDneas deben llevar un remate, una burla o una opini\xF3n suya (\u201Cpara m\xED\u201D, \u201Cqu\xE9 casualidad\u201D, \u201Cdigamos la verdad\u201D, \u201Cy ahora viene lo bueno\u201D), sin repetir la misma f\xF3rmula. Cada l\xEDnea entre 7 y 15 palabras; la l\xEDnea 1 nombra al famoso y el conflicto; la l\xEDnea 16 es un veredicto cruel que termina en punto, sin pregunta; como m\xE1ximo 2 preguntas en total. Espa\xF1ol latino neutro, sin voseo.
BRIEF: ${JSON.stringify(research.verifiedFacts || research.summary || "")}
NARRACIONES: ${JSON.stringify(draftLines)}`, {
      type: "object",
      properties: { lines: { type: "array", minItems: 16, maxItems: 16, items: { type: "string" } } },
      required: ["lines"]
    }, 2600).catch(() => null);
    const punchedLines = asArray(punched?.lines).map((line) => audioWording(line).trim());
    const wordsOf = (line) => line.split(/\s+/).filter(Boolean).length;
    const totalWords = punchedLines.reduce((sum, line) => sum + wordsOf(line), 0);
    const punchFits = punchedLines.length === 16 && punchedLines.every((line) => wordsOf(line) >= 4 && wordsOf(line) <= 20) && totalWords >= 150 && totalWords <= 240 && !/[?¿]/.test(punchedLines[15]) && (punchedLines.join(" ").match(/\?/g) || []).length <= 2 && !regionalismPattern.test(punchedLines.join(" "));
    if (punchFits) {
      data.scenes = data.scenes.map((scene, index) => ({ ...scene, narration: punchedLines[index] }));
      data.closingLine = punchedLines[15];
    } else {
      console.warn(`[como-asi] punch-up pass discarded (${punchedLines.length} lines, ${totalWords} words)`);
    }
    const narration = data.scenes.map((scene) => scene && typeof scene === "object" ? asString(scene.narration) : "").filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return json({ ...data, narration });
  }],
  "POST /api/engine/image": [async ({ body }) => {
    const b = asBody(body);
    const visualPrompt = asString(b.visualPrompt);
    const topic = asString(b.topic);
    const protagonist = asString(b.protagonist);
    const forceSafeFallback = Boolean(b.safeFallback);
    if (!visualPrompt) return error("visualPrompt_required", 400);
    const sensitiveTerms = /(lingerie|underwear|nude|nudity|racy|provocative|bra\b|panties|sexual|seductive|bikini|desnudad?|lencer[ií]a|ropa interior|sost[eé]n|corpi[nñ]o|pose sensual)/i;
    const sensitiveVisual = forceSafeFallback || sensitiveTerms.test(visualPrompt);
    const hostScene = /\bHOST_SCENE\b/i.test(visualPrompt);
    const scenePrompt = visualPrompt.replace(/\bHOST_SCENE\b:?/gi, "").trim();
    const safeVisualConcept = scenePrompt.replace(/(lingerie|underwear|nude|nudity|racy|provocative|bra\b|panties|sexual|seductive|bikini|desnudad?|lencer[ií]a|ropa interior|sost[eé]n|corpi[nñ]o|pose sensual)/gi, "campa\xF1a de moda").replace(/\b[\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+)+\b/gu, "una celebridad ficticia").slice(0, 500);
    const regularPrompt = `Vertical 9:16, RECREACI\xD3N EDITORIAL \u201CFLASH CUT\u201D para \xBFC\xF3mo As\xED?. Tema: ${topic}. Protagonista p\xFAblico reconocido: ${protagonist}. Escena: ${scenePrompt}. Crear una ilustraci\xF3n adulta de t\xE9cnica mixta 2D: retrato editorial dibujado y recortado en papel, tinta expresiva, bordes rasgados, tramas halftone, grano de fotocopia, sombras duras, destello de paparazzi y un \xFAnico objeto simb\xF3lico enorme. Mantener la estructura facial, peinado, expresi\xF3n y estilo p\xFAblico que hacen reconocible inmediatamente a ${protagonist}, sin copiar ninguna fotograf\xEDa. Parecido real, exageraci\xF3n inteligente y emoci\xF3n teatral; nunca rostro gen\xE9rico. Mantener constantes edad aparente, estructura facial, color y forma del cabello y rasgos distintivos descritos en la escena; no embellecer hasta borrar la identidad. Composici\xF3n asim\xE9trica, recorte audaz, capas con profundidad y abundante espacio negativo. Paleta limitada de negro tinta, marfil, verde \xE1cido, magenta el\xE9ctrico y azul cobalto; cambiar el color dominante seg\xFAn la emoci\xF3n indicada. Debe sentirse como moda editorial irreverente y revista de chismes de lujo intervenida a mano, no como p\xF3ster. PROHIBIDO: animaci\xF3n infantil, Disney/Pixar, mu\xF1eco 3D, chibi, pl\xE1stico brillante, cabeza gigante, ojos de juguete, sonrisa permanente, pose frontal repetida o est\xE9tica de videojuego. Vestuario completamente cubierto y situaci\xF3n p\xFAblica no \xEDntima. Una sola composici\xF3n vertical de lectura instant\xE1nea, sin texto legible, letras, logos, marcas de agua, carteles, captions, cuadr\xEDcula, split screen ni UI.`;
    const hostPrompt = `Vertical 9:16, HOST SCENE de MALA FAMA, presentador masculino recurrente de \xBFC\xF3mo As\xED? y diablo animado editorial adulto. Escena y emoci\xF3n: ${scenePrompt}. Mostrar siempre exactamente el mismo personaje: rostro masculino anguloso color borgo\xF1a oscuro, dos cuernos negros pulidos curvados hacia atr\xE1s, ojos verde \xE1cido, cabello negro hacia atr\xE1s con una mecha blanca, barba puntiaguda corta, traje negro entallado, camisa magenta, guantes negros, pa\xF1uelo verde \xE1cido, cola fina terminada en punta y micr\xF3fono de metal ennegrecido. Sonrisa lateral de verdugo, ceja levantada, postura dominante; jam\xE1s gesto amistoso ni conversaci\xF3n de amigas. Animaci\xF3n editorial adulta 2D con papel rasgado, tinta, halftone, grano de fotocopia, sombras duras y flash de paparazzi. Paleta negro tinta, borgo\xF1a, marfil, verde \xE1cido, magenta y azul cobalto. Mantener id\xE9nticos rostro, cuernos, ojos, cabello, barba, vestuario, accesorios y colores en cada aparici\xF3n. Nunca mujer, humano corriente, demonio terror\xEDfico realista, personaje infantil, Disney/Pixar, mu\xF1eco 3D, chibi, pl\xE1stico brillante ni copia de una franquicia. Una sola composici\xF3n vertical, sin texto legible, letras, logos, marcas, carteles, captions, cuadr\xEDcula, split screen ni UI.`;
    const symbolicPrompt = `Vertical 9:16, RECREACI\xD3N EDITORIAL \u201CFLASH CUT\u201D claramente ficticia. Concepto visual: ${safeVisualConcept}. Contar el conflicto mediante un \xFAnico objeto simb\xF3lico enorme dentro de un collage f\xEDsico de papel rasgado, tinta, halftone, grano de fotocopia, sombras duras y flashes de paparazzi. Paleta limitada: negro tinta, marfil, verde \xE1cido, magenta el\xE9ctrico y azul cobalto. Composici\xF3n adulta, asim\xE9trica, sofisticada y agresiva, con profundidad real entre capas y espacio negativo; nunca caricatura 3D ni animaci\xF3n infantil. No mostrar, imitar ni sugerir el cuerpo o rostro de ninguna persona real. Si aparecen personas, deben ser adultos ficticios completamente vestidos y en poses neutrales. Sin desnudez, lencer\xEDa, ropa interior, sexualizaci\xF3n, texto legible, logos, marcas, carteles, cuadr\xEDcula, split screen ni UI.`;
    const selectedPrompt = hostScene ? hostPrompt : sensitiveVisual ? symbolicPrompt : regularPrompt;
    try {
      const result = await ai.imageGen({ prompt: selectedPrompt, maxOutputBytes: 95e4 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: sensitiveVisual });
    } catch (generationError) {
      if (sensitiveVisual) throw generationError;
      console.warn("[como-asi] primary image generation failed; using symbolic fallback", generationError);
      const result = await ai.imageGen({ prompt: symbolicPrompt, maxOutputBytes: 95e4 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: true });
    }
  }],
  "POST /api/engine/cover": [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    const title = asString(b.title);
    const protagonist = asString(b.protagonist);
    if (!topic) return error("topic_required", 400);
    const sensitiveCover = /(lingerie|underwear|nude|nudity|racy|provocative|bra\b|panties|sexual|seductive|bikini|desnudad?|lencer[ií]a|ropa interior|sost[eé]n|corpi[nñ]o|pose sensual)/i.test(`${topic} ${title}`);
    const regularPrompt = `Vertical 9:16 PORTADA-RECREACI\xD3N \u201CFLASH CUT\u201D para \xBFC\xF3mo As\xED?. Tema: ${topic}. Protagonista p\xFAblico reconocido: ${protagonist}. Ancla narrativa: ${title}. Crear un retrato editorial adulto de t\xE9cnica mixta 2D, inmediatamente reconocible como ${protagonist}: estructura facial, peinado, expresi\xF3n y estilo p\xFAblico conservados, sin copiar una fotograf\xEDa. Rostro recortado de forma audaz ocupando 45-60% del cuadro, gesto intenso y nada de sonrisa gen\xE9rica. Capas de papel rasgado, tinta expresiva, halftone, grano de fotocopia, sombra dura y flash de paparazzi; un solo objeto simb\xF3lico gigante relacionado con el chisme. Paleta negro tinta, marfil, verde \xE1cido, magenta el\xE9ctrico y azul cobalto. Composici\xF3n asim\xE9trica de revista de moda irreverente, con una zona oscura y limpia para la tipograf\xEDa del render. Nunca animaci\xF3n infantil, Disney/Pixar, mu\xF1eco 3D, chibi, pl\xE1stico brillante, cabeza gigante, ojos de juguete ni p\xF3ster gen\xE9rico. Vestuario completamente cubierto y situaci\xF3n p\xFAblica. Solo arte: ning\xFAn texto legible, letras, palabras, logos, marcas de agua, carteles, captions, cuadr\xEDcula, split screen ni UI.`;
    const safePrompt = "Vertical 9:16 PORTADA-RECREACI\xD3N \u201CFLASH CUT\u201D claramente ficticia sobre una celebridad y una campa\xF1a p\xFAblica controvertida. Mostrar un \xFAnico objeto simb\xF3lico enorme dentro de un collage f\xEDsico adulto de papel rasgado, tinta, halftone, grano de fotocopia, sombras duras y flashes de paparazzi. Paleta negro tinta, marfil, verde \xE1cido, magenta el\xE9ctrico y azul cobalto. Composici\xF3n asim\xE9trica, sofisticada y agresiva, con una zona oscura limpia para la tipograf\xEDa del render. No mostrar, imitar ni sugerir el cuerpo o rostro de ninguna persona real. Si aparece una figura humana, debe ser adulta, ficticia, completamente vestida y neutral. Nunca animaci\xF3n infantil, mu\xF1eco 3D, chibi ni pl\xE1stico brillante. Sin desnudez, ropa interior, sexualizaci\xF3n, texto, logos, marcas, carteles, cuadr\xEDcula, split screen ni UI.";
    const selectedPrompt = sensitiveCover ? safePrompt : regularPrompt;
    try {
      const result = await ai.imageGen({ prompt: selectedPrompt, maxOutputBytes: 95e4 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: sensitiveCover });
    } catch (generationError) {
      if (sensitiveCover) throw generationError;
      console.warn("[como-asi] primary cover generation failed; using symbolic fallback", generationError);
      const result = await ai.imageGen({ prompt: safePrompt, maxOutputBytes: 95e4 });
      return json({ data: result.image.data, mimeType: result.image.mimeType, bytes: result.image.bytes, safeFallback: true });
    }
  }],
  "POST /api/engine/publishing-kit": [async ({ body }) => {
    const b = asBody(body);
    const topic = asString(b.topic);
    const title = asString(b.title);
    const narration = asString(b.narration);
    const prompt = `Prepar\xE1 kit de publicaci\xF3n para un Reel de \xBFC\xF3mo As\xED?. Tema: ${topic}. T\xEDtulo: ${title}. Narraci\xF3n: ${narration}. El canal es CHISME + ACTUALIDAD VIRAL + FAMOSOS + BIZARRO/WTF + HUMOR NEGRO + CULTURA POP. Debe sonar filoso, irreverente, calle/pop, divertido y compartible. Nada de copy corporativo ni CTA mendigante. Abr\xED con reacci\xF3n, chisme o contradicci\xF3n; despu\xE9s el hecho central. El comentario fijado debe provocar conversaci\xF3n con picard\xEDa. T\xEDtulos provocadores pero factuales, nunca \u201Ctodo internet habla\u201D si no est\xE1 respaldado. Pod\xE9s usar una puteada leve si suma. HASHTAGS OBLIGATORIOS: gener\xE1 hashtags espec\xEDficos y buscables para cada red, mezclando protagonista/tema + intenci\xF3n de b\xFAsqueda + nicho; evit\xE1 relleno gen\xE9rico. Inclu\xED ComoAsi como hashtag de marca. Apunt\xE1 a 4-6 hashtags \xFAtiles en Instagram, 4-6 en TikTok y 3-5 en YouTube. No inventes datos nuevos ni conviertas rumor o broma en afirmaci\xF3n factual.`;
    const schema = {
      type: "object",
      properties: {
        instagram: { type: "object", properties: { caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } }, pinnedComment: { type: "string" } }, required: ["caption", "hashtags", "pinnedComment"] },
        tiktok: { type: "object", properties: { caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } }, pinnedComment: { type: "string" } }, required: ["caption", "hashtags", "pinnedComment"] },
        youtube: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } }, required: ["title", "description", "hashtags"] }
      },
      required: ["instagram", "tiktok", "youtube"]
    };
    const generated = await generateStructured(editorialSystem, prompt, schema, 3e3);
    return json(publishingKitWithHashtags(generated));
  }]
};
async function engineCall(route, body) {
  const handler = routes[`POST ${route}`];
  if (!handler) throw new EngineError(`local_engine_route_not_supported:${route}`, 404);
  return handler[0]({ body });
}
export {
  engineCall
};
