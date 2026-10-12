"""Canal de noticias insólitas: una noticia real y absurda, narrada con humor sobre video real.

Pasos: fuentes RSS de noticias raras -> Groq elige la historia y escribe el guion (solo con los
datos del artículo) -> Piper genera la voz por bloque -> cada bloque busca un clip de stock con
licencia libre (Pexels si hay clave, si no Wikimedia Commons) -> ffmpeg arma el vertical 1080x1920
con subtítulos. No publica nada: deja out/<slug>/video.mp4 y meta.json.

Variables: GROQ_API_KEY (obligatoria), PEXELS_API_KEY (opcional), PIPER_MODEL (ruta .onnx),
OUT_DIR, HISTORY_FILE (temas ya usados, para no repetir).
"""

import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
W, H = 1080, 1920
MAX_AGE_HOURS = int(os.environ.get("MAX_AGE_HOURS", "72"))

# Fuentes dedicadas a noticias raras (en inglés tienen mucho más volumen) y búsquedas en español.
FEEDS = [
    "https://rss.upi.com/news/odd_news.rss",
    "https://www.odditycentral.com/feed",
    "https://www.huffpost.com/section/weird-news/feed",
    "https://news.google.com/rss/search?q=ins%C3%B3lito+when:2d&hl=es-419&gl=AR&ceid=AR:es-419",
    "https://news.google.com/rss/search?q=%22insolito%22+OR+%22curioso%22+OR+%22increible%22+when:2d&hl=es-419&gl=MX&ceid=MX:es-419",
    "https://news.google.com/rss/search?q=bizarre+OR+%22odd+news%22+when:2d&hl=en-US&gl=US&ceid=US:en",
]

LIMITS = (
    "Prohibido: muertes, accidentes graves, violencia, abuso, violencia de género, menores en riesgo, "
    "enfermedades graves, tragedias, política partidaria, religión y burlas a víctimas. "
    "Sí: animales que hacen cosas raras, récords absurdos, inventos inútiles, robos torpes, "
    "situaciones ridículas, leyes raras, bodas o fiestas insólitas, malentendidos."
)


def log(msg):
    print(f"[insolito] {msg}", flush=True)


