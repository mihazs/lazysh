#!/bin/sh
# Usage: speech-fixtures.sh <directory> <fixture>...
# Download the named public speech fixtures into <directory> and check each against its pinned size and
# SHA-256, so a publisher that replaces a file fails the job and names the pin to update. A file that
# already matches its pin is kept. native-linux-runtimes and the owned Android voice run share these pins.
# Whisper weights: Hugging Face LFS digests at the pinned revision. Parakeet digest and size:
# packages/parakeet-runtime/src/bundle.rs.
set -eu
directory=$1
shift
whisper=https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1
pin() {
  case "$1" in
    ggml-tiny.en.bin) url=$whisper/ggml-tiny.en.bin sha=921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f size=77704715 ;;
    ggml-tiny.bin) url=$whisper/ggml-tiny.bin sha=be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21 size=77691713 ;;
    jfk.wav) url=https://raw.githubusercontent.com/ggml-org/whisper.cpp/b0a11594aec50892a02cd8d129eee2dfe93a8bb8/samples/jfk.wav sha=59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e size=352078 ;;
    parakeet-v3-int8.tar.bz2) url=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 sha=1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9 size=487211443 ;;
    *) echo "::error::Unknown speech fixture $1"; exit 2 ;;
  esac
}
mkdir -p "$directory"
for name; do
  pin "$name"
  target=$directory/$name
  if ! printf '%s  %s\n' "$sha" "$target" | sha256sum --check --strict --status 2>/dev/null; then
    rm -f "$target"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 900 --max-filesize "$size" "$url" -o "$target" || {
      code=$?
      # curl 63: the publisher serves more bytes than the pin.
      [ "$code" != 63 ] || echo "::error::$name: $url is larger than its pinned $size bytes; the publisher replaced it, so update the pin"
      exit "$code"
    }
  fi
  if [ "$(stat -c%s "$target")" != "$size" ] || ! printf '%s  %s\n' "$sha" "$target" | sha256sum --check --strict --status; then
    echo "::error::$name: $url no longer matches its pinned $size bytes and SHA-256 $sha; the publisher replaced it, so update the pin"
    exit 1
  fi
done
