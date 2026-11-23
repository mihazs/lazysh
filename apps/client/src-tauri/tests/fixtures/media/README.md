These tiny generated fixtures contain no third-party media. They were made with FFmpeg's `sine` and `color` sources:

- `isom-audio.m4a`: `-f lavfi -i 'sine=frequency=440:duration=0.1' -c:a aac -brand isom`
- `isom-video.mp4`: `-f lavfi -i 'color=c=black:s=16x16:d=0.1' -c:v mpeg4 -brand isom`
- `mixed-m4a.mp4`: both sources above, `-c:v mpeg4 -c:a aac -brand 'M4A ' -shortest`

The mixed file's audio-looking major brand deliberately does not describe all of its tracks.