def http(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clean(text):
    text = re.sub(r"<[^>]+>", " ", html.unescape(text or ""))
    return re.sub(r"\s+", " ", text).strip()


def fetch_candidates():
    now = datetime.now(timezone.utc)
    items, seen = [], set()
    for url in FEEDS:
        try:
            root = ET.fromstring(http(url))
        except Exception as e:  # una fuente caída no frena las demás
            log(f"fuente sin respuesta {url[:60]}: {e}")
            continue
        for it in root.iter("item"):
            title = clean(it.findtext("title"))
            link = (it.findtext("link") or "").strip()
            try:
                when = parsedate_to_datetime(it.findtext("pubDate") or "")
            except Exception:
                when = now
            if not title or not link or now - when > timedelta(hours=MAX_AGE_HOURS):
                continue
            key = re.sub(r"\W+", "", title.lower())[:60]
            if key in seen:
                continue
            seen.add(key)
            items.append({"title": title, "link": link, "summary": clean(it.findtext("description"))[:280],
                          "source": urllib.parse.urlparse(link).netloc})
    log(f"{len(items)} noticias candidatas")
    return items


def article_text(link):
    """Texto del artículo para que el guion no invente; si no se puede leer, queda el resumen."""
    try:
        import trafilatura
        raw = http(link, timeout=25).decode("utf-8", "ignore")
        return (trafilatura.extract(raw) or "")[:4500]
    except Exception as e:
        log(f"no pude leer el artículo: {e}")
        return ""


def groq(system, prompt, max_tokens=2500):
    key = os.environ["GROQ_API_KEY"]
    body = json.dumps({
        "model": os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "max_completion_tokens": max_tokens,
        "temperature": 0.8,
        "reasoning_effort": "low",
        "response_format": {"type": "json_object"},
    }).encode()
    for attempt in range(6):
        try:
            raw = http("https://api.groq.com/openai/v1/chat/completions", data=body, timeout=180,
                       headers={"content-type": "application/json", "authorization": f"Bearer {key}"})
            return json.loads(json.loads(raw)["choices"][0]["message"]["content"])
        except urllib.error.HTTPError as e:
            detail = e.read()[:300]
            if e.code == 429:
                wait = min(90, max(5, float(e.headers.get("retry-after") or 20)))
                log(f"groq limitado, espero {wait}s")
                time.sleep(wait)
                continue
            raise RuntimeError(f"groq_http_{e.code}: {detail}")
        except (json.JSONDecodeError, KeyError) as e:
            log(f"respuesta de groq inválida ({e}), reintento")
    raise RuntimeError("groq no respondió")


def pick_story(cands, history):
    listing = "\n".join(f"{i}. {c['title']} | {c['summary'][:160]}" for i, c in enumerate(cands[:40]))
    used = "; ".join(history[-30:]) or "ninguno"
    out = groq(
        "Sos editor de un canal de TikTok de noticias insólitas reales. Elegís historias que den risa "
        "o asombro y que se entiendan sin contexto. " + LIMITS,
        f"Noticias de las últimas horas:\n{listing}\n\nYa usados (no repetir): {used}\n\n"
        'Devolvé JSON {"ranking": [índices de las 5 mejores, de mejor a peor]}. '
        "Descartá las que rompan las prohibiciones.",
        max_tokens=800,
    )
    picks = [int(i) for i in out.get("ranking", []) if str(i).isdigit()]
    return [cands[i] for i in picks if i < len(cands)]


def write_script(story, text):
    facts = text or story["summary"]
    return groq(
        "Sos el guionista de 'Insólito', un canal argentino de noticias reales absurdas. El narrador "
        "cuenta la historia como un amigo que no lo puede creer: rioplatense, con voseo, ironía y "
        "remates cortos, sin malas palabras fuertes. Nunca inventes datos: nombres, lugares, cifras "
        "y hechos salen SOLO del artículo. Los chistes son opinión del narrador, no hechos. " + LIMITS,
        f"Título: {story['title']}\nFuente: {story['source']}\nArtículo:\n{facts}\n\n"
        "Escribí un guion de 40 a 55 segundos (110 a 150 palabras en total) en 7 a 9 bloques. "
        "El bloque 1 es un gancho de máximo 12 palabras que obligue a quedarse. El último cierra con "
        "un remate y una pregunta para que comenten. Para cada bloque da una búsqueda en INGLÉS de "
        "2 a 4 palabras para encontrar un clip de stock real que lo ilustre (cosas genéricas y "
        "filmables: 'cat on roof', 'police car night', 'wedding party dance'; nunca nombres propios). "
        'Devolvé JSON {"apta": true|false, "motivo": "...", "titulo": "texto en pantalla de máx 6 '
        'palabras", "bloques": [{"texto": "...", "busqueda": "..."}], "descripcion": "texto para la '
        'publicación, 1-2 frases", "hashtags": ["#..."]}. Si la historia rompe las prohibiciones o el '
        'artículo no alcanza para contarla, apta=false.',
        max_tokens=2500,
    )


def tts(text, wav):
    model = os.environ["PIPER_MODEL"]
    subprocess.run([sys.executable, "-m", "piper", "-m", model, "-f", str(wav),
                    "--length-scale", os.environ.get("PIPER_SPEED", "0.92")],
                   input=text.encode(), check=True, capture_output=True)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def pexels(query, min_dur):
    key = os.environ.get("PEXELS_API_KEY")
    if not key:
        return None
    q = urllib.parse.urlencode({"query": query, "orientation": "portrait", "per_page": 15})
    data = json.loads(http(f"https://api.pexels.com/videos/search?{q}", headers={"Authorization": key}))
    for v in data.get("videos", []):
        if v.get("duration", 0) < min_dur:
            continue
        files = sorted((f for f in v["video_files"] if f.get("height") and f["height"] >= 1080 and f.get("file_type") == "video/mp4"),
                       key=lambda f: f["height"])
        if files:
            return {"url": files[0]["link"], "credit": f"{v['user']['name']} (Pexels)", "id": f"pexels-{v['id']}"}
    return None


def commons(query, min_dur):
    q = urllib.parse.urlencode({"action": "query", "format": "json", "generator": "search",
                                "gsrsearch": f"{query} filetype:video", "gsrnamespace": 6, "gsrlimit": 15,
                                "prop": "imageinfo", "iiprop": "url|extmetadata|mediatype|size"})
    data = json.loads(http(f"https://commons.wikimedia.org/w/api.php?{q}"))
    pages = sorted(data.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 99))
    for p in pages:
        info = (p.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata", {})
        lic = meta.get("LicenseShortName", {}).get("value", "")
        if (not info.get("url") or float(info.get("duration") or 0) < min_dur or info.get("size", 0) > 200e6
                or "NC" in lic or "ND" in lic):
            continue
        artist = clean(meta.get("Artist", {}).get("value", "")) or "Wikimedia Commons"
        return {"url": info["url"], "credit": f"{artist[:60]} ({lic}, Wikimedia Commons)", "id": f"commons-{p['pageid']}"}
    return None


def find_clip(query, min_dur, used):
    tries = [query, " ".join(query.split()[:2]), query.split()[0]]
    for q in dict.fromkeys(tries):
        for source in (pexels, commons):
            try:
                clip = source(q, min_dur)
            except Exception as e:
                log(f"{source.__name__} falló con '{q}': {e}")
                continue
            if clip and clip["id"] not in used:
                return clip
    return None


def ass_text(text):
    return re.sub(r"[{}\\]", "", text).upper()


def ass_time(t):
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def subtitles(blocks, title, path):
    """Subtítulos grandes de 3-4 palabras, repartidos según el largo de cada bloque de voz."""
    lines = ["[Script Info]", "PlayResX: 1080", "PlayResY: 1920", "", "[V4+ Styles]",
             "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV",
             "Style: Sub,DejaVu Sans,86,&H00FFFFFF,&H00000000,&H64000000,1,1,7,2,2,70,70,560",
             "Style: Title,DejaVu Sans,78,&H0000E5FF,&H00000000,&H64000000,1,1,7,2,8,70,70,190",
             "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    lines.append(f"Dialogue: 0,{ass_time(0)},{ass_time(min(4.0, blocks[0]['end'] + 1))},Title,,0,0,0,,{ass_text(title)}")
    for b in blocks:
        words = b["texto"].split()
        chunks = [words[i:i + 3] for i in range(0, len(words), 3)]
        total = sum(len(" ".join(c)) for c in chunks) or 1
        t = b["start"]
        for c in chunks:
            seg = (b["end"] - b["start"]) * len(" ".join(c)) / total
            lines.append(f"Dialogue: 0,{ass_time(t)},{ass_time(t + seg)},Sub,,0,0,0,,{ass_text(' '.join(c))}")
            t += seg
    path.write_text("\n".join(lines), encoding="utf-8")


def render(blocks, title, work, out):
    parts = []
    for i, b in enumerate(blocks):
        src = work / f"clip{i}.src"
        http_dl(b["clip"]["url"], src)
        part = work / f"part{i}.mp4"
        dur = b["end"] - b["start"]
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "0.5", "-i", str(src), "-t", f"{dur:.3f}", "-an",
                        "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps=30,setsar=1",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(part)], check=True)
        parts.append(part)
    (work / "parts.txt").write_text("".join(f"file '{p.name}'\n" for p in parts))
    subtitles(blocks, title, work / "subs.ass")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "parts.txt", "-i", "voice.wav",
                    "-vf", "subtitles=subs.ass", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
                    str(out.resolve())], check=True, cwd=work)


