//! Optional Meta idb CLI adapter. No companion is installed, started, or exposed.
use super::*;
use std::io::Write;

#[derive(Subcommand, Debug)]
pub enum IosAction {
    Probe,
    Stream,
    Tap {
        #[arg(long)]
        x: u32,
        #[arg(long)]
        y: u32,
        #[arg(long)]
        width: u32,
        #[arg(long)]
        height: u32,
    },
    Swipe {
        #[arg(long)]
        x: u32,
        #[arg(long)]
        y: u32,
        #[arg(long)]
        to_x: u32,
        #[arg(long)]
        to_y: u32,
        #[arg(long)]
        width: u32,
        #[arg(long)]
        height: u32,
        #[arg(long)]
        duration_ms: u16,
    },
    Button {
        #[arg(long)]
        key: String,
    },
}

fn socket_path(path: &str) -> Result<()> {
    if path.len() > 1024
        || !path.starts_with('/')
        || path.contains(':')
        || path.chars().any(char::is_control)
    {
        return Err(Error::InvalidArgument);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        use std::path::{Component, Path};
        let owner = unsafe { libc::geteuid() };
        let path = Path::new(path);
        if path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err(Error::Device("UnsafeCompanionSocket"));
        }
        let parent = path
            .parent()
            .ok_or(Error::Device("UnsafeCompanionSocket"))?;
        // A private final directory binds the socket name to this host account.
        // Shared root-owned sticky directories (e.g. /private/tmp) are safe only
        // as ancestors: their sticky bit protects the next owned directory entry.
        for ancestor in parent.ancestors() {
            let directory = std::fs::symlink_metadata(ancestor)?;
            let root_sticky = directory.uid() == 0 && directory.mode() & 0o1000 != 0;
            if !directory.is_dir()
                || ![0, owner].contains(&directory.uid())
                || (directory.mode() & 0o022 != 0 && !root_sticky)
                || (ancestor == parent
                    && (directory.uid() != owner || directory.mode() & 0o077 != 0))
            {
                return Err(Error::Device("UnsafeCompanionSocket"));
            }
        }
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.file_type().is_socket()
            || metadata.uid() != owner
            || metadata.mode() & 0o077 != 0
        {
            return Err(Error::Device("UnsafeCompanionSocket"));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(Error::Device("DeviceActionUnsupported"))
    }
}
fn command_args(socket: &str, action: &[&str]) -> Vec<String> {
    let mut output = args(&["--companion", socket, "--no-prune-dead-companion"]);
    output.extend(args(action));
    output
}
fn dimensions(value: &Value, id: &str) -> Result<(u32, u32)> {
    if value.get("udid").and_then(Value::as_str) != Some(id)
        || !matches!(
            value.get("target_type").and_then(Value::as_str),
            Some("SIMULATOR" | "simulator")
        )
        || !matches!(
            value.get("state").and_then(Value::as_str),
            Some("Booted" | "booted")
        )
    {
        return Err(Error::Device("CompanionIdentityMismatch"));
    }
    let screen = &value["screen_dimensions"];
    let dimension = |key| {
        screen[key]
            .as_u64()
            .filter(|v| (1..=8192).contains(v))
            .map(|v| v as u32)
            .ok_or(Error::Device("CompanionPointDimensionsUnavailable"))
    };
    Ok((dimension("width_points")?, dimension("height_points")?))
}
fn probe(runner: &mut impl Runner, id: &str, socket: &str) -> Result<(u32, u32)> {
    if !valid_id(Platform::Ios, id) {
        return Err(Error::InvalidArgument);
    }
    socket_path(socket)?;
    if !cfg!(target_os = "macos") && !cfg!(test) {
        return Err(Error::Device("DeviceActionUnsupported"));
    }
    let data = runner.output(
        Tool::Idb,
        &command_args(socket, &["describe", "--json"]),
        MAX_SDK_TEXT,
    )?;
    dimensions(
        &serde_json::from_slice(&data).map_err(|_| Error::Device("InvalidDeviceList"))?,
        id,
    )
}
pub(super) fn execute(
    runner: &mut impl Runner,
    id: &str,
    socket: &str,
    action: IosAction,
) -> Result<Value> {
    let (width, height) = probe(runner, id, socket)?;
    let point = |x: u32, y: u32, w: u32, h: u32| {
        if w == width && h == height && x < width && y < height {
            Ok(())
        } else {
            Err(Error::Device("DeviceDimensionsChanged"))
        }
    };
    let arguments = match action {
        IosAction::Probe => {
            return Ok(
                json!({"schemaVersion":1,"id":id,"platform":"ios","width":width,"height":height,"stream":true,"tap":true,"swipe":true,"buttons":["home","power","volume-up","volume-down"]}),
            )
        }
        IosAction::Stream => return Err(Error::InvalidArgument),
        IosAction::Tap {
            x,
            y,
            width: w,
            height: h,
        } => {
            point(x, y, w, h)?;
            vec!["tap".into(), x.to_string(), y.to_string()]
        }
        IosAction::Swipe {
            x,
            y,
            to_x,
            to_y,
            width: w,
            height: h,
            duration_ms,
        } => {
            point(x, y, w, h)?;
            point(to_x, to_y, w, h)?;
            if !(1..=10000).contains(&duration_ms) {
                return Err(Error::InvalidArgument);
            }
            vec![
                "swipe".into(),
                x.to_string(),
                y.to_string(),
                to_x.to_string(),
                to_y.to_string(),
                "--duration".into(),
                format!("{}.{:03}", duration_ms / 1000, duration_ms % 1000),
            ]
        }
        IosAction::Button { key } => vec![
            "button".into(),
            match key.as_str() {
                "home" => "HOME",
                "power" => "LOCK",
                "volume-up" => "VOLUME_UP",
                "volume-down" => "VOLUME_DOWN",
                _ => return Err(Error::InvalidArgument),
            }
            .into(),
        ],
    };
    let mut command = command_args(socket, &[]);
    command.extend(arguments);
    runner.output(Tool::Idb, &command, MAX_SDK_TEXT)?;
    Ok(json!({"schemaVersion":1,"id":id,"status":"requested"}))
}

