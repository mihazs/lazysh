use super::*;
use std::{collections::VecDeque, io::Write};

const PHONE: &str = "emulator-5554";
const UUID: &str = "9C405382-203A-4DC0-A11B-B2FC37EBA881";
pub(super) struct FakeRunner {
    calls: Vec<(Tool, Vec<String>)>,
    outputs: VecDeque<Result<Vec<u8>>>,
    launches: Vec<(Tool, Vec<String>)>,
    ios_png: Option<Vec<u8>>,
}
impl FakeRunner {
    pub(super) fn new(outputs: Vec<Result<Vec<u8>>>) -> Self {
        Self {
            calls: Vec::new(),
            outputs: outputs.into(),
            launches: Vec::new(),
            ios_png: None,
        }
    }
}
impl Runner for FakeRunner {
    fn output(&mut self, tool: Tool, args: &[String], limit: usize) -> Result<Vec<u8>> {
        self.calls.push((tool, args.to_vec()));
        if tool == Tool::Simctl && args.first().is_some_and(|argument| argument == "io") {
            if let Some(png) = &self.ios_png {
                std::fs::write(args.last().unwrap(), png).unwrap();
            }
        }
        let output = self.outputs.pop_front().expect("unexpected SDK command")?;
        if output.len() > limit {
            return Err(Error::Device("DeviceOutputTooLarge"));
        }
        Ok(output)
    }
    fn launch(&mut self, tool: Tool, args: &[String]) -> Result<()> {
        self.launches.push((tool, args.to_vec()));
        Ok(())
    }
}
pub(super) fn png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(width, height, image::Rgb([25, 90, 130]));
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn android_inventory_preserves_exact_ids_authorization_and_safe_capabilities() {
    let mut runner=FakeRunner::new(vec![Ok(b"List of devices attached\nemulator-5554 device product:sdk model:Pixel_8 transport_id:1\nphone1 unauthorized usb:3\n192.0.2.1:5555 offline\n".to_vec()),Ok(b"Pixel_8_API_36\nTablet_API_36\n".to_vec())]);
    let inventory = execute(
        &mut runner,
        DeviceCommand::List {
            platform: Platform::Android,
        },
    )
    .unwrap();
    assert_eq!(inventory["devices"][0]["id"], "emulator-5554");
    assert_eq!(inventory["devices"][0]["name"], "Pixel 8");
    assert_eq!(inventory["devices"][0]["capabilities"]["shutdown"], true);
    assert_eq!(inventory["devices"][1]["state"], "unauthorized");
    assert_eq!(inventory["devices"][1]["capabilities"]["tap"], false);
    assert_eq!(inventory["devices"][2]["state"], "offline");
    assert_eq!(inventory["avds"][1]["id"], "Tablet_API_36");
    assert_eq!(runner.calls[0], (Tool::Adb, args(&["devices", "-l"])));
}

#[test]
fn ios_inventory_filters_other_runtimes_and_discloses_missing_touch_control() {
    let output = json!({"devices":{
        "com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"udid":UUID,"name":"iPhone 17","state":"Booted","isAvailable":true}],
        "com.apple.CoreSimulator.SimRuntime.tvOS-26-0":[{"udid":"not-a-selected-ios-device"}]
    }});
    let mut runner = FakeRunner::new(vec![Ok(output.to_string().into_bytes())]);
    let inventory = execute(
        &mut runner,
        DeviceCommand::List {
            platform: Platform::Ios,
        },
    )
    .unwrap();
    assert_eq!(inventory["devices"].as_array().unwrap().len(), 1);
    assert_eq!(inventory["devices"][0]["state"], "running");
    assert_eq!(inventory["devices"][0]["capabilities"]["screenshot"], true);
    for capability in ["tap", "swipe", "key", "boot"] {
        assert_eq!(inventory["devices"][0]["capabilities"][capability], false);
    }
    assert_eq!(
        runner.calls[0],
        (Tool::Simctl, args(&["list", "devices", "--json"]))
    );
}

