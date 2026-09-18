"""Score Suno takes from a screenshot of the Crop-dialog waveform.

How to get the image: song menu -> Edit -> Crop, screenshot just the waveform
box (white bars on dark grey, pink frame). One image per take.

Usage: python3 score-takes-from-waveform.py '<template>' img1 [img2 ...]
  template = comma list of expected relative loudness per section (0..1),
             one number per section tag in the lyrics box, e.g.
             '0.5,0.2,0.5,0.55,0.65,0.6,0.2' for a 7-section sheet.

For each image it reports:
  shape    - Pearson correlation of per-section mean level vs the template
  intro    - first 8% level relative to the track median
  tail     - last 4% level relative to median (low = real ending,
             ~1 or more = still at full level, i.e. cut off at the limit)
  false    - false endings: a dip below 40% of median in the last 40% of the
             track that recovers above 75% within the next 12% (positions as
             fractions of the track). Dips in the last ~10% can be the written
             final hit; check the profile before rejecting.
  profile  - 20-bin level profile (median = 100)

Used to pick every take on Thema Regium (2026-09-18). It measures shape and
endings only; it can't hear key, timbre or melody.
"""
import sys
import numpy as np
from PIL import Image


def bars(path):
    im = np.asarray(Image.open(path).convert('RGB')).astype(int)
    white = (im[..., 0] > 200) & (im[..., 1] > 200) & (im[..., 2] > 200)
    h, w = white.shape
    inner = white[int(h * 0.12):int(h * 0.9), int(w * 0.012):int(w * 0.988)]
    col = inner.sum(0).astype(float)
    k = 3  # bars have gaps; a running max stops gaps reading as silence
    return np.array([col[max(0, i - k):i + k + 1].max() for i in range(len(col))])


def analyse(path, tmpl):
    col = bars(path)
    n = len(col)
    med = np.median(col[col > 0]) if (col > 0).any() else 1.0
    rel = col / med
    prof = [int(100 * rel[int(i * n / 20):int((i + 1) * n / 20)].mean()) for i in range(20)]
    S = len(tmpl)
    sec = np.array([rel[int(i * n / S):int((i + 1) * n / S)].mean() for i in range(S)])
    shape = float(np.corrcoef(sec, tmpl)[0, 1]) if S > 2 else float('nan')
    intro = rel[:max(1, int(n * 0.08))].mean()
    tail = rel[int(n * 0.96):].mean()
    false = []
    i = int(n * 0.6)
    while i < n:
        if rel[i] < 0.40:
            j0 = i
            while i < n and rel[i] < 0.40:
                i += 1
            window = rel[i:min(n, i + int(n * 0.12))]
            if len(window) and window.max() > 0.75:
                false.append(round(j0 / n, 3))
        i += 1
    return dict(shape=round(shape, 2), intro=round(float(intro), 2), tail=round(float(tail), 2),
                false=false, sections=[round(float(x), 2) for x in sec], profile=prof)


if __name__ == '__main__':
    tmpl = np.array([float(x) for x in sys.argv[1].split(',')])
    for p in sys.argv[2:]:
        print(p.replace('\\', '/').split('/')[-1], analyse(p, tmpl))