fn read_header(reader: &mut impl Read) -> Result<()> {
    let mut header = [0; 24];
    reader.read_exact(&mut header)?;
    if header[0] != 1 || header[1] != 24 || header[22] != 0 || header[23] != 0 {
        return Err(Error::Device("InvalidDeviceStream"));
    }
    for offset in [6, 10, 14, 18] {
        let value = u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap());
        if !(1..=8192).contains(&value) {
            return Err(Error::Device("InvalidDeviceStream"));
        }
    }
    Ok(())
}
fn next_frame(reader: &mut impl Read, id: &str, width: u32, height: u32) -> Result<Value> {
    let mut size = [0; 4];
    reader.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    if !(4..=MAX_FRAME).contains(&size) {
        return Err(Error::Device("DeviceOutputTooLarge"));
    }
    let mut jpeg = vec![0; size];
    reader.read_exact(&mut jpeg)?;
    jpeg_frame(Platform::Ios, id, jpeg, Some((width, height)))
}
pub(super) fn jpeg_frame(
    platform: Platform,
    id: &str,
    jpeg: Vec<u8>,
    points: Option<(u32, u32)>,
) -> Result<Value> {
    if jpeg.len() > MAX_FRAME {
        return Err(Error::Device("DeviceOutputTooLarge"));
    }
    let mut decoder = image::ImageReader::with_format(Cursor::new(&jpeg), image::ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    decoder.limits(limits);
    let image = decoder
        .decode()
        .map_err(|_| Error::Device("InvalidDeviceImage"))?;
    let (iw, ih) = (image.width(), image.height());
    let (width, height) = points.unwrap_or((iw, ih));
    // Refuse stale portrait/landscape mappings instead of clicking the wrong point.
    if ((iw as f64 / ih as f64) - (width as f64 / height as f64)).abs() > 0.02 {
        return Err(Error::Device("DeviceDimensionsChanged"));
    }
    Ok(
        json!({"schemaVersion":1,"platform":platform,"id":id,"mime":"image/jpeg","base64":base64::engine::general_purpose::STANDARD.encode(jpeg),"width":width,"height":height,"imageWidth":iw,"imageHeight":ih}),
    )
}
fn stream_child(
    mut command: Command,
    mut writer: impl Write + Send + 'static,
    id: String,
    width: u32,
    height: u32,
    cancelled: Arc<AtomicBool>,
    maximum_duration: Duration,
) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(Error::Device("DeviceCancelled"));
    }
    prepare(&mut command);
    command.stdout(Stdio::piped());
    let mut child = OwnedChild(Some(
        command
            .spawn()
            .map_err(|_| Error::Device("SdkUnavailable"))?,
    ));
    let mut reader = child.0.as_mut().unwrap().stdout.take().unwrap();
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| {
            read_header(&mut reader)?;
            loop {
                let value = next_frame(&mut reader, &id, width, height)?;
                serde_json::to_writer(&mut writer, &value)
                    .map_err(|_| Error::Device("DeviceStreamClosed"))?;
                writer.write_all(b"\n")?;
                writer.flush()?;
                if sender.send(Ok(())).is_err() {
                    return Ok(());
                }
            }
        })();
        let _ = sender.send(result);
    });
    let started = Instant::now();
    let mut last_frame = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(Error::Device("DeviceCancelled"));
        }
        if started.elapsed() > maximum_duration || last_frame.elapsed() > SDK_TIMEOUT {
            return Err(Error::Device("DeviceTimeout"));
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(())) => last_frame = Instant::now(),
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Error::Device("DeviceStreamClosed"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}
pub fn stream(id: &str, socket: &str) -> Result<()> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal = cancelled.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))
        .map_err(|_| Error::Device("DeviceCancellationUnavailable"))?;
    let eof = cancelled.clone();
    thread::spawn(move || {
        let mut data = [0; 1];
        while matches!(std::io::stdin().read(&mut data), Ok(1)) {}
        eof.store(true, Ordering::Relaxed);
    });
    let (width, height) = probe(
        &mut SdkRunner {
            cancelled: cancelled.clone(),
        },
        id,
        socket,
    )?;
    let command = SdkRunner::command(
        Tool::Idb,
        &command_args(
            socket,
            &[
                "video-stream",
                "--format",
                "minicap",
                "--fps",
                "8",
                "--compression-quality",
                "0.35",
                "--scale-factor",
                "0.5",
            ],
        ),
    );
    stream_child(
        command,
        std::io::stdout(),
        id.into(),
        width,
        height,
        cancelled,
        Duration::from_secs(15 * 60),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "9C405382-203A-4DC0-A11B-B2FC37EBA881";
    #[test]
    fn companion_identity_and_point_units_are_mandatory() {
        let value = json!({"udid":ID,"target_type":"SIMULATOR","state":"Booted","screen_dimensions":{"width":1170,"height":2532,"width_points":390,"height_points":844}});
        assert_eq!(dimensions(&value, ID).unwrap(), (390, 844));
        assert!(dimensions(&value, "different").is_err());
        let mut missing = value.clone();
        missing["screen_dimensions"]["width_points"] = Value::Null;
        assert!(dimensions(&missing, ID).is_err());
    }
    #[test]
    fn minicap_lengths_reject_partial_and_oversized_frames() {
        let mut header = vec![1, 24];
        header.extend([0; 4]);
        for _ in 0..4 {
            header.extend(10u32.to_le_bytes());
        }
        header.extend([0, 0]);
        assert!(read_header(&mut Cursor::new(&header)).is_ok());
        assert!(read_header(&mut Cursor::new(&header[..23])).is_err());
        assert!(next_frame(&mut Cursor::new(u32::MAX.to_le_bytes()), ID, 10, 10).is_err());
        assert!(next_frame(&mut Cursor::new([10, 0, 0, 0, 0]), ID, 10, 10).is_err());
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&image::RgbImage::new(10, 20))
            .unwrap();
        let mut framed = (jpeg.len() as u32).to_le_bytes().to_vec();
        framed.extend(jpeg);
        assert_eq!(
            next_frame(&mut Cursor::new(&framed), ID, 100, 200).unwrap()["width"],
            100
        );
        assert!(next_frame(&mut Cursor::new(&framed), ID, 200, 100).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn socket_must_be_owned_private_and_not_a_symlink_or_tcp_address() {
        use std::os::unix::{
            fs::{symlink, PermissionsExt},
            net::UnixListener,
        };
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("idb.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(socket_path(path.to_str().unwrap()).is_ok());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(socket_path(path.to_str().unwrap()).is_err());
        let link = directory.path().join("link");
        symlink(&path, &link).unwrap();
        assert!(socket_path(link.to_str().unwrap()).is_err());
        assert!(socket_path("localhost:1234").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn socket_rejects_mutable_or_symlinked_ancestors_and_requires_a_private_parent() {
        use std::os::unix::{
            fs::{symlink, PermissionsExt},
            net::UnixListener,
        };
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket = private.join("idb.sock");
        let _listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(socket_path(socket.to_str().unwrap()).is_ok());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(socket_path(socket.to_str().unwrap()).is_err());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(socket_path(socket.to_str().unwrap()).is_err());
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        let alias = root.path().join("alias");
        symlink(&private, &alias).unwrap();
        assert!(socket_path(alias.join("idb.sock").to_str().unwrap()).is_err());
        assert!(socket_path(private.join("../private/idb.sock").to_str().unwrap()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn stream_cancellation_reaps_source_even_when_output_is_backpressured() {
        struct BlockedOutput {
            entered: mpsc::Sender<()>,
            resume: mpsc::Receiver<()>,
            finished: mpsc::Sender<()>,
        }
        impl Write for BlockedOutput {
            fn write(&mut self, _data: &[u8]) -> std::io::Result<usize> {
                self.entered.send(()).unwrap();
                self.resume.recv().unwrap();
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "fixture stopped",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl Drop for BlockedOutput {
            fn drop(&mut self) {
                let _ = self.finished.send(());
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stream.minicap");
        let mut bytes = vec![1, 24];
        bytes.extend([0; 4]);
        for _ in 0..4 {
            bytes.extend(10u32.to_le_bytes());
        }
        bytes.extend([0, 0]);
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&image::RgbImage::new(10, 10))
            .unwrap();
        bytes.extend((jpeg.len() as u32).to_le_bytes());
        bytes.extend(jpeg);
        std::fs::write(&path, bytes).unwrap();
        // A native fixture file and OS byte-copy child; no shell or test runner script.
        let mut command = Command::new("cat");
        command.arg(&path);
        let (entered, waiting) = mpsc::channel();
        let (resume, blocked) = mpsc::channel();
        let (finished, closed) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let request = cancel.clone();
        let worker = thread::spawn(move || {
            stream_child(
                command,
                BlockedOutput {
                    entered,
                    resume: blocked,
                    finished,
                },
                ID.into(),
                10,
                10,
                request,
                Duration::from_secs(60),
            )
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        cancel.store(true, Ordering::Relaxed);
        assert!(matches!(
            worker.join().unwrap(),
            Err(Error::Device("DeviceCancelled"))
        ));
        resume.send(()).unwrap();
        closed.recv_timeout(Duration::from_secs(2)).unwrap();
    }
}
