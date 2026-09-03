#!/usr/bin/env python
"""
melody-match.py — how closely does a Suno take follow its reference slice?

    python tools/melody-match.py --ref refs/05-the-long-line-ref.mp3 --take faded/05.src.mp3

Chroma-CQT of both files, DTW-aligned (so tempo drift and rubato are
forgiven), mean cosine similarity along the alignment path -> 0..1.
Spec §8: track 01's accepted take sets the bar; later tracks must land
within 0.05 of it. Tempo-robust, timbre-blind, key-sensitive on purpose.
"""
import argparse
import numpy as np
import librosa

SR, HOP = 22050, 2048


def chroma(path):
    y, sr = librosa.load(str(path), sr=SR, mono=True)
    c = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    # norm=2 (L2) so each column is a unit vector and the dot product below is
    # an actual cosine similarity. librosa.util.normalize's default is norm=inf
    # (max-norm): each column's peak bin becomes 1 but the column is not scaled
    # to unit L2 length, so a broadband/noisy column (many bins near their own
    # max) dot-products to >0.9 against almost anything. The noise-discrimination
    # test failed hard on this (scores ~0.90-1.03, not the "0.6-0.7" the brief
    # anticipated) until norm=2 was made explicit.
    return librosa.util.normalize(c, norm=2, axis=0)


def score(ref_path, take_path):
    a, b = chroma(ref_path), chroma(take_path)
    _, wp = librosa.sequence.dtw(X=a, Y=b, metric='cosine')
    sims = [float(np.dot(a[:, i], b[:, j])) for i, j in wp]
    return float(np.mean(sims))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True)
    ap.add_argument('--take', required=True)
    args = ap.parse_args()
    print(f'score={score(args.ref, args.take):.3f}')
