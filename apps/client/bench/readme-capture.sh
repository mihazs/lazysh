#!/bin/sh
# Captures the README screenshots and GIFs from a running Android guest (Waydroid, see docs/architecture/waydroid-lane.md) and keeps
# them inside a size budget. Runbook: docs/how-to/capture-readme-media.md.
#
# Usage: readme-capture.sh shot <name>                 one screenshot -> <out>/<name>.png
#        readme-capture.sh gif <name> <seconds>        screenrecord for <seconds> while you drive the app -> <out>/<name>.gif
#        readme-capture.sh gif-from <name> <video>     a video you already have -> <out>/<name>.gif
#        readme-capture.sh check                       every file in <out> has a valid name and is inside its budget
# Exit: 0 done, 1 the media cannot be made to fit its budget or a check failed, 2 usage, 3 a tool or the guest is missing.
# Environment: ADB (adb binary), ANDROID_SERIAL (default 192.168.240.112:5555), README_MEDIA_OUT (default docs/assets/readme next to the repo root),
# README_CROP_TOP and README_CROP_BOTTOM (pixels of the guest's status and navigation bars to cut from every capture, default 0),
# README_PNG_MAX_KB (300), README_GIF_MAX_KB (4096), README_MP4_MAX_KB (5120).
set -u

here=$(cd "$(dirname "$0")" && pwd)
adb=${ADB:-adb}
serial=${ANDROID_SERIAL:-192.168.240.112:5555}
out=${README_MEDIA_OUT:-$here/../../../docs/assets/readme}
crop_top=${README_CROP_TOP:-0}; crop_bottom=${README_CROP_BOTTOM:-0}
png_max=$((${README_PNG_MAX_KB:-300} * 1024)); gif_max=$((${README_GIF_MAX_KB:-4096} * 1024)); mp4_max=$((${README_MP4_MAX_KB:-5120} * 1024))
work=''

say() { echo "readme-capture: $*" >&2; }
die() { code=$1; shift; say "$*"; exit "$code"; }
trap '[ -z "$work" ] || rm -rf "$work"' EXIT
trap 'exit 130' INT TERM HUP
bytes() { wc -c < "$1" | tr -d ' '; }
valid_name() { case $1 in '' | -* | *-  | *[!a-z0-9-]* | *--*) return 1 ;; esac; }
need() { command -v "$1" >/dev/null 2>&1 || die 3 "$1 is not installed"; }

# Screenshots: the first (width, colours) step of the ladder that fits wins, so a simple screen keeps its full resolution.
fit_png() { # fit_png <raw.png> <dest.png>
  for step in 1080:256 1080:128 810:128 720:96 540:64; do
    magick "$1" -crop "+0+0" +repage -gravity North -chop "0x$crop_top" -gravity South -chop "0x$crop_bottom" +repage \
      -resize "${step%:*}x>" -strip -dither None -colors "${step#*:}" -define png:compression-level=9 "PNG8:$work/try.png" || die 3 'magick failed'
    if [ "$(bytes "$work/try.png")" -le "$png_max" ]; then mv "$work/try.png" "$2"; say "$2: $(bytes "$2") bytes ($step)"; return 0; fi
  done
  die 1 "$2 does not fit ${png_max} bytes even at 540 px and 64 colours; capture a simpler screen"
}

# GIFs: fewer frames per second, a narrower frame and fewer colours until the file fits.
fit_gif() { # fit_gif <video> <dest.gif>
  for step in 12:360:128 10:320:96 8:288:64 6:240:48; do
    fps=${step%%:*}; rest=${step#*:}; width=${rest%%:*}; colors=${rest#*:}
    ffmpeg -v error -y -i "$1" -vf "fps=$fps,crop=iw:ih-$crop_top-$crop_bottom:0:$crop_top,scale=$width:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=$colors:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
      -loop 0 "$work/try.gif" || die 3 'ffmpeg failed'
    if [ "$(bytes "$work/try.gif")" -le "$gif_max" ]; then mv "$work/try.gif" "$2"; say "$2: $(bytes "$2") bytes ($fps fps, $width px, $colors colours)"; return 0; fi
  done
  die 1 "$2 does not fit ${gif_max} bytes at 6 fps and 240 px; record fewer seconds"
}

guest() {
  command -v "$adb" >/dev/null 2>&1 || die 3 "adb is not installed ($adb not found)"
  "$adb" -s "$serial" get-state </dev/null 2>/dev/null | grep -q device || die 3 "the guest $serial is not connected (adb connect $serial; waydroid status)"
}

cmd=${1:-}; [ $# -eq 0 ] || shift
case $cmd in
  shot | gif | gif-from)
    [ $# -ge 1 ] || die 2 "usage: readme-capture.sh $cmd <name>..."
    valid_name "$1" || die 2 "bad name: $1 (lowercase words joined by single hyphens)"
    name=$1
    need magick; need ffmpeg
    mkdir -p "$out" || die 2 "cannot create $out"
    work=$(mktemp -d) || die 3 'cannot create a work directory'
    case $cmd in
      shot)
        guest
        "$adb" -s "$serial" exec-out 'screencap -p 2>/dev/null' </dev/null > "$work/raw.png" || die 3 'screencap failed'
        fit_png "$work/raw.png" "$out/$name.png" ;;
      gif)
        [ $# -eq 2 ] || die 2 'usage: readme-capture.sh gif <name> <seconds>'
        case $2 in '' | *[!0-9]* | 0) die 2 "bad seconds: $2" ;; esac
        [ "$2" -le 180 ] || die 2 'screenrecord stops after 180 seconds'
        guest
        remote=/sdcard/readme-capture.mp4
        "$adb" -s "$serial" shell screenrecord --time-limit "$2" "$remote" </dev/null >&2 || die 3 'screenrecord failed in the guest'
        "$adb" -s "$serial" pull "$remote" "$work/raw.mp4" </dev/null >/dev/null || die 3 'could not pull the recording'
        "$adb" -s "$serial" shell rm -f "$remote" </dev/null >/dev/null 2>&1
        fit_gif "$work/raw.mp4" "$out/$name.gif" ;;
      gif-from)
        [ $# -eq 2 ] && [ -f "$2" ] || die 2 'usage: readme-capture.sh gif-from <name> <video file>'
        fit_gif "$2" "$out/$name.gif" ;;
    esac ;;
  check)
    [ -d "$out" ] || die 1 "$out does not exist"
    bad=0
    for file in "$out"/*; do
      [ -f "$file" ] || continue
      base=$(basename "$file"); ext=${base##*.}; stem=${base%.*}
      case $ext in png) max=$png_max ;; gif) max=$gif_max ;; mp4) max=$mp4_max ;; *) say "$base: only .png, .gif and .mp4 belong here"; bad=1; continue ;; esac
      valid_name "$stem" || { say "$base: bad name"; bad=1; }
      [ "$(bytes "$file")" -le "$max" ] || { say "$base: $(bytes "$file") bytes is over the $max byte budget"; bad=1; }
    done
    [ "$bad" -eq 0 ] || exit 1
    say 'every file is inside its budget' ;;
  *) die 2 'usage: readme-capture.sh shot <name> | gif <name> <seconds> | gif-from <name> <video> | check' ;;
esac
