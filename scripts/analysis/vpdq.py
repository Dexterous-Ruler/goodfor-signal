#!/usr/bin/env python3
# vPDQ near-duplicate hashing sidecar: ~1 frame/sec -> 256-bit PDQ per frame.
# NOTE: on Python 3.14 a wheel for `pdqhash` (ThreatExchange) may not exist yet;
#   this script falls back to a self-contained numpy DCT hash so it still runs
#   (see the deps note in the package summary). Run under 3.11-3.12 for true PDQ.
#
# Pure compute, JSON on stdout, NO database. Frames are decoded by piping raw
# rgb24 out of ffmpeg (only ffmpeg + numpy required — no OpenCV/Pillow).
#
# Protocol:
#   argv   : --video PATH [--fps N]
#   stdout : { "frames": [{ "tSeconds": float, "hash": "<64 hex chars>" }, ...] }
#            error -> { "error": str, "detail"?: str }
#
# The 64-char hex is a 256-bit hash MSB-first per byte. TS-side findDuplicates
# compares these by Hamming distance; only internal consistency matters, and
# both the true-PDQ and fallback paths pack bits the same way.

import sys
import os
import json
import argparse
import subprocess

# A fixed square decode size keeps every frame the same length so the raw
# rgb24 stream reshapes cleanly, and gives both hash paths a consistent input.
DECODE = 512
FALLBACK = 64  # DCT grid for the fallback hash (64 = 512 / 8, exact block-mean)


def fail(error, detail=None, code=1):
    payload = {"error": error}
    if detail is not None:
        payload["detail"] = str(detail)
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    sys.exit(code)


def load_numpy():
    try:
        import numpy as np
        return np
    except Exception as exc:
        fail("deps-missing", detail="numpy required: %s" % exc, code=3)


def decode_frames(np, video, fps):
    """Pipe rgb24 frames out of ffmpeg at `fps` fps, scaled to DECODE x DECODE."""
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    cmd = [
        ffmpeg,
        "-v", "error",
        "-i", video,
        "-vf", "fps=%s,scale=%d:%d" % (fps, DECODE, DECODE),
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError as exc:
        fail("ffmpeg-missing", detail=str(exc), code=4)

    if proc.returncode != 0:
        fail("ffmpeg-failed", detail=proc.stderr.decode("utf-8", "replace")[:500], code=4)

    frame_bytes = DECODE * DECODE * 3
    total = len(proc.stdout)
    n = total // frame_bytes
    if n == 0:
        fail("no-frames", detail="ffmpeg produced no decodable frames", code=4)

    buf = np.frombuffer(proc.stdout[: n * frame_bytes], dtype=np.uint8)
    return buf.reshape(n, DECODE, DECODE, 3)


def bits_to_hex(np, bits):
    """256 0/1 bits -> 32 bytes (MSB-first) -> 64 lowercase hex chars."""
    b = np.asarray(bits, dtype=np.uint8).reshape(-1)
    if b.size != 256:
        # Pad/truncate defensively; both hash paths already produce exactly 256.
        fixed = np.zeros(256, dtype=np.uint8)
        fixed[: min(256, b.size)] = b[:256]
        b = fixed
    packed = np.packbits(b)  # MSB-first by default -> 32 bytes
    return packed.tobytes().hex()


def load_pdq():
    try:
        import pdqhash
        return pdqhash
    except Exception:
        return None


def _dct_matrix(np, n):
    """Orthonormal DCT-II basis matrix (n x n)."""
    k = np.arange(n).reshape(1, n)
    x = np.arange(n).reshape(n, 1)
    m = np.cos(np.pi * (2 * x + 1) * k / (2 * n))
    m *= np.sqrt(2.0 / n)
    m[:, 0] *= 1.0 / np.sqrt(2.0)
    return m.T  # rows = basis vectors


def fallback_hash(np, frame, dct_cache):
    """Self-contained 256-bit DCT perceptual hash. NOT true PDQ — a fallback.

    Luma -> 64x64 (area block-mean of the 512x512) -> 2D DCT -> top-left 16x16
    (256 coeffs) -> threshold each against the block median.
    """
    # Rec.601 luma.
    luma = (
        0.299 * frame[:, :, 0] + 0.587 * frame[:, :, 1] + 0.114 * frame[:, :, 2]
    ).astype(np.float64)
    # 512 -> 64 by exact 8x8 block averaging.
    factor = DECODE // FALLBACK
    small = luma.reshape(FALLBACK, factor, FALLBACK, factor).mean(axis=(1, 3))

    d = dct_cache
    coeffs = d @ small @ d.T
    block = coeffs[:16, :16]
    med = np.median(block)
    bits = (block > med).astype(np.uint8).reshape(-1)
    return bits


def main():
    parser = argparse.ArgumentParser(description="vPDQ frame-hashing sidecar")
    parser.add_argument("--video", required=True)
    parser.add_argument("--fps", type=float, default=1.0)
    args = parser.parse_args()

    if not os.path.exists(args.video):
        fail("no-such-video", detail=args.video, code=4)

    np = load_numpy()
    frames = decode_frames(np, args.video, args.fps)

    pdq = load_pdq()
    dct_cache = None
    if pdq is None:
        sys.stderr.write(
            "vpdq.py: pdqhash unavailable — using numpy DCT fallback (NOT true PDQ)\n"
        )
        dct_cache = _dct_matrix(np, FALLBACK)

    out = []
    for i in range(frames.shape[0]):
        frame = frames[i]
        if pdq is not None:
            # pdqhash.compute expects an RGB uint8 array; returns (bits, quality).
            bits, _quality = pdq.compute(frame)
        else:
            bits = fallback_hash(np, frame, dct_cache)
        out.append({"tSeconds": i / args.fps, "hash": bits_to_hex(np, bits)})

    sys.stdout.write(json.dumps({"frames": out}))
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        fail("unexpected", detail=str(exc), code=1)
