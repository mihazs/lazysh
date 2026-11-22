//! Optional Meta idb CLI adapter. No companion is installed, started, or exposed.
use super::*;
use std::io::Write;

#[derive(Subcommand, Debug)]
pub enum IosAction {
    Probe,
    Stream,
    #[command(flatten)]
    Gesture(Gesture),
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
    let arguments = match action {
        IosAction::Probe => {
            return Ok(
                json!({"schemaVersion":1,"id":id,"platform":"ios","width":width,"height":height,"stream":true,"tap":true,"swipe":true,"buttons":["home","power","volume-up","volume-down"]}),
            )
        }
        IosAction::Stream => return Err(Error::InvalidArgument),
        IosAction::Gesture(gesture) => {
            gesture.check(width, height)?;
            match gesture {
                Gesture::Tap { x, y, .. } => {
                    vec!["ui".into(), "tap".into(), x.to_string(), y.to_string()]
                }
                Gesture::Swipe {
                    x,
                    y,
                    to_x,
                    to_y,
                    duration_ms,
                    ..
                } => vec![
                    "ui".into(),
                    "swipe".into(),
                    x.to_string(),
                    y.to_string(),
                    to_x.to_string(),
                    to_y.to_string(),
                    "--duration".into(),
                    format!("{}.{:03}", duration_ms / 1000, duration_ms % 1000),
                ],
            }
        }
        IosAction::Button { key } => vec![
            "ui".into(),
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
                if !super::write_frame(&mut writer, &value, &sender)? {
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
        if super::frame_ready(&receiver)? {
            last_frame = Instant::now();
        }
    }
}
fn video_stream_command(socket: &str) -> Command {
    SdkRunner::command(
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
    )
}
pub fn stream(id: &str, socket: &str) -> Result<()> {
    let cancelled = super::cancellation_signal()?;
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
    stream_child(
        video_stream_command(socket),
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
    // A private socket in an owned 0700 directory, bound through its real path:
    // Darwin temporary roots may use /var -> /private/var, which the adapter
    // deliberately rejects, so the positive fixture must not weaken that check.
    #[cfg(unix)]
    fn private_socket() -> (
        tempfile::TempDir,
        std::os::unix::net::UnixListener,
        std::path::PathBuf,
    ) {
        use std::os::unix::{fs::PermissionsExt, net::UnixListener};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("idb.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        (directory, listener, path)
    }
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
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (_directory, _listener, path) = private_socket();
        let root = path.parent().unwrap();
        assert!(socket_path(path.to_str().unwrap()).is_ok());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(socket_path(path.to_str().unwrap()).is_err());
        let link = root.join("link");
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
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let private = root.join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket = private.join("idb.sock");
        let _listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(socket_path(socket.to_str().unwrap()).is_ok());
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(socket_path(socket.to_str().unwrap()).is_err());
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(socket_path(socket.to_str().unwrap()).is_err());
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        let alias = root.join("alias");
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

    struct Recorder(Vec<Vec<String>>);
    impl Runner for Recorder {
        fn output(&mut self, tool: Tool, args: &[String], _limit: usize) -> Result<Vec<u8>> {
            assert_eq!(tool, Tool::Idb);
            self.0.push(args.to_vec());
            // The companion description idb 1.7.8 returned for an iPhone 16 Pro Simulator.
            Ok(if args.iter().any(|argument| argument == "describe") {
                json!({"udid":ID,"target_type":"simulator","state":"Booted","screen_dimensions":{"width":1206,"height":2622,"density":3.0,"width_points":402,"height_points":874}}).to_string().into_bytes()
            } else {
                Vec::new()
            })
        }
        fn launch(
            &mut self,
            _tool: Tool,
            _args: &[String],
            _: std::time::Duration,
        ) -> Result<bool> {
            unreachable!("idb controls never launch a detached SDK process")
        }
    }
    #[cfg(unix)]
    #[test]
    fn input_runs_idb_ui_subcommands_with_point_arguments() {
        // idb 1.7.8 rejects a top-level `tap`, `swipe` or `button` ("invalid choice"); they live under `ui`.
        let (_directory, _listener, path) = private_socket();
        let socket = path.to_str().unwrap();
        let mut runner = Recorder(Vec::new());
        for action in [
            IosAction::Gesture(Gesture::Tap {
                x: 201,
                y: 406,
                width: 402,
                height: 874,
            }),
            IosAction::Gesture(Gesture::Swipe {
                x: 2,
                y: 437,
                to_x: 300,
                to_y: 437,
                width: 402,
                height: 874,
                duration_ms: 1250,
            }),
            IosAction::Button {
                key: "power".into(),
            },
        ] {
            execute(&mut runner, ID, socket, action).unwrap();
        }
        let controls: Vec<&[String]> = runner
            .0
            .iter()
            .filter(|call| !call.iter().any(|argument| argument == "describe"))
            .map(|call| {
                assert_eq!(
                    call[..3],
                    ["--companion", socket, "--no-prune-dead-companion"]
                );
                &call[3..]
            })
            .collect();
        assert_eq!(
            controls,
            [
                args(&["ui", "tap", "201", "406"]).as_slice(),
                &args(&[
                    "ui",
                    "swipe",
                    "2",
                    "437",
                    "300",
                    "437",
                    "--duration",
                    "1.250"
                ]),
                &args(&["ui", "button", "LOCK"]),
            ]
        );
    }

    fn wait_until(what: &str, limit: Duration, mut condition: impl FnMut() -> bool) {
        let started = Instant::now();
        while !condition() {
            assert!(started.elapsed() < limit, "timed out waiting for {what}");
            thread::sleep(Duration::from_secs(1));
        }
    }
    /// The hosted runner's few CPUs are shared with the Simulator, so any adapter command can pass its
    /// ten-second limit now and then. A repeatable command is retried twice, and every timeout is reported.
    fn patient(what: &str, mut attempt: impl FnMut() -> Result<Value>) -> Value {
        for round in 1..=3 {
            match attempt() {
                Err(Error::Device("DeviceTimeout")) => {
                    println!("{what} exceeded the adapter's command limit (attempt {round})")
                }
                result => return result.unwrap_or_else(|error| panic!("{what} failed: {error:?}")),
            }
        }
        panic!("{what} exceeded the adapter's command limit three times")
    }
    /// Harness-only commands (preparing the Simulator, reading the screen to observe an effect) get a
    /// generous limit; the controls under test run with the adapter's own ten-second one.
    fn harness(tool: Tool, arguments: &[String]) -> Result<Vec<u8>> {
        bounded_command(
            SdkRunner::command(tool, arguments),
            MAX_SDK_TEXT,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(90),
        )
    }
    /// The accessibility elements of the frontmost app, in points; fails while no app is frontmost.
    fn describe_all(socket: &str) -> Result<Vec<Value>> {
        let data = harness(Tool::Idb, &command_args(socket, &["ui", "describe-all"]))?;
        serde_json::from_slice(&data).map_err(|_| Error::Device("InvalidDeviceList"))
    }
    fn has_label(socket: &str, label: &str) -> bool {
        describe_all(socket)
            .is_ok_and(|elements| elements.iter().any(|element| element["AXLabel"] == label))
    }
    /// Frames the production stream wrote as one JSON line each.
    struct FrameSink {
        pending: Vec<u8>,
        frames: mpsc::Sender<Value>,
    }
    impl Write for FrameSink {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.pending.extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=end).collect();
                let _ = self.frames.send(serde_json::from_slice(&line).unwrap());
            }
            Ok(())
        }
    }
    /// Real-host gate for issue #1731: macOS with Xcode and idb, an owned booted iOS Simulator and its
    /// idb companion on a private Unix socket. The CI job (`ios-idb-acceptance.yml`) creates both.
    /// Prints dimensions, counts and timings only, never screen contents.
    #[test]
    #[ignore = "requires macOS, an owned booted iOS Simulator and a private idb companion socket"]
    fn owned_simulator_idb_preview_touch_and_lifecycle() {
        let id = std::env::var("LAZYSH_TEST_IOS_UDID")
            .expect("explicitly select an owned Simulator with LAZYSH_TEST_IOS_UDID");
        let socket = std::env::var("LAZYSH_TEST_IDB_SOCKET")
            .expect("select its private companion socket with LAZYSH_TEST_IDB_SOCKET");
        let mut runner = SdkRunner {
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        // CoreSimulatorService also answers discovery late while a Simulator shuts down: a timeout is "not yet".
        let state = |runner: &mut SdkRunner| {
            let inventory = match super::super::execute(
                runner,
                DeviceCommand::List {
                    platform: Platform::Ios,
                },
            ) {
                Ok(inventory) => inventory,
                Err(Error::Device("DeviceTimeout")) => return None,
                Err(error) => panic!("real simctl discovery failed: {error:?}"),
            };
            // Discovery that stays slow after its retry answers with an empty list and this warning (#1911).
            if inventory["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| {
                    warning
                        .as_str()
                        .is_some_and(|w| w.starts_with("iOS Simulator discovery is slow"))
                })
            {
                return None;
            }
            let device = inventory["devices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|device| device["id"].as_str() == Some(&id))
                .expect("the selected Simulator must be present in simctl discovery")
                .clone();
            assert_eq!(device["kind"], "simulator");
            device["state"].as_str().map(str::to_owned)
        };
        // simctl shutdown took 23 to 66 s on the hosted runner with the companion attached, beyond
        // the adapter's 10 s command limit (#1911). A DeviceTimeout answer is therefore reported,
        // not failed, and the state that discovery then confirms is what the case asserts.
        let lifecycle = |runner: &mut SdkRunner, command: DeviceCommand| {
            let started = Instant::now();
            match super::super::execute(runner, command) {
                Ok(result) => {
                    assert_eq!(
                        (&result["status"], &result["id"]),
                        (&json!("requested"), &json!(id))
                    );
                    println!(
                        "lifecycle requested in {:.1}s",
                        started.elapsed().as_secs_f64()
                    );
                }
                Err(Error::Device("DeviceTimeout")) => println!(
                    "lifecycle request exceeded the adapter's command limit after {:.1}s",
                    started.elapsed().as_secs_f64()
                ),
                Err(error) => panic!("lifecycle request failed: {error:?}"),
            }
            started
        };

        // Inventory and companion identity bind the same exact UUID, in screen points.
        wait_until(
            "the Simulator to be listed running",
            Duration::from_secs(60),
            || state(&mut runner).as_deref() == Some("running"),
        );
        let probe = patient("companion verification", || {
            execute(&mut runner, &id, &socket, IosAction::Probe)
        });
        let (width, height) = (
            probe["width"].as_u64().unwrap() as u32,
            probe["height"].as_u64().unwrap() as u32,
        );
        assert!((100..=8192).contains(&width) && (100..=8192).contains(&height));
        // Touch calibration premise: simctl screenshots are pixels, a whole multiple of the points.
        let shot = patient("simctl screenshot", || {
            super::super::execute(
                &mut runner,
                DeviceCommand::Screenshot {
                    platform: Platform::Ios,
                    id: id.clone(),
                },
            )
        });
        let (pixel_width, pixel_height) = (
            shot["width"].as_u64().unwrap() as u32,
            shot["height"].as_u64().unwrap() as u32,
        );
        let scale = pixel_width / width;
        assert!(
            (2..=3).contains(&scale) && pixel_width == width * scale && pixel_height == height * scale,
            "screenshot {pixel_width}x{pixel_height} is not a Retina multiple of {width}x{height} points"
        );

        // A known foreground app with a labelled control at a known point.
        let simctl = |arguments: &[&str]| harness(Tool::Simctl, &args(arguments));
        let _ = simctl(&["terminate", &id, "com.apple.Preferences"]);
        simctl(&["launch", &id, "com.apple.Preferences"]).expect("launch Settings");
        wait_until("the Settings root list", Duration::from_secs(30), || {
            has_label(&socket, "General")
        });

        // A tap at the centre of the "General" button, from its accessibility frame in points, opens General.
        let elements = describe_all(&socket).expect("Settings accessibility tree");
        let frame = elements
            .iter()
            .find(|element| element["AXLabel"] == "General" && element["type"] == "Button")
            .expect("Settings lists a General button")["frame"]
            .clone();
        let (x, y) = (
            (frame["x"].as_f64().unwrap() + frame["width"].as_f64().unwrap() / 2.0) as u32,
            (frame["y"].as_f64().unwrap() + frame["height"].as_f64().unwrap() / 2.0) as u32,
        );
        // A tap is not repeated blindly: only after a timeout that left no effect.
        let mut opened = false;
        for round in 1..=2 {
            let timed_out = match execute(
                &mut runner,
                &id,
                &socket,
                IosAction::Gesture(Gesture::Tap {
                    x,
                    y,
                    width,
                    height,
                }),
            ) {
                Ok(_) => false,
                Err(Error::Device("DeviceTimeout")) => {
                    println!("tap exceeded the adapter's command limit (attempt {round})");
                    true
                }
                Err(error) => panic!("tap failed: {error:?}"),
            };
            let until = Instant::now() + Duration::from_secs(15);
            while !opened && Instant::now() < until {
                opened = has_label(&socket, "About");
                thread::sleep(Duration::from_secs(1));
            }
            if opened || !timed_out {
                break;
            }
        }
        assert!(opened, "General did not open after the tap");
        // An edge swipe back is observed as the Settings root list returning.
        patient("edge swipe", || {
            execute(
                &mut runner,
                &id,
                &socket,
                IosAction::Gesture(Gesture::Swipe {
                    x: 2,
                    y: height / 2,
                    to_x: width * 3 / 4,
                    to_y: height / 2,
                    width,
                    height,
                    duration_ms: 400,
                }),
            )
        });
        wait_until(
            "the edge swipe to return to the root list",
            Duration::from_secs(15),
            || !has_label(&socket, "About") && has_label(&socket, "General"),
        );
        patient("Home", || {
            execute(
                &mut runner,
                &id,
                &socket,
                IosAction::Button { key: "home".into() },
            )
        });
        wait_until("Home to leave Settings", Duration::from_secs(15), || {
            describe_all(&socket).map_or(true, |tree| tree[0]["AXLabel"] != "Settings")
        });

        // Continuous preview through the production command, frames in screen points. A change
        // of foreground app, made through simctl so no idb client competes for the runner's CPUs, must show.
        let cancelled = Arc::new(AtomicBool::new(false));
        let (frames, received) = mpsc::channel();
        let stream = {
            let (id, socket, cancelled) = (id.clone(), socket.clone(), cancelled.clone());
            thread::spawn(move || {
                stream_child(
                    video_stream_command(&socket),
                    FrameSink {
                        pending: Vec::new(),
                        frames,
                    },
                    id,
                    width,
                    height,
                    cancelled,
                    Duration::from_secs(300),
                )
            })
        };
        let started = Instant::now();
        let first = received
            .recv_timeout(Duration::from_secs(30))
            .expect("a first video frame");
        assert_eq!(first["platform"], "ios");
        assert_eq!(first["id"], id);
        assert_eq!(
            (first["width"].as_u64(), first["height"].as_u64()),
            (Some(width.into()), Some(height.into()))
        );
        let (mut count, mut distinct) = (1, std::collections::HashSet::new());
        distinct.insert(first["base64"].as_str().unwrap().to_owned());
        simctl(&["launch", &id, "com.apple.Preferences"]).expect("launch Settings");
        let until = Instant::now() + Duration::from_secs(60);
        while distinct.len() < 2 || count < 3 {
            let left = until
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| {
                    panic!(
                        "{count} frames ({} distinct) in {:.1}s after the foreground app changed",
                        distinct.len(),
                        started.elapsed().as_secs_f64()
                    )
                });
            match received.recv_timeout(left) {
                Ok(frame) => {
                    count += 1;
                    distinct.insert(frame["base64"].as_str().unwrap().to_owned());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => panic!(
                    "the preview ended after {count} frames: {:?}",
                    stream.join().unwrap()
                ),
            }
        }
        println!(
            "idb preview: {count} frames ({} distinct) in {:.1}s, first {}x{} JPEG for {width}x{height} points",
            distinct.len(),
            started.elapsed().as_secs_f64(),
            first["imageWidth"],
            first["imageHeight"]
        );
        cancelled.store(true, Ordering::Relaxed);
        assert!(matches!(
            stream.join().unwrap(),
            Err(Error::Device("DeviceCancelled"))
        ));
        let processes = Command::new("ps")
            .args(["-axo", "command="])
            .output()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&processes.stdout)
                .lines()
                .any(|line| line.contains("video-stream") && line.contains(&socket)),
            "a cancelled preview left its idb child running"
        );

        // The remaining hardware buttons are accepted by idb.
        for key in ["volume-up", "volume-down", "power"] {
            patient(key, || {
                execute(
                    &mut runner,
                    &id,
                    &socket,
                    IosAction::Button { key: key.into() },
                )
            });
        }

        // Lifecycle by exact UUID, confirmed through discovery. Controls fail closed while it is down.
        let requested = lifecycle(
            &mut runner,
            DeviceCommand::Shutdown {
                platform: Platform::Ios,
                id: id.clone(),
            },
        );
        wait_until("shutdown", Duration::from_secs(180), || {
            state(&mut runner).as_deref() == Some("shutdown")
        });
        println!(
            "shutdown confirmed {:.1}s after the request",
            requested.elapsed().as_secs_f64()
        );
        assert!(execute(
            &mut runner,
            &id,
            &socket,
            IosAction::Button { key: "home".into() }
        )
        .is_err());
        let requested = lifecycle(
            &mut runner,
            DeviceCommand::Boot {
                platform: Platform::Ios,
                id: id.clone(),
            },
        );
        wait_until("boot", Duration::from_secs(180), || {
            state(&mut runner).as_deref() == Some("running")
        });
        println!(
            "boot confirmed {:.1}s after the request",
            requested.elapsed().as_secs_f64()
        );
        wait_until(
            "the companion to follow the Simulator",
            Duration::from_secs(60),
            || execute(&mut runner, &id, &socket, IosAction::Probe).is_ok(),
        );
    }
}
