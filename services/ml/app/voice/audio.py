"""Audio normalization and VAD segmentation (spec §6.1 steps 1–2).

Everything works on 16 kHz mono 16-bit PCM WAV. Inputs already in that format skip
ffmpeg, so tests and WAV uploads work on machines without ffmpeg installed.
"""
from __future__ import annotations

import array
import io
import os
import shutil
import subprocess
import tempfile
import wave
from dataclasses import dataclass

SAMPLE_RATE = 16000
FRAME_MS = 30
MAX_SEGMENT_MS = 25_000
MIN_SEGMENT_MS = 1_000
MERGE_GAP_MS = 400
PAD_MS = 150


class AudioError(Exception):
    pass


@dataclass
class Segment:
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def _is_normalized_wav(data: bytes) -> bool:
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return False
    try:
        with wave.open(io.BytesIO(data)) as w:
            return w.getframerate() == SAMPLE_RATE and w.getnchannels() == 1 and w.getsampwidth() == 2
    except wave.Error:
        return False


def ffmpeg_path() -> str | None:
    return shutil.which(os.environ.get("FFMPEG_PATH", "ffmpeg"))


def normalize(data: bytes) -> bytes:
    """Any supported audio → 16 kHz mono PCM16 WAV bytes. The original is never modified."""
    if _is_normalized_wav(data):
        return data
    ff = ffmpeg_path()
    if not ff:
        raise AudioError("ffmpeg not found on PATH (set FFMPEG_PATH); needed for non-WAV audio")
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "in"), os.path.join(d, "out.wav")
        with open(src, "wb") as f:
            f.write(data)
        proc = subprocess.run(
            [ff, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", "-f", "wav", dst],
            capture_output=True, timeout=300,
        )
        if proc.returncode != 0:
            raise AudioError(f"ffmpeg failed: {proc.stderr.decode(errors='replace')[:300]}")
        with open(dst, "rb") as f:
            return f.read()


def read_pcm(wav_bytes: bytes) -> array.array:
    with wave.open(io.BytesIO(wav_bytes)) as w:
        frames = w.readframes(w.getnframes())
    pcm = array.array("h")
    pcm.frombytes(frames)
    return pcm


def to_wav(pcm: array.array | list[int]) -> bytes:
    if not isinstance(pcm, array.array):
        pcm = array.array("h", pcm)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def silence_wav(seconds: float) -> bytes:
    return to_wav(array.array("h", bytes(int(seconds * SAMPLE_RATE) * 2)))


def duration_ms(pcm: array.array) -> int:
    return len(pcm) * 1000 // SAMPLE_RATE


def slice_wav(pcm: array.array, seg: Segment) -> bytes:
    a = seg.start_ms * SAMPLE_RATE // 1000
    b = seg.end_ms * SAMPLE_RATE // 1000
    return to_wav(pcm[a:b])


def _frame_energies(pcm: array.array) -> list[float]:
    n = SAMPLE_RATE * FRAME_MS // 1000
    out = []
    for i in range(0, len(pcm), n):
        fr = pcm[i:i + n]
        out.append((sum(s * s for s in fr) / len(fr)) ** 0.5 if fr else 0.0)
    return out


def segment(pcm: array.array) -> list[Segment]:
    """Energy-based VAD → speech segments ≤ 25 s, each bounded by the original's time axis.

    - threshold adapts to the file's noise floor (20th percentile energy) with an absolute floor;
    - gaps shorter than MERGE_GAP_MS are bridged;
    - segments longer than MAX_SEGMENT_MS are split at the quietest frame in the back half of the window;
    - segments shorter than MIN_SEGMENT_MS are merged into a neighbour when that stays ≤ 25 s.
    """
    total = duration_ms(pcm)
    if total == 0:
        return []
    en = _frame_energies(pcm)
    srt = sorted(en)
    floor = srt[int(len(srt) * 0.2)]
    peak = srt[int(len(srt) * 0.98)] if len(srt) > 1 else srt[0]
    # Capped at half the peak so a file that is speech end-to-end (no silence to learn a floor from)
    # is still voiced.
    thr = max(200.0, min(max(floor * 3, floor + (peak - floor) * 0.1), peak * 0.5))
    voiced = [e >= thr for e in en]

    regions: list[list[int]] = []  # frame index ranges [a, b)
    i = 0
    while i < len(voiced):
        if voiced[i]:
            j = i
            while j < len(voiced) and voiced[j]:
                j += 1
            if regions and (i - regions[-1][1]) * FRAME_MS <= MERGE_GAP_MS:
                regions[-1][1] = j
            else:
                regions.append([i, j])
            i = j
        else:
            i += 1

    max_frames = MAX_SEGMENT_MS // FRAME_MS
    split: list[list[int]] = []
    for a, b in regions:
        while b - a > max_frames:
            lo, hi = a + max_frames // 2, a + max_frames
            cut = min(range(lo, hi), key=lambda k: en[k])
            split.append([a, cut])
            a = cut
        split.append([a, b])

    segs = [Segment(max(0, a * FRAME_MS - PAD_MS), min(total, b * FRAME_MS + PAD_MS)) for a, b in split]

    merged: list[Segment] = []
    for s in segs:
        if merged and (s.duration_ms < MIN_SEGMENT_MS or merged[-1].duration_ms < MIN_SEGMENT_MS) \
                and s.end_ms - merged[-1].start_ms <= MAX_SEGMENT_MS:
            merged[-1] = Segment(merged[-1].start_ms, s.end_ms)
        else:
            merged.append(s)
    # Remove overlap introduced by padding.
    for k in range(1, len(merged)):
        if merged[k].start_ms < merged[k - 1].end_ms:
            mid = (merged[k].start_ms + merged[k - 1].end_ms) // 2
            merged[k - 1] = Segment(merged[k - 1].start_ms, mid)
            merged[k] = Segment(mid, merged[k].end_ms)
    return [s for s in merged if s.duration_ms >= 200]