#[test]
fn invalid_device_ids_coordinates_and_unsupported_actions_reach_no_sdk() {
    let mut runner = FakeRunner::new(vec![]);
    for id in [
        "",
        "--all",
        "emulator-5554;rm -rf /",
        "device\nnext",
        "$(command)",
    ] {
        assert!(execute(
            &mut runner,
            DeviceCommand::Screenshot {
                platform: Platform::Android,
                id: id.into()
            }
        )
        .is_err());
    }
    assert!(execute(
        &mut runner,
        DeviceCommand::Screenshot {
            platform: Platform::Ios,
            id: "booted".into()
        }
    )
    .is_err());
    assert!(execute(
        &mut runner,
        DeviceCommand::Tap {
            platform: Platform::Android,
            id: "phone1".into(),
            x: 20000,
            y: 0
        }
    )
    .is_err());
    assert!(execute(
        &mut runner,
        DeviceCommand::Swipe {
            platform: Platform::Android,
            id: "phone1".into(),
            x: 0,
            y: 0,
            to_x: 2,
            to_y: 2,
            duration_ms: 0
        }
    )
    .is_err());
    assert!(execute(
        &mut runner,
        DeviceCommand::Tap {
            platform: Platform::Ios,
            id: UUID.into(),
            x: 1,
            y: 1
        }
    )
    .is_err());
    assert!(execute(
        &mut runner,
        DeviceCommand::Shutdown {
            platform: Platform::Android,
            id: "phone1".into()
        }
    )
    .is_err());
    assert!(execute(
        &mut runner,
        DeviceCommand::Boot {
            platform: Platform::Android,
            id: "-wipe-data".into()
        }
    )
    .is_err());
    assert!(runner.calls.is_empty() && runner.launches.is_empty());
}

#[test]
fn touch_swipe_key_and_reboot_target_only_the_selected_android_serial() {
    let mut runner = FakeRunner::new((0..4).map(|_| Ok(Vec::new())).collect());
    execute(
        &mut runner,
        DeviceCommand::Tap {
            platform: Platform::Android,
            id: "emulator-5556".into(),
            x: 108,
            y: 220,
        },
    )
    .unwrap();
    execute(
        &mut runner,
        DeviceCommand::Swipe {
            platform: Platform::Android,
            id: "emulator-5556".into(),
            x: 108,
            y: 220,
            to_x: 300,
            to_y: 420,
            duration_ms: 450,
        },
    )
    .unwrap();
    execute(
        &mut runner,
        DeviceCommand::Key {
            platform: Platform::Android,
            id: "emulator-5556".into(),
            key: DeviceKey::Home,
        },
    )
    .unwrap();
    execute(
        &mut runner,
        DeviceCommand::Reboot {
            platform: Platform::Android,
            id: "emulator-5556".into(),
        },
    )
    .unwrap();
    assert_eq!(
        runner.calls[0],
        (
            Tool::Adb,
            args(&["-s", "emulator-5556", "shell", "input", "tap", "108", "220"])
        )
    );
    assert_eq!(
        runner.calls[1],
        (
            Tool::Adb,
            args(&[
                "-s",
                "emulator-5556",
                "shell",
                "input",
                "swipe",
                "108",
                "220",
                "300",
                "420",
                "450"
            ])
        )
    );
    assert_eq!(
        runner.calls[2],
        (
            Tool::Adb,
            args(&[
                "-s",
                "emulator-5556",
                "shell",
                "input",
                "keyevent",
                "KEYCODE_HOME"
            ])
        )
    );
    assert_eq!(
        runner.calls[3],
        (Tool::Adb, args(&["-s", "emulator-5556", "reboot"]))
    );
}

fn android_gesture(id: &str, action: android::AndroidAction) -> DeviceCommand {
    DeviceCommand::Android {
        id: id.into(),
        action,
    }
}
fn tap_at(id: &str, x: u32, y: u32, width: u32, height: u32) -> DeviceCommand {
    android_gesture(
        id,
        android::AndroidAction::Gesture(Gesture::Tap {
            x,
            y,
            width,
            height,
        }),
    )
}
fn swipe_from(id: &str, [x, y, to_x, to_y]: [u32; 4], width: u32, height: u32) -> DeviceCommand {
    android_gesture(
        id,
        android::AndroidAction::Gesture(Gesture::Swipe {
            x,
            y,
            to_x,
            to_y,
            width,
            height,
            duration_ms: 250,
        }),
    )
}

