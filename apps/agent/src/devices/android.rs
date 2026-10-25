//! Optional view-only Android capture through SDK screenrecord and an installed FFmpeg.
use super::*;
use std::io::{BufRead, BufReader, Write};

#[derive(Subcommand, Debug)]
pub enum AndroidAction {
    Probe,
    Stream,
}

fn ffmpeg_args() -> Vec<String> {
    args(&[
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-max_alloc",
        "67108864",
        "-protocol_whitelist",
        "pipe",
        "-probesize",
        "32768",
        "-analyzeduration",
        "0",
        "-threads",
        "1",
        "-max_pixels",
        "1638400",
        "-f",
        "h264",
        "-i",
        "pipe:0",
        "-an",
        "-filter_threads",
        "1",
        "-vf",
        "fps=8",
        "-threads",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "6",
        "-f",
        "mpjpeg",
        "-boundary_tag",
        "lazysh-frame",
        "pipe:1",
    ])
}
fn capture_args(id: &str, width: u32, height: u32) -> Vec<String> {
    args(&[
        "-s",
        id,
        "shell",
        "-T",
        "-n",
        "screenrecord",
        "--output-format=h264",
        "--bit-rate",
        "2000000",
        "--time-limit",
        "180",
        "--size",
        &format!("{width}x{height}"),
        "-",
    ])
}
fn bounded_size(width: u32, height: u32) -> (u32, u32) {
    let scale = (1280.0 / f64::from(width.max(height))).min(1.0);
    let bound = |value: u32| (((f64::from(value) * scale) as u32) / 2 * 2).max(2);
    (bound(width), bound(height))
}
fn probe(runner: &mut impl Runner, id: &str) -> Result<(u32, u32)> {
    if !valid_id(Platform::Android, id) {
        return Err(Error::InvalidArgument);
    }
    let features = runner.output(Tool::Adb, &args(&["-s", id, "features"]), MAX_SDK_TEXT)?;
    if !String::from_utf8_lossy(&features)
        .trim()
        .split(',')
        .any(|feature| feature == "shell_v2")
    {
        return Err(Error::Device("AndroidShellV2Unavailable"));
    }
    // AOSP parses these options before --help exits, without starting capture.
    runner.output(
        Tool::Adb,
        &args(&[
            "-s",
            id,
            "shell",
            "-T",
            "-n",
            "screenrecord",
            "--output-format=h264",
            "--size",
            "2x2",
            "--bit-rate",
            "2000000",
            "--time-limit",
            "180",
            "--help",
        ]),
        MAX_SDK_TEXT,
    )?;
    for (help, prefix) in [
        ("decoder=h264", "Decoder h264 "),
        ("encoder=mjpeg", "Encoder mjpeg "),
        ("muxer=mpjpeg", "Muxer mpjpeg "),
        ("filter=fps", "Filter fps"),
    ] {
        let output = runner.output(
            Tool::Ffmpeg,
            &args(&["-hide_banner", "-h", help]),
            MAX_SDK_TEXT,
        )?;
        if !String::from_utf8_lossy(&output).starts_with(prefix) {
            return Err(Error::Device("FfmpegCapabilityUnavailable"));
        }
    }
    let png = runner.output(
        Tool::Adb,
        &args(&["-s", id, "exec-out", "screencap", "-p"]),
        MAX_PNG,
    )?;
    let screenshot = frame(Platform::Android, id, &png)?;
    Ok(bounded_size(
        screenshot["width"].as_u64().unwrap() as u32,
        screenshot["height"].as_u64().unwrap() as u32,
    ))
}
pub(super) fn execute(runner: &mut impl Runner, id: &str, action: AndroidAction) -> Result<Value> {
    if !matches!(action, AndroidAction::Probe) {
        return Err(Error::InvalidArgument);
    }
    let (width, height) = probe(runner, id)?;
    Ok(
        json!({"schemaVersion":1,"platform":"android","id":id,"stream":true,"viewOnly":true,"width":width,"height":height,"maximumSeconds":180}),
    )
}

