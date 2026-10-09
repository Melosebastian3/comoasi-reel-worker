#!/usr/bin/env python3
"""Keeps an open-source diffusion model loaded on the GPU and serves images on localhost.

POST /generate {"prompt", "negative", "width", "height", "steps", "seed"} -> image/png

IMAGE_MODEL:
  flux-schnell    black-forest-labs/FLUX.1-schnell (Apache-2.0), transformer quantized to 4 bit
                  so it fits a 16 GB Kaggle GPU. Default.
  sdxl-lightning  stabilityai/stable-diffusion-xl-base-1.0 + ByteDance/SDXL-Lightning 4-step
                  (CreativeML OpenRAIL++-M). Used automatically if FLUX cannot load.
"""
import io
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import torch

PORT = int(os.environ.get("IMAGE_SERVER_PORT", 7860))
DEVICE = os.environ.get("IMAGE_DEVICE", "cuda")
lock = Lock()


def load_flux():
    from diffusers import BitsAndBytesConfig, FluxPipeline, FluxTransformer2DModel
    from transformers import BitsAndBytesConfig as TransformersBitsAndBytesConfig, T5EncoderModel

    repo = "black-forest-labs/FLUX.1-schnell"
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16)
    transformer = FluxTransformer2DModel.from_pretrained(
        repo, subfolder="transformer", quantization_config=quant, torch_dtype=torch.float16
    )
    # The T5 text encoder is ~9.5 GB in fp16; 4-bit keeps the whole pipeline (~11 GB) on one 15 GB
    # GPU, so nothing is offloaded to the ~30 GB of host RAM that Ollama and Node also use.
    text_encoder_2 = T5EncoderModel.from_pretrained(
        repo, subfolder="text_encoder_2", torch_dtype=torch.float16,
        quantization_config=TransformersBitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16),
    )
    pipe = FluxPipeline.from_pretrained(repo, transformer=transformer, text_encoder_2=text_encoder_2, torch_dtype=torch.float16)
    if os.environ.get("IMAGE_OFFLOAD") == "1":
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(DEVICE)
    pipe.vae.enable_tiling()

    def run(req):
        return pipe(
            prompt=req["prompt"],
            width=req.get("width", 768),
            height=req.get("height", 1344),
            num_inference_steps=req.get("steps", 4),
            guidance_scale=0.0,
            max_sequence_length=256,
            generator=torch.Generator("cpu").manual_seed(req["seed"]) if req.get("seed") else None,
        ).images[0]

    return run


def load_sdxl_lightning():
    from diffusers import EulerDiscreteScheduler, StableDiffusionXLPipeline, UNet2DConditionModel
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file

    base = "stabilityai/stable-diffusion-xl-base-1.0"
    unet = UNet2DConditionModel.from_config(base, subfolder="unet").to(DEVICE, torch.float16)
    unet.load_state_dict(load_file(hf_hub_download("ByteDance/SDXL-Lightning", "sdxl_lightning_4step_unet.safetensors"), device=DEVICE))
    pipe = StableDiffusionXLPipeline.from_pretrained(base, unet=unet, torch_dtype=torch.float16, variant="fp16").to(DEVICE)
    pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")

    def run(req):
        return pipe(
            prompt=req["prompt"],
            negative_prompt=req.get("negative") or None,
            width=req.get("width", 768),
            height=req.get("height", 1344),
            num_inference_steps=4,
            guidance_scale=0.0,
            generator=torch.Generator(DEVICE).manual_seed(req["seed"]) if req.get("seed") else None,
        ).images[0]

    return run


def load():
    wanted = os.environ.get("IMAGE_MODEL", "flux-schnell")
    loaders = {"flux-schnell": load_flux, "sdxl-lightning": load_sdxl_lightning}
    order = [wanted] + [name for name in loaders if name != wanted]
    for name in order:
        try:
            print(f"[imagegen] loading {name}", flush=True)
            runner = loaders[name]()
            print(f"[imagegen] ready: {name}", flush=True)
            return name, runner
        except Exception:
            traceback.print_exc()
            print(f"[imagegen] {name} failed to load", flush=True)
    sys.exit("no image model could be loaded")


MODEL_NAME, RUN = load()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"model": MODEL_NAME}).encode())

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            with lock:
                image = RUN(req)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            data = buffer.getvalue()
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("x-image-model", MODEL_NAME)
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            traceback.print_exc()
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(error).encode())


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
