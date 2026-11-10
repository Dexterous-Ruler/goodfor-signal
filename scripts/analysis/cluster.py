#!/usr/bin/env python3
# BERTopic-style clustering sidecar (UMAP -> HDBSCAN over FIXED embeddings).
# NOTE: on Python 3.14 wheels for umap-learn / hdbscan / numba may not exist yet;
#   run this under Python 3.11-3.12 (see the deps note in the package summary).
#
# Pure compute, JSON on stdio, NO database and NO Gemini calls — DB writes and
# cluster labelling are the orchestrator's job (PHASE-2 §4). random_state=42 is
# pinned so a stochastic UMAP is reproducible across weekly re-fits.
#
# Protocol:
#   stdin  : JSON array [{ "videoId": int, "embedding": [float, ...] }, ...]
#   argv   : --refit | --assign , --model-path PATH
#   stdout : --refit -> { "clusters": [{id, memberVideoIds, representativeVideoIds}],
#                         "assignments": [{videoId, clusterId}] }
#            --assign -> { "assignments": [{videoId, clusterId}] }
#            error    -> { "error": str, "detail"?: str, "pip"?: str }

import sys
import os
import json
import argparse


def fail(error, detail=None, pip=None, code=1):
    """Emit a structured JSON error on stdout and exit — never crash the worker."""
    payload = {"error": error}
    if detail is not None:
        payload["detail"] = str(detail)
    if pip is not None:
        payload["pip"] = pip
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    sys.exit(code)


def load_deps():
    """Import the heavy ML stack lazily so a missing wheel is a clean error."""
    try:
        import numpy as np
        import umap
        import hdbscan
        import joblib
        return np, umap, hdbscan, joblib
    except Exception as exc:  # ImportError, or a numba/llvmlite ABI blow-up
        fail("deps-missing", detail=str(exc), pip="bertopic umap-learn hdbscan", code=3)


def read_items():
    raw = sys.stdin.read()
    if not raw.strip():
        fail("no-input", detail="expected a JSON array of items on stdin", code=2)
    try:
        items = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail("bad-input", detail=str(exc), code=2)
    if not isinstance(items, list) or len(items) == 0:
        fail("no-input", detail="items array is empty", code=2)
    return items


def build_matrix(np, items):
    ids = [int(it["videoId"]) for it in items]
    X = np.asarray([it["embedding"] for it in items], dtype=np.float64)
    return ids, X


def make_reducer(umap):
    # Exact params per PHASE-2 §6.4 / completion.md §6.4.
    return umap.UMAP(
        n_neighbors=15,
        n_components=5,
        min_dist=0.0,
        metric="cosine",
        random_state=42,
    )


def refit(model_path):
    np, umap, hdbscan, joblib = load_deps()
    items = read_items()
    ids, X = build_matrix(np, items)
    n = len(ids)

    # min_cluster_size = 0.5% of corpus (floor 25). The documented default of
    # 150 collapses a 15k-video corpus into 5-8 mega-clusters (§6.4).
    min_cluster_size = max(25, round(0.005 * n))

    reducer = make_reducer(umap)
    reduced = reducer.fit_transform(X)

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        metric="euclidean",
        cluster_selection_method="eom",
        prediction_data=True,
    )
    labels = clusterer.fit_predict(reduced)
    probs = getattr(clusterer, "probabilities_", None)

    # Group member indices by label.
    groups = {}
    for idx, label in enumerate(labels):
        groups.setdefault(int(label), []).append(idx)

    clusters = []
    for label, idxs in groups.items():
        member_ids = [ids[i] for i in idxs]
        if label == -1:
            reps = []  # the outlier bucket is the "novel format" queue, not a topic
        else:
            ranked = sorted(
                idxs,
                key=lambda i: (probs[i] if probs is not None else 0.0),
                reverse=True,
            )
            reps = [ids[i] for i in ranked[:20]]  # 15-20 highest-probability members
        clusters.append(
            {
                "id": int(label),
                "memberVideoIds": member_ids,
                "representativeVideoIds": reps,
            }
        )

    assignments = [{"videoId": ids[i], "clusterId": int(labels[i])} for i in range(n)]

    # Persist the fitted model so daily --assign can approximate_predict against
    # it. This is Python-internal state; it never crosses the JSON boundary.
    try:
        os.makedirs(os.path.dirname(os.path.abspath(model_path)), exist_ok=True)
        joblib.dump({"umap": reducer, "hdbscan": clusterer}, model_path)
    except Exception as exc:
        fail("model-persist-failed", detail=str(exc), code=5)

    sys.stdout.write(json.dumps({"clusters": clusters, "assignments": assignments}))
    sys.stdout.flush()


def assign(model_path):
    np, umap, hdbscan, joblib = load_deps()
    items = read_items()
    ids, X = build_matrix(np, items)

    if not os.path.exists(model_path):
        fail("no-model", detail="run --refit before --assign", code=4)
    try:
        model = joblib.load(model_path)
    except Exception as exc:
        fail("model-load-failed", detail=str(exc), code=4)

    reducer = model["umap"]
    clusterer = model["hdbscan"]

    reduced = reducer.transform(X)
    labels, _strengths = hdbscan.approximate_predict(clusterer, reduced)

    assignments = [
        {"videoId": ids[i], "clusterId": int(labels[i])} for i in range(len(ids))
    ]
    sys.stdout.write(json.dumps({"assignments": assignments}))
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="BERTopic clustering sidecar")
    parser.add_argument("--refit", action="store_true")
    parser.add_argument("--assign", action="store_true")
    parser.add_argument(
        "--model-path",
        default=os.path.join("scripts", "analysis", ".cache", "bertopic-model.pkl"),
    )
    args = parser.parse_args()

    if args.refit and args.assign:
        fail("bad-args", detail="pass exactly one of --refit / --assign", code=2)
    if args.refit:
        refit(args.model_path)
    elif args.assign:
        assign(args.model_path)
    else:
        fail("bad-args", detail="pass --refit or --assign", code=2)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # last-resort guard: never emit a bare traceback
        fail("unexpected", detail=str(exc), code=1)
