#!/usr/bin/env python3
"""Local, open-source image generation for Mala Fama (CPU friendly).

Default model: SimianLuo/LCM_Dreamshaper_v7 (CreativeML OpenRAIL-M, commercial use allowed
under its use restrictions). Override with IMAGE_MODEL. 4 LCM steps keep CPU time low.
"""
import argparse
import os

import torch
from diffusers import DiffusionPipeline

parser = argparse.ArgumentParser()
parser.add_argument("--prompt", required=True)
parser.add_argument("--negative", default="")
parser.add_argument("--out", required=True)
parser.add_argument("--width", type=int, default=int(os.environ.get("IMAGE_WIDTH", 512)))
parser.add_argument("--height", type=int, default=int(os.environ.get("IMAGE_HEIGHT", 896)))
parser.add_argument("--steps", type=int, default=int(os.environ.get("IMAGE_STEPS", 4)))
parser.add_argument("--seed", type=int, default=int(os.environ.get("IMAGE_SEED", 0)) or None)
args = parser.parse_args()

model = os.environ.get("IMAGE_MODEL", "SimianLuo/LCM_Dreamshaper_v7")
torch.set_num_threads(os.cpu_count() or 2)
pipe = DiffusionPipeline.from_pretrained(model, torch_dtype=torch.float32, safety_checker=None)
pipe.to("cpu")
generator = torch.Generator("cpu").manual_seed(args.seed) if args.seed else None
kwargs = dict(
    prompt=args.prompt,
    width=args.width,
    height=args.height,
    num_inference_steps=args.steps,
    guidance_scale=float(os.environ.get("IMAGE_GUIDANCE", 8.0)),
    generator=generator,
)
# LCM pipelines ignore negative prompts; pass it only to pipelines that accept it.
if args.negative and "LCM" not in type(pipe).__name__:
    kwargs["negative_prompt"] = args.negative
image = pipe(**kwargs).images[0]
image.save(args.out)