#[test]
fn android_video_gestures_run_only_while_the_display_keeps_the_mapped_size() {
    let mut runner = FakeRunner::new(vec![Ok(png(108, 192)), Ok(Vec::new())]);
    let result = execute(&mut runner, tap_at(PHONE, 54, 96, 108, 192)).unwrap();
    assert_eq!(result["operation"], "tap");
    assert_eq!(result["status"], "requested");
    assert_eq!(
        runner.calls,
        vec![
            (
                Tool::Adb,
                args(&["-s", "emulator-5554", "exec-out", "screencap", "-p"])
            ),
            (
                Tool::Adb,
                args(&["-s", "emulator-5554", "shell", "input", "tap", "54", "96"])
            )
        ]
    );
    let mut runner = FakeRunner::new(vec![Ok(png(108, 192)), Ok(Vec::new())]);
    execute(&mut runner, swipe_from(PHONE, [10, 20, 30, 40], 108, 192)).unwrap();
    assert_eq!(
        runner.calls[1].1,
        args(&[
            "-s",
            "emulator-5554",
            "shell",
            "input",
            "swipe",
            "10",
            "20",
            "30",
            "40",
            "250"
        ])
    );
    // The device rotated after the video's coordinates were mapped: nothing is touched.
    for gesture in [
        tap_at(PHONE, 54, 96, 108, 192),
        swipe_from(PHONE, [10, 20, 30, 40], 108, 192),
    ] {
        let mut runner = FakeRunner::new(vec![Ok(png(192, 108))]);
        assert!(matches!(
            execute(&mut runner, gesture),
            Err(Error::Device("DeviceDimensionsChanged"))
        ));
        assert_eq!(runner.calls.len(), 1, "only the display size was read");
    }
}

#[test]
fn android_video_gestures_outside_the_mapped_display_or_with_hostile_ids_reach_no_sdk() {
    let mut runner = FakeRunner::new(vec![]);
    for gesture in [
        tap_at(PHONE, 108, 0, 108, 192),
        tap_at(PHONE, 0, 192, 108, 192),
        tap_at(PHONE, 0, 0, 0, 0),
        swipe_from(PHONE, [0, 0, 108, 5], 108, 192),
    ] {
        assert!(execute(&mut runner, gesture).is_err());
    }
    assert!(execute(
        &mut runner,
        DeviceCommand::Android {
            id: "-s".into(),
            action: android::AndroidAction::Gesture(Gesture::Tap {
                x: 1,
                y: 1,
                width: 2,
                height: 2
            })
        }
    )
    .is_err());
    assert!(runner.calls.is_empty());
}

#[test]
fn android_video_probe_reports_the_display_size_the_gestures_must_match() {
    let mut outputs = vec![Ok(b"cmd\nshell_v2\nstat_v2\n".to_vec()), Ok(Vec::new())];
    outputs.extend(
        [
            "Decoder h264 ",
            "Encoder mjpeg ",
            "Muxer mpjpeg ",
            "Filter fps",
        ]
        .map(|help| Ok(help.as_bytes().to_vec())),
    );
    outputs.push(Ok(png(1080, 1920)));
    let probe = execute(
        &mut FakeRunner::new(outputs),
        android_gesture(PHONE, android::AndroidAction::Probe),
    )
    .unwrap();
    assert_eq!(probe["viewOnly"], false);
    assert_eq!(probe["displayWidth"], 1080);
    assert_eq!(probe["displayHeight"], 1920);
    assert_eq!(probe["width"], 720);
    assert_eq!(probe["height"], 1280);
}

#[test]
fn boot_only_launches_a_discovered_avd_and_does_not_claim_completed_boot() {
    let mut runner = FakeRunner::new(vec![Ok(b"Pixel_API_36\n".to_vec())]);
    let result = execute(
        &mut runner,
        DeviceCommand::Boot {
            platform: Platform::Android,
            id: "Pixel_API_36".into(),
        },
    )
    .unwrap();
    assert_eq!(result["status"], "requested");
    assert_eq!(
        runner.launches[0],
        (
            Tool::Emulator,
            args(&["-avd", "Pixel_API_36", "-no-window"])
        )
    );
    let mut runner = FakeRunner::new(vec![Ok(b"Pixel_API_36\n".to_vec())]);
    assert!(execute(
        &mut runner,
        DeviceCommand::Boot {
            platform: Platform::Android,
            id: "Other_Device".into()
        }
    )
    .is_err());
    assert!(runner.launches.is_empty());
}

