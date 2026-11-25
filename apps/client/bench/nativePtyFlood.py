"""Owned SSH fixture for W12. Report the exact PTY byte offset after each echo."""

import json
import os
from pathlib import Path
import select
import sys
import time


def run(gate, chunks, count, markers, cadence):
    output = sys.stdout.buffer
    offset = 0
    echoed = bytearray()
    chunk = 0
    for index in range(count):
        ready = gate.with_name(f"{gate.name}-{index}")
        while not ready.exists():
            time.sleep(0.002)

        # Keep feeding the PTY until the next input is available. Emit at least
        # one full chunk before every echo so a key cannot bypass the flood.
        armed = ready.with_suffix(f".armed-{index}")
        if not chunks:
            armed.touch(exist_ok=False)
        else:
            first_chunk = True
            while True:
                data = chunks[chunk]
                chunk = (chunk + 1) % len(chunks)
                output.write(data)
                output.flush()
                offset += len(data)
                if first_chunk:
                    armed.touch(exist_ok=False)
                    first_chunk = False
                if select.select([sys.stdin], [], [], cadence)[0]:
                    break

        key = os.read(sys.stdin.fileno(), 1)
        if not key:
            raise EOFError("The fixture closed before the next key")
        echoed.extend(key)
        # Keep the echoed keys visible. The last one also leaves an independent
        # final-screen oracle that does not depend on how many flood chunks ran.
        frame = b"\x1b[2J\x1b[H" if index + 1 == count else b"\x1b[H\x1b[2K"
        frame += echoed + markers[index]
        output.write(frame)
        output.flush()
        offset += len(frame)

        pending = ready.with_suffix(f".tmp-{index}")
        pending.write_text(f"{offset}\n", encoding="ascii")
        pending.replace(ready.with_suffix(f".echo-{index}"))


if __name__ == "__main__":
    gate = Path(sys.argv[1])
    data = Path(sys.argv[2]).read_bytes()
    count = int(sys.argv[3])
    if not 0 < count <= 200 or (not data and len(sys.argv) <= 4):
        raise ValueError("The workload requires a flood or display markers, and between 1 and 200 keys")
    markers = [b""] * count
    cadence = 0
    if len(sys.argv) > 4:
        markers = [item.encode("ascii") for item in json.loads(Path(sys.argv[4]).read_text())]
        # Keep the target offered rate the same in both display-measurement arms.
        cadence = 0.004
    if len(markers) != count:
        raise ValueError("The workload requires one display marker per key")
    run(gate, [data[index:index + 16384] for index in range(0, len(data), 16384)], count, markers, cadence)
