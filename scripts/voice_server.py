#!/usr/bin/env python3
"""Mala Fama's devil voice, cloned on this machine with an open-source model, served on localhost.

Sebastian (2026-10-12): the voice must not depend on Microsoft. Chatterbox multilingual (Resemble AI,
MIT) clones the 15 s reference in assets/voice/mala-fama-diablo.wav, taken from the 2026-10-11
video with the music removed, so every video gets the same voice.

POST /tts    {"text", "out", "exaggeration", "cfg"} -> writes a WAV at "out"
POST /unload frees the GPU for the text and image models
GET  /       health

The model loads on the GPU with the most free memory when one has room, otherwise on the CPU, and
is released after each narration so it never competes with FLUX or Ollama.
"""
import gc
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import torch
import torchaudio

PORT = int(os.environ.get("VOICE_SERVER_PORT", 7870))
REFERENCE = os.environ.get("VOICE_REFERENCE", os.path.join(os.path.dirname(__file__), "..", "assets", "voice", "mala-fama-diablo.wav"))
MIN_FREE_GB = float(os.environ.get("VOICE_MIN_FREE_GB", "4"))
lock = Lock()
state = {"model": None, "device": None}


def log(message):
    print(f"[voice] {message}", flush=True)


def pick_device():
    if torch.cuda.is_available():
        free = [(torch.cuda.mem_get_info(index)[0] / 2**30, index) for index in range(torch.cuda.device_count())]
        best_free, best = max(free)
        if best_free >= MIN_FREE_GB:
            return f"cuda:{best}"
        log(f"no GPU with {MIN_FREE_GB} GB free ({', '.join(f'{gb:.1f}' for gb, _ in free)}); using the CPU")
    return "cpu"


def model():
    if state["model"] is None:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        device = pick_device()
        started = time.time()
        state["model"] = ChatterboxMultilingualTTS.from_pretrained(device=device)
        state["device"] = device
        log(f"loaded on {device} in {time.time() - started:.0f}s")
    return state["model"]


def unload():
    if state["model"] is not None:
        state["model"] = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        log(f"released {state['device']}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, {"ok": True, "reference": os.path.exists(REFERENCE), "device": state["device"]})

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            with lock:
                if self.path == "/unload":
                    unload()
                    return self.reply(200, {"ok": True})
                tts = model()
                started = time.time()
                wav = tts.generate(
                    req["text"],
                    language_id="es",
                    audio_prompt_path=REFERENCE,
                    exaggeration=float(req.get("exaggeration", 0.6)),
                    cfg_weight=float(req.get("cfg", 0.4)),
                )
                torchaudio.save(req["out"], wav, tts.sr)
                seconds = wav.shape[-1] / tts.sr
                log(f"{len(req['text'])} chars -> {seconds:.1f}s of audio in {time.time() - started:.0f}s on {state['device']}")
                self.reply(200, {"ok": True, "seconds": seconds})
        except Exception as error:
            traceback.print_exc()
            self.reply(500, {"error": str(error)})


if __name__ == "__main__":
    if not os.path.exists(REFERENCE):
        sys.exit(f"reference voice missing: {REFERENCE}")
    if len(sys.argv) > 2 and sys.argv[1] == "--check":
        # Loads the model, speaks one line and releases it; used before the batch starts.
        tts = model()
        torchaudio.save(sys.argv[2], tts.generate("Cómo así.", language_id="es", audio_prompt_path=REFERENCE), tts.sr)
        unload()
        sys.exit(0)
    log(f"serving on 127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
