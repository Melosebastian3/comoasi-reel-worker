#!/usr/bin/env python3
"""¿Cómo Así? daily batch on a free Kaggle GPU.

Pushed by kaggle/driver.py from GitHub Actions. It reads the code bundle and the editorial
context from the attached private dataset, runs the original pipeline (batch.js) against a
throwaway local Postgres with open-source models, and leaves in /kaggle/working:
  results.json   rows to import into the real database
  out/           final videos, covers and the manifest
  batch.log      full log
No database password or social account credential ever reaches Kaggle.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

WORK = "/kaggle/working"
APP = "/kaggle/temp/app"
ASSETS = "/kaggle/temp/assets"
NODE_VERSION = "v20.18.1"
LOG = open(os.path.join(WORK, "batch.log"), "a", buffering=1)


def log(message):
    line = f"[kernel {time.strftime('%H:%M:%S')}] {message}"
    print(line, flush=True)
    LOG.write(line + "\n")


def sh(command, env=None, check=True):
    log(f"$ {command}")
    result = subprocess.run(command, shell=True, env=env, stdout=LOG, stderr=subprocess.STDOUT)
    if check and result.returncode != 0:
        raise SystemExit(f"command failed ({result.returncode}): {command}")
    return result.returncode


def wait_http(url, seconds, process=None):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if process is not None and process.poll() is not None:
            raise SystemExit(f"process serving {url} exited with code {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                return response.read().decode()
        except Exception:
            time.sleep(10)
    raise SystemExit(f"timeout waiting for {url}")


def find_input():
    runs = glob.glob("/kaggle/input/**/run.json", recursive=True)
    if not runs:
        raise SystemExit("run.json not found in /kaggle/input")
    folder = os.path.dirname(runs[0])
    os.makedirs(APP, exist_ok=True)
    bundle = os.path.join(folder, "bundle.tar.gz")
    if os.path.exists(bundle):
        with tarfile.open(bundle) as archive:
            archive.extractall(APP)
    else:
        unpacked = glob.glob(os.path.join(folder, "**/package.json"), recursive=True)
        shutil.copytree(os.path.dirname(unpacked[0]), APP, dirs_exist_ok=True)
    with open(runs[0]) as handle:
        run = json.load(handle)
    shutil.copy(os.path.join(folder, "context.json"), os.path.join(APP, "context.json"))
    return run


def gpu_count():
    try:
        out = subprocess.run("nvidia-smi -L", shell=True, capture_output=True, text=True).stdout
        return len([line for line in out.splitlines() if line.startswith("GPU")])
    except Exception:
        return 0


def main():
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    run = find_input()
    log(f"run: {json.dumps(run)}")
    gpus = gpu_count()
    log(f"gpus: {gpus}")
    sh("nvidia-smi || true", check=False)

    sh("apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql ffmpeg fonts-dejavu-core xz-utils zstd")
    sh(f"curl -fsSL https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-linux-x64.tar.xz | tar -xJ -C /opt")
    node_bin = f"/opt/node-{NODE_VERSION}-linux-x64/bin"
    # Versions that work with the current Kaggle image (Python 3.13, Triton 3: bitsandbytes < 0.45.1 imports the removed triton.ops).
    sh("pip install -q 'edge-tts>=7.2' 'diffusers>=0.35,<0.37' 'bitsandbytes>=0.46.1' 'transformers>=4.51,<5' 'accelerate>=1.6' sentencepiece protobuf")
    sh("python3 -c \"import torch, diffusers, bitsandbytes; from diffusers import FluxPipeline, StableDiffusionXLPipeline; "
       "print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '-', "
       "'diffusers', diffusers.__version__, 'bnb', bitsandbytes.__version__)\"")

    env = dict(os.environ)
    env["PATH"] = f"{node_bin}:{env['PATH']}"
    env.update({
        "ENGINE_MODE": "local",
        "DATABASE_URL": "postgres://comoasi:comoasi@127.0.0.1:5432/comoasi",
        "LOCAL_ASSET_DIR": ASSETS,
        "LLM_BASE_URL": "http://127.0.0.1:11434/v1",
        "LLM_MODEL": run.get("llmModel", "qwen2.5:14b-instruct"),
        "LLM_JSON_MODE": "openai",
        "IMAGE_BACKEND": "server",
        "IMAGE_PROMPT_WORDS": "70",
        "IMAGE_CONDENSE": "on",
    })

    # edge-tts breaks whenever Microsoft rotates its client version; fail now instead of after the images.
    sh(f"python3 -m edge_tts --voice es-MX-JorgeNeural --text 'Cómo así' --write-media {WORK}/voice-check.mp3")
    os.remove(f"{WORK}/voice-check.mp3")

    # Throwaway database with the real schema and the editorial memory exported by Actions.
    sh("service postgresql start")
    sh("su postgres -c \"psql -qc \\\"create role comoasi login password 'comoasi'\\\"\"", check=False)
    sh("su postgres -c \"createdb -O comoasi comoasi\"", check=False)
    sh(f"cd {APP} && npm ci --omit=dev --no-audit --no-fund", env=env)
    sh(f"psql postgres://comoasi:comoasi@127.0.0.1:5432/comoasi -q -v ON_ERROR_STOP=1 -f {APP}/db/schema.sql", env=env)
    sh(f"cd {APP} && node local/sync.js load-context context.json", env=env)

    # Text model on the first GPU, image model on the second one when there are two.
    ollama_env = dict(env)
    # Ollama defaults to a 4k window and silently truncates; the topic prompt with headlines is ~17k tokens.
    ollama_env.update({"OLLAMA_CONTEXT_LENGTH": "24576", "OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0"})
    image_env = dict(env)
    if gpus >= 2:
        ollama_env["CUDA_VISIBLE_DEVICES"] = "0"
        image_env["CUDA_VISIBLE_DEVICES"] = "1"
    else:
        ollama_env["OLLAMA_KEEP_ALIVE"] = "0"  # free GPU memory for images between text calls
    # The image model downloads and loads while Ollama installs and pulls the text model.
    image_env["IMAGE_MODEL"] = run.get("imageModel", "flux-schnell")
    image_server = subprocess.Popen(f"python3 {APP}/scripts/imagegen_server.py", shell=True, env=image_env, stdout=LOG, stderr=subprocess.STDOUT)
    sh("curl -fsSL https://ollama.com/install.sh | sh")
    subprocess.Popen("ollama serve", shell=True, env=ollama_env, stdout=LOG, stderr=subprocess.STDOUT)
    wait_http("http://127.0.0.1:11434/api/version", 120)
    sh(f"ollama pull {env['LLM_MODEL']}", env=ollama_env)

    log(f"image server: {wait_http('http://127.0.0.1:7860/', 3600, image_server)}")

    args = f"--date {run['date']} --count {run.get('count', 3)}"
    if run.get("slots"):
        args += f" --slots {run['slots']}"
    code = sh(f"cd {APP} && node batch.js {args}", env=env, check=False)

    sh(f"cd {APP} && node local/sync.js export-results {WORK}/results.json --since {started}", env=env)
    out = os.path.join(WORK, "out")
    # Scene images too, so a run that fails late can still be reviewed.
    for pattern in ("**/*.mp4", "**/*.png", "**/*.jpg", "**/*.webp", "manifest-*.json"):
        for path in glob.glob(os.path.join(ASSETS, pattern), recursive=True):
            target = os.path.join(out, os.path.relpath(path, ASSETS))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy(path, target)
    log(f"batch exit code {code}")
    with open(os.path.join(WORK, "status.json"), "w") as handle:
        json.dump({"batchExitCode": code, "started": started, "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, handle)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as stop:
        log(f"stopped: {stop}")
        with open(os.path.join(WORK, "status.json"), "w") as handle:
            json.dump({"error": str(stop)}, handle)
        raise