fn line(reader: &mut impl BufRead) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(Error::Device("DeviceStreamClosed"));
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if bytes.len() + count > 1024 {
            return Err(Error::Device("InvalidDeviceStream"));
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return Ok(bytes);
        }
    }
}
fn next_jpeg(reader: &mut impl BufRead) -> Result<Vec<u8>> {
    if line(reader)? != b"--lazysh-frame\r\n" {
        return Err(Error::Device("InvalidDeviceStream"));
    }
    if line(reader)? != b"Content-type: image/jpeg\r\n" {
        return Err(Error::Device("InvalidDeviceStream"));
    }
    let header = line(reader)?;
    let length = std::str::from_utf8(&header)
        .ok()
        .and_then(|v| v.strip_prefix("Content-length: "))
        .and_then(|v| v.strip_suffix("\r\n"))
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| (4..=MAX_FRAME).contains(v))
        .ok_or(Error::Device("DeviceOutputTooLarge"))?;
    if line(reader)? != b"\r\n" {
        return Err(Error::Device("InvalidDeviceStream"));
    }
    let mut jpeg = vec![0; length];
    reader.read_exact(&mut jpeg)?;
    let mut tail = [0; 2];
    reader.read_exact(&mut tail)?;
    if tail != *b"\r\n" {
        return Err(Error::Device("InvalidDeviceStream"));
    }
    Ok(jpeg)
}
fn pipeline(
    mut capture: Command,
    mut decoder: Command,
    mut writer: impl Write + Send + 'static,
    id: String,
    cancel: Arc<AtomicBool>,
    maximum: Duration,
) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Device("DeviceCancelled"));
    }
    prepare(&mut capture);
    capture.stdout(Stdio::piped());
    let mut source = OwnedChild(Some(
        capture
            .spawn()
            .map_err(|_| Error::Device("SdkUnavailable"))?,
    ));
    let video = source.0.as_mut().unwrap().stdout.take().unwrap();
    prepare(&mut decoder);
    decoder.stdin(video).stdout(Stdio::piped());
    let mut child = OwnedChild(Some(
        decoder
            .spawn()
            .map_err(|_| Error::Device("FfmpegCapabilityUnavailable"))?,
    ));
    let mut reader = BufReader::new(child.0.as_mut().unwrap().stdout.take().unwrap());
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| loop {
            let jpeg = next_jpeg(&mut reader)?;
            let frame = idb::jpeg_frame(Platform::Android, &id, jpeg, None)?;
            serde_json::to_writer(&mut writer, &frame)
                .map_err(|_| Error::Device("DeviceStreamClosed"))?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            if sender.send(Ok(())).is_err() {
                return Ok(());
            }
        })();
        let _ = sender.send(result);
    });
    let start = Instant::now();
    let mut first_frame = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Device("DeviceCancelled"));
        }
        if capture_expired(start.elapsed(), first_frame, maximum) {
            return Err(Error::Device("DeviceTimeout"));
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(())) => first_frame = true,
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Error::Device("DeviceStreamClosed"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}
fn capture_expired(elapsed: Duration, first_frame: bool, maximum: Duration) -> bool {
    elapsed >= maximum || (!first_frame && elapsed >= SDK_TIMEOUT)
}
pub fn stream(id: &str) -> Result<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))
        .map_err(|_| Error::Device("DeviceCancellationUnavailable"))?;
    let eof = cancel.clone();
    thread::spawn(move || {
        let mut byte = [0; 1];
        while matches!(std::io::stdin().read(&mut byte), Ok(1)) {}
        eof.store(true, Ordering::Relaxed);
    });
    let (width, height) = probe(
        &mut SdkRunner {
            cancelled: cancel.clone(),
        },
        id,
    )?;
    pipeline(
        SdkRunner::command(Tool::Adb, &capture_args(id, width, height)),
        SdkRunner::command(Tool::Ffmpeg, &ffmpeg_args()),
        std::io::stdout(),
        id.into(),
        cancel,
        Duration::from_secs(180),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_device_protocol_or_decoder_never_claims_video_support() {
        struct Fake {
            calls: usize,
            features: bool,
            codec: bool,
        }
        impl Runner for Fake {
            fn output(&mut self, tool: Tool, args: &[String], _: usize) -> Result<Vec<u8>> {
                self.calls += 1;
                if tool == Tool::Adb && args.last().is_some_and(|value| value == "features") {
                    return Ok(if self.features {
                        b"shell_v2,cmd".to_vec()
                    } else {
                        b"cmd".to_vec()
                    });
                }
                if tool == Tool::Ffmpeg {
                    return Ok(if self.codec {
                        b"Decoder h264 ".to_vec()
                    } else {
                        b"Unknown decoder".to_vec()
                    });
                }
                Ok(Vec::new())
            }
            fn launch(&mut self, _: Tool, _: &[String]) -> Result<()> {
                panic!("probe cannot launch a daemon");
            }
        }
        let mut missing = Fake {
            calls: 0,
            features: false,
            codec: false,
        };
        assert!(probe(&mut missing, "emulator-5554").is_err());
        assert_eq!(missing.calls, 1);
        let mut missing = Fake {
            calls: 0,
            features: true,
            codec: false,
        };
        assert!(probe(&mut missing, "emulator-5554").is_err());
        assert_eq!(missing.calls, 3);
        let mut hostile = Fake {
            calls: 0,
            features: true,
            codec: true,
        };
        assert!(probe(&mut hostile, "-unexpected").is_err());
        assert_eq!(hostile.calls, 0);
    }
    #[test]
    fn multipart_framing_bounds_lengths_and_rejects_ambiguous_headers() {
        let valid =
            b"--lazysh-frame\r\nContent-type: image/jpeg\r\nContent-length: 4\r\n\r\n1234\r\n";
        assert_eq!(next_jpeg(&mut Cursor::new(valid)).unwrap(), b"1234");
        for bytes in [
            valid[..valid.len() - 1].to_vec(),
            b"--other\r\n".to_vec(),
            b"--lazysh-frame\r\nContent-type: image/jpeg\r\nContent-length: 99999999\r\n".to_vec(),
            vec![b'x'; 1025],
        ] {
            assert!(next_jpeg(&mut Cursor::new(bytes)).is_err());
        }
        assert_eq!(bounded_size(1080, 1920), (720, 1280));
        assert_eq!(bounded_size(1920, 1080), (1280, 720));
    }
    #[test]
    fn fixed_capture_and_decoder_arguments_preserve_serial_and_resource_limits() {
        let capture = capture_args("emulator-5554", 720, 1280);
        assert_eq!(
            &capture[..7],
            args(&[
                "-s",
                "emulator-5554",
                "shell",
                "-T",
                "-n",
                "screenrecord",
                "--output-format=h264"
            ])
        );
        assert!(capture.ends_with(&args(&["--size", "720x1280", "-"])));
        assert!(ffmpeg_args()
            .windows(2)
            .any(|p| p == ["-protocol_whitelist", "pipe"]));
        assert!(ffmpeg_args()
            .windows(2)
            .any(|p| p == ["-max_pixels", "1638400"]));
    }
    #[test]
    fn cancelled_video_does_not_dispatch_either_process() {
        assert!(matches!(
            pipeline(
                Command::new("missing-capture-must-not-run"),
                Command::new("missing-decoder-must-not-run"),
                Vec::new(),
                "fixture".into(),
                Arc::new(AtomicBool::new(true)),
                Duration::from_secs(1)
            ),
            Err(Error::Device("DeviceCancelled"))
        ));
    }
    #[test]
    fn idle_after_first_frame_keeps_capture_until_total_deadline() {
        let maximum = Duration::from_secs(180);
        assert!(capture_expired(Duration::from_secs(10), false, maximum));
        assert!(!capture_expired(Duration::from_secs(11), true, maximum));
        assert!(!capture_expired(Duration::from_secs(179), true, maximum));
        assert!(capture_expired(Duration::from_secs(180), true, maximum));
    }
    #[test]
    #[ignore = "requires an installed FFmpeg with H264 encoder/decoder and MJPEG muxer"]
    fn real_ffmpeg_h264_to_bounded_jpeg() {
        let mut source = Command::new("ffmpeg");
        source.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x96:r=8",
            "-frames:v",
            "8",
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-f",
            "h264",
            "pipe:1",
        ]);
        struct FrameWritten(Arc<AtomicBool>);
        impl Write for FrameWritten {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                if data.contains(&b'\n') {
                    self.0.store(true, Ordering::Relaxed);
                }
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let result = pipeline(
            source,
            SdkRunner::command(Tool::Ffmpeg, &ffmpeg_args()),
            FrameWritten(cancel.clone()),
            "fixture".into(),
            cancel.clone(),
            Duration::from_secs(10),
        );
        assert!(
            cancel.load(Ordering::Relaxed),
            "actual codec pipeline must deliver a validated JPEG: {result:?}"
        );
        assert!(matches!(result, Err(Error::Device("DeviceCancelled"))));
        let mut invalid = Command::new("ffmpeg");
        invalid.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "h264",
            "-i",
            "pipe:0",
            "-f",
            "h264",
            "pipe:1",
        ]);
        assert!(pipeline(
            invalid,
            SdkRunner::command(Tool::Ffmpeg, &ffmpeg_args()),
            Vec::new(),
            "fixture".into(),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2)
        )
        .is_err());
    }
}
