use super::*;
use std::{collections::VecDeque, io::Write};

const UUID: &str = "9C405382-203A-4DC0-A11B-B2FC37EBA881";
struct FakeRunner {
    calls: Vec<(Tool, Vec<String>)>,
    outputs: VecDeque<Result<Vec<u8>>>,
    launches: Vec<(Tool, Vec<String>)>,
    ios_png: Option<Vec<u8>>,
}
impl FakeRunner {
    fn new(outputs: Vec<Result<Vec<u8>>>) -> Self {
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
fn png(width: u32, height: u32) -> Vec<u8> {
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
    assert!(serde_json::to_vec(&frame).unwrap().len() < 768 * 1024);
    assert_eq!(
        runner.calls[0],
        (
            Tool::Adb,
            args(&["-s", "emulator-5554", "exec-out", "screencap", "-p"])
        )
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