#[test]
fn ios_reboot_orders_shutdown_then_boot_for_the_exact_uuid() {
    let mut runner = FakeRunner::new(vec![Ok(Vec::new()), Ok(Vec::new())]);
    execute(
        &mut runner,
        DeviceCommand::Reboot {
            platform: Platform::Ios,
            id: UUID.into(),
        },
    )
    .unwrap();
    assert_eq!(
        runner.calls,
        vec![
            (Tool::Simctl, args(&["shutdown", UUID])),
            (Tool::Simctl, args(&["boot", UUID]))
        ]
    );
}

#[test]
fn screenshots_bound_bridge_payload_and_preserve_source_coordinate_dimensions() {
    let mut runner = FakeRunner::new(vec![Ok(png(3000, 1000))]);
    let frame = execute(
        &mut runner,
        DeviceCommand::Screenshot {
            platform: Platform::Android,
            id: "emulator-5554".into(),
        },
    )
    .unwrap();
    assert_eq!(frame["width"], 3000);
    assert_eq!(frame["height"], 1000);
    assert_eq!(frame["imageWidth"], 1280);
    assert!(frame["imageHeight"].as_u64().unwrap() < 1000);
    assert_jpeg_preview(&frame);
    assert_eq!(
        runner.calls[0],
        (
            Tool::Adb,
            args(&["-s", "emulator-5554", "exec-out", "screencap", "-p"])
        )
    );
}

#[test]
fn a_warning_line_before_the_screenshot_is_skipped_but_other_prefixes_are_not() {
    let screenshot = |bytes: Vec<u8>| {
        execute(
            &mut FakeRunner::new(vec![Ok(bytes)]),
            DeviceCommand::Screenshot {
                platform: Platform::Android,
                id: "emulator-5554".into(),
            },
        )
    };
    let warning = b"/vendor/etc/hwdata/amdgpu.ids: No such file or directory\n";
    let with_warning = [warning.as_slice(), &png(300, 200)].concat();
    let frame = screenshot(with_warning).unwrap();
    assert_eq!(
        (frame["width"].as_u64(), frame["height"].as_u64()),
        (Some(300), Some(200))
    );
    assert_jpeg_preview(&frame);
    // Text that never reaches a PNG signature, or reaches it only past the first KiB, is no image.
    let invalid = |bytes: Vec<u8>| screenshot(bytes).unwrap_err();
    assert!(matches!(
        invalid(warning.to_vec()),
        Error::Device("InvalidDeviceImage")
    ));
    let late = [vec![b'x'; 1024], png(300, 200)].concat();
    assert!(matches!(invalid(late), Error::Device("InvalidDeviceImage")));
}

#[test]
fn the_android_video_probe_reads_the_feature_list_comma_or_line_separated() {
    let probe = |features: &str| {
        let mut runner = FakeRunner::new(vec![
            Ok(features.as_bytes().to_vec()),
            Ok(Vec::new()),
            Ok(b"Decoder h264 x".to_vec()),
            Ok(b"Encoder mjpeg x".to_vec()),
            Ok(b"Muxer mpjpeg x".to_vec()),
            Ok(b"Filter fps x".to_vec()),
            Ok(png(64, 128)),
        ]);
        android::execute(&mut runner, "emulator-5554", android::AndroidAction::Probe)
    };
    for features in [
        "shell_v2,cmd",
        "shell_v2\ncmd\nstat_v2\n",
        "cmd\r\nshell_v2\r\n",
    ] {
        assert_eq!(probe(features).unwrap()["stream"], true, "{features:?}");
    }
    for features in ["cmd\nstat_v2\n", "shell_v2x,cmd", ""] {
        assert!(
            matches!(
                probe(features),
                Err(Error::Device("AndroidShellV2Unavailable"))
            ),
            "{features:?}"
        );
    }
}