def http_dl(url, path):
    path.write_bytes(http(url, timeout=120))


def main():
    out_root = Path(os.environ.get("OUT_DIR", "out"))
    hist_file = Path(os.environ.get("HISTORY_FILE", "history.json"))
    history = json.loads(hist_file.read_text()) if hist_file.exists() else []
    ranking = pick_story(fetch_candidates(), history)
    for story in ranking:
        log(f"probando: {story['title']}")
        script = write_script(story, article_text(story["link"]))
        if not script.get("apta") or not script.get("bloques"):
            log(f"descartada: {script.get('motivo')}")
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", story["title"].lower())[:50].strip("-")
        work = out_root / slug
        work.mkdir(parents=True, exist_ok=True)
        blocks, t, used = [], 0.0, set()
        wavs = []
        for i, b in enumerate(script["bloques"]):
            wav = work / f"v{i}.wav"
            tts(b["texto"], wav)
            d = duration(wav) + 0.15
            clip = find_clip(b["busqueda"], d + 0.6, used)
            if not clip:
                log(f"sin clip para '{b['busqueda']}'")
                break
            used.add(clip["id"])
            blocks.append({**b, "start": t, "end": t + d, "clip": clip})
            wavs.append(wav)
            t += d
        else:
            # Voz completa con una pausa corta entre bloques (la misma que se sumó a cada duración).
            inputs = sum((["-i", str(w)] for w in wavs), [])
            pads = "".join(f"[{i}:a]apad=pad_dur=0.15[a{i}];" for i in range(len(wavs)))
            concat = "".join(f"[a{i}]" for i in range(len(wavs)))
            subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex",
                            f"{pads}{concat}concat=n={len(wavs)}:v=0:a=1[out]", "-map", "[out]",
                            str(work / "voice.wav")], check=True)
            render(blocks, script.get("titulo") or story["title"], work, work / "video.mp4")
            credits = sorted({b["clip"]["credit"] for b in blocks})
            meta = {"story": story, "titulo": script.get("titulo"), "guion": [b["texto"] for b in blocks],
                    "descripcion": script.get("descripcion"), "hashtags": script.get("hashtags"),
                    "creditos": credits, "duracion": round(t, 1),
                    "caption": f"{script.get('descripcion', '')}\n\n{' '.join(script.get('hashtags') or [])}\n\n"
                               f"Fuente: {story['source']}. Videos: {'; '.join(credits)}"}
            (work / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
            history.append(story["title"])
            hist_file.write_text(json.dumps(history[-200:], ensure_ascii=False, indent=1))
            log(f"listo: {work / 'video.mp4'} ({t:.1f}s)")
            return 0
        log("no se pudo ilustrar, pruebo la siguiente historia")
    log("ninguna historia salió")
    return 1


if __name__ == "__main__":
    sys.exit(main())
