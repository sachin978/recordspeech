#!/usr/bin/env python3
"""Generate test audio for Chrome's fake microphone (no real voice data).

speechlike.wav — 30 s of voice-like tone bursts (~2.5 s) separated by ~1 s of silence,
                 so the recorder's pause detection and segmenting are exercised.
silence.wav    — 10 s of near-silence, to test "no speech detected".
"""
import math
import os
import random
import struct
import sys
import wave

RATE = 16000
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")
os.makedirs(OUT, exist_ok=True)


def write(name, samples):
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples))
    print("wrote", path)


random.seed(7)
speech = []
t = 0.0
while t < 30.0:
    burst = 2.0 + random.random()  # voiced burst
    f0 = 120 + random.random() * 80
    n = int(burst * RATE)
    for i in range(n):
        x = i / RATE
        env = min(1.0, x * 20, (burst - x) * 20) * (0.6 + 0.4 * math.sin(2 * math.pi * 4 * x) ** 2)  # syllable-ish envelope
        s = sum(math.sin(2 * math.pi * f0 * k * x) / k for k in range(1, 6))
        speech.append(0.18 * env * s + random.uniform(-0.002, 0.002))
    gap = 0.9 + random.random() * 0.4  # pause
    speech.extend(random.uniform(-0.001, 0.001) for _ in range(int(gap * RATE)))
    t += burst + gap
write("speechlike.wav", speech)
write("silence.wav", [random.uniform(-0.0004, 0.0004) for _ in range(RATE * 10)])