fn assert_jpeg_preview(frame: &Value) {
    assert_eq!(frame["mime"], "image/jpeg");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(frame["base64"].as_str().unwrap())
        .unwrap();
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap();
    assert_eq!(
        decoded.width(),
        frame["imageWidth"].as_u64().unwrap() as u32
    );
    assert_eq!(
        decoded.height(),
        frame["imageHeight"].as_u64().unwrap() as u32
    );
    assert!((1..=1280).contains(&decoded.width()));
    assert!((1..=1280).contains(&decoded.height()));
    assert!(bytes.len() <= MAX_FRAME);
    assert!(serde_json::to_vec(&frame).unwrap().len() < 768 * 1024);
}

/// The serial an acceptance test was explicitly told to use, which must be an emulator.
pub(super) fn owned_emulator() -> String {
    let id = std::env::var("LAZYSH_TEST_ANDROID_SERIAL")
        .expect("explicitly select an owned emulator with LAZYSH_TEST_ANDROID_SERIAL");
    assert!(
        emulator_id(&id),
        "this acceptance test requires an emulator"
    );
    assert_eq!(std::env::var("ANDROID_SERIAL").as_deref(), Ok(id.as_str()));
    id
}
fn sdk_runner() -> SdkRunner {
    SdkRunner {
        cancelled: Arc::new(AtomicBool::new(false)),
    }
}
#[test]
#[ignore = "requires an explicitly selected owned Android emulator and installed SDK"]
fn android_owned_emulator_inventory_and_screenshot() {
    let id = owned_emulator();
    let mut runner = sdk_runner();
    let inventory = execute(
        &mut runner,
        DeviceCommand::List {
            platform: Platform::Android,
        },
    )
    .expect("real SDK discovery");
    let selected = inventory["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|device| device["id"].as_str() == Some(&id))
        .expect("the selected emulator must be present in actual SDK discovery");
    assert_eq!(selected["state"], "running");
    assert_eq!(selected["kind"], "emulator");
    assert_eq!(selected["capabilities"]["screenshot"], true);
    let frame = execute(
        &mut runner,
        DeviceCommand::Screenshot {
            platform: Platform::Android,
            id: id.clone(),
        },
    )
    .expect("real emulator capture through the production SDK runner");
    assert_eq!(frame["schemaVersion"], 1);
    assert_eq!(frame["platform"], "android");
    assert_eq!(frame["id"], id);
    for axis in ["width", "height"] {
        assert!((1..=8192).contains(&frame[axis].as_u64().unwrap()));
    }
    assert_jpeg_preview(&frame);
    // Report dimensions only: never persist or print captured screen contents.
    println!(
        "owned Android SDK preview: {}x{} source, {}x{} JPEG",
        frame["width"], frame["height"], frame["imageWidth"], frame["imageHeight"]
    );
}

#[test]
#[ignore = "requires an explicitly selected owned Android emulator and installed SDK"]
fn android_owned_emulator_video_gestures_follow_the_display_size() {
    struct ResetSize(String);
    impl Drop for ResetSize {
        fn drop(&mut self) {
            let _ = sdk_runner().output(
                Tool::Adb,
                &args(&["-s", &self.0, "shell", "wm", "size", "reset"]),
                MAX_SDK_TEXT,
            );
        }
    }
    let id = owned_emulator();
    let mut runner = sdk_runner();
    let (width, height) = android::display_size(&mut runner, &id).unwrap();
    let tap = |runner: &mut SdkRunner, (width, height): (u32, u32)| {
        execute(runner, tap_at(&id, width / 2, height / 2, width, height))
    };
    tap(&mut runner, (width, height)).expect("a tap at the current display size");
    let _reset = ResetSize(id.clone());
    let resized = (width / 2 / 2 * 2, height * 3 / 4 / 2 * 2);
    runner
        .output(
            Tool::Adb,
            &args(&[
                "-s",
                &id,
                "shell",
                "wm",
                "size",
                &format!("{}x{}", resized.0, resized.1),
            ]),
            MAX_SDK_TEXT,
        )
        .unwrap();
    let started = Instant::now();
    while android::display_size(&mut runner, &id).unwrap() != resized {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "display never resized"
        );
        thread::sleep(Duration::from_millis(250));
    }
    assert!(matches!(
        tap(&mut runner, (width, height)),
        Err(Error::Device("DeviceDimensionsChanged"))
    ));
    tap(&mut runner, resized).expect("a tap mapped from the resized display");
    println!(
        "owned Android gestures: {width}x{height} accepted, stale mapping refused at {}x{}",
        resized.0, resized.1
    );
}

