#!/usr/bin/env python3
"""Runs kaggle/kernel.py on a free Kaggle GPU from GitHub Actions and downloads the results.

  python kaggle/driver.py --bundle-dir <dir with bundle.tar.gz, context.json, run.json> --out <dir>

Auth: KAGGLE_API_TOKEN, or KAGGLE_USERNAME + KAGGLE_KEY. Dataset and notebook are private.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time

from kaggle.api.kaggle_api_extended import KaggleApi

DATASET_SLUG = "comoasi-batch-input"
KERNEL_SLUG = "comoasi-batch"

parser = argparse.ArgumentParser()
parser.add_argument("--bundle-dir", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--timeout-minutes", type=int, default=600)
args = parser.parse_args()

api = KaggleApi()
api.authenticate()
user = api.get_config_value("username")
if not user:
    sys.exit("could not resolve the Kaggle username from the token")
dataset_ref = f"{user}/{DATASET_SLUG}"
kernel_ref = f"{user}/{KERNEL_SLUG}"
print(f"[driver] kaggle user {user}", flush=True)

# 1. Upload the code bundle and context as a private dataset (new version each run).
with open(os.path.join(args.bundle_dir, "dataset-metadata.json"), "w") as handle:
    json.dump({"title": "comoasi batch input", "id": dataset_ref, "licenses": [{"name": "other"}]}, handle)
# Try a new version first; the first run creates the dataset instead.
try:
    result = api.dataset_create_version(args.bundle_dir, version_notes=time.strftime("%Y-%m-%d %H:%M"), quiet=True, dir_mode="tar")
    if getattr(result, "error", None):
        raise RuntimeError(result.error)
    print("[driver] dataset version created", flush=True)
except Exception as error:
    print(f"[driver] new version failed ({error}); creating dataset", flush=True)
    result = api.dataset_create_new(args.bundle_dir, public=False, quiet=True, dir_mode="tar")
    if getattr(result, "error", None):
        sys.exit(f"dataset create failed: {result.error}")
for _ in range(60):
    try:
        status = str(api.dataset_status(dataset_ref)).lower()
    except Exception as error:  # the status endpoint can 403 for a few seconds after creation
        status = f"status_error: {error}"
    print(f"[driver] dataset status: {status}", flush=True)
    if "ready" in status:
        break
    time.sleep(10)
print(f"[driver] dataset {dataset_ref} ready", flush=True)

# 2. Push and start the GPU notebook.
kernel_dir = tempfile.mkdtemp()
shutil.copy(os.path.join(os.path.dirname(__file__), "kernel.py"), os.path.join(kernel_dir, "kernel.py"))
metadata = {
    "id": kernel_ref,
    "title": KERNEL_SLUG,
    "code_file": "kernel.py",
    "language": "python",
    "kernel_type": "script",
    "is_private": True,
    "enable_gpu": True,
    "enable_internet": True,
    "dataset_sources": [dataset_ref],
    "competition_sources": [],
    "kernel_sources": [],
}
with open(os.path.join(kernel_dir, "kernel-metadata.json"), "w") as handle:
    json.dump(metadata, handle)
accelerator = os.environ.get("KAGGLE_ACCELERATOR") or None
api.kernels_push(kernel_dir, acc=accelerator)
print(f"[driver] pushed {kernel_ref} (accelerator: {accelerator or 'default GPU'})", flush=True)

# 3. Wait for it to finish.
deadline = time.time() + args.timeout_minutes * 60
state = "unknown"
time.sleep(60)
while time.time() < deadline:
    try:
        response = api.kernels_status(kernel_ref)
        state = str(getattr(response, "status", response)).lower()
    except Exception as error:
        state = f"status_error: {error}"
    print(f"[driver] {time.strftime('%H:%M:%S')} {state}", flush=True)
    if not state.startswith("status_error") and any(word in state for word in ("complete", "error", "cancel")):
        break
    time.sleep(120)

# 4. Download outputs (videos, results.json, logs) whatever the state.
os.makedirs(args.out, exist_ok=True)
page_token = None
while True:
    _, page_token = api.kernels_output(kernel_ref, path=args.out, force=True, quiet=True, page_token=page_token, page_size=100)
    if not page_token:
        break
print(f"[driver] outputs downloaded to {args.out}: {sorted(os.listdir(args.out))}", flush=True)
if "complete" not in state:
    sys.exit(f"kernel finished with state: {state}")