#[test]
fn ios_screenshot_uses_a_private_temporary_filename_and_cleans_it_afterwards() {
    let mut runner = FakeRunner::new(vec![Ok(Vec::new())]);
    runner.ios_png = Some(png(100, 200));
    let frame = execute(
        &mut runner,
        DeviceCommand::Screenshot {
            platform: Platform::Ios,
            id: UUID.into(),
        },
    )
    .unwrap();
    assert_eq!(frame["width"], 100);
    let command = &runner.calls[0].1;
    assert_eq!(
        &command[..4],
        &args(&["io", UUID, "screenshot", "--type=png"])
    );
    assert!(!std::path::Path::new(command.last().unwrap()).exists());
}

#[test]
fn malformed_images_and_pixel_bombs_fail_before_unbounded_decode() {
    assert!(frame(Platform::Android, "phone", b"not a PNG").is_err());
    let mut header = vec![0; 24];
    header[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    header[12..16].copy_from_slice(b"IHDR");
    header[16..20].copy_from_slice(&8192_u32.to_be_bytes());
    header[20..24].copy_from_slice(&8192_u32.to_be_bytes());
    assert!(frame(Platform::Android, "phone", &header).is_err());
    assert!(frame(Platform::Android, "phone", &vec![0; MAX_PNG + 1]).is_err());
}

#[test]
fn unavailable_sdks_and_cancellation_do_not_fabricate_devices() {
    let mut runner = FakeRunner::new(vec![
        Err(Error::Device("SdkUnavailable")),
        Err(Error::Device("SdkUnavailable")),
    ]);
    let list = execute(
        &mut runner,
        DeviceCommand::List {
            platform: Platform::Android,
        },
    )
    .unwrap();
    assert!(list["devices"].as_array().unwrap().is_empty());
    assert_eq!(list["warnings"].as_array().unwrap().len(), 2);
    let mut runner = FakeRunner::new(vec![Err(Error::Device("DeviceCancelled"))]);
    assert!(matches!(
        execute(
            &mut runner,
            DeviceCommand::List {
                platform: Platform::Android
            }
        ),
        Err(Error::Device("DeviceCancelled"))
    ));
    assert_eq!(runner.calls.len(), 1);
}

fn fixture(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "devices::tests::sdk_fixture_process",
            "--nocapture",
        ])
        .env("LAZYSH_DEVICE_FIXTURE_MODE", mode);
    command
}
#[test]
fn bounded_subprocesses_enforce_output_timeout_and_mid_run_cancellation() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let output = bounded_command(
        fixture("output"),
        2048,
        cancelled.clone(),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(String::from_utf8_lossy(&output).contains("fixture-ok"));
    assert!(matches!(
        bounded_command(
            fixture("oversized"),
            64,
            cancelled.clone(),
            Duration::from_secs(5)
        ),
        Err(Error::Device("DeviceOutputTooLarge"))
    ));
    let started = Instant::now();
    assert!(matches!(
        bounded_command(
            fixture("wait"),
            2048,
            cancelled.clone(),
            Duration::from_millis(100)
        ),
        Err(Error::Device("DeviceTimeout"))
    ));
    assert!(started.elapsed() < Duration::from_secs(5));
    let signal = cancelled.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        signal.store(true, Ordering::Relaxed);
    });
    assert!(matches!(
        bounded_command(fixture("wait"), 2048, cancelled, Duration::from_secs(5)),
        Err(Error::Device("DeviceCancelled"))
    ));
}
#[test]
#[ignore = "Rust subprocess fixture exercised by bounded_subprocesses test"]
fn sdk_fixture_process() {
    match std::env::var("LAZYSH_DEVICE_FIXTURE_MODE").as_deref() {
        Ok("output") => println!("fixture-ok"),
        Ok("oversized") => {
            std::io::stdout().write_all(&[b'x'; 4096]).unwrap();
            std::io::stdout().flush().unwrap();
            thread::sleep(Duration::from_secs(30));
        }
        Ok("wait") => thread::sleep(Duration::from_secs(30)),
        _ => {}
    }
}
