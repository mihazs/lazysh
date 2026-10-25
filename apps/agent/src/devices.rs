use crate::{Error, Result};
use base64::Engine;
use clap::{Subcommand, ValueEnum};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{Cursor, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_SDK_TEXT: usize = 256 * 1024;
const MAX_PNG: usize = 8 * 1024 * 1024;
const MAX_FRAME: usize = 512 * 1024;
const SDK_TIMEOUT: Duration = Duration::from_secs(10);
pub mod android;
pub mod idb;

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Android,
    Ios,
}
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum DeviceKey {
    Back,
    Home,
    Enter,
    Menu,
    Power,
    VolumeUp,
    VolumeDown,
}
#[derive(Subcommand, Debug)]
pub enum DeviceCommand {
    Android {
        #[arg(long)]
        id: String,
        #[command(subcommand)]
        action: android::AndroidAction,
    },
    /// Use an explicitly configured local iOS idb companion.
    Ios {
        #[arg(long)]
        id: String,
        #[arg(long)]
        socket: String,
        #[command(subcommand)]
        action: idb::IosAction,
    },
    List {
        #[arg(long, value_enum)]
        platform: Platform,
    },
    Screenshot {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long)]
        id: String,
    },
    Tap {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long)]
        id: String,
        #[arg(long)]
        x: u32,
        #[arg(long)]
        y: u32,
    },
    Swipe {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long)]
        id: String,
        #[arg(long)]
        x: u32,
        #[arg(long)]
        y: u32,
        #[arg(long)]
        to_x: u32,
        #[arg(long)]
        to_y: u32,
        #[arg(long,default_value_t=300,value_parser=clap::value_parser!(u16).range(1..=10000))]
        duration_ms: u16,
    },
    Key {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long)]
        id: String,
        #[arg(long, value_enum)]
        key: DeviceKey,
    },
    Boot {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long)]
        id: String,
    },
    Shutdown {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long)]
        id: String,
    },
    Reboot {
        #[arg(long, value_enum)]
        platform: Platform,
        #[arg(long)]
        id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tool {
    Adb,
    Emulator,
    Simctl,
    Idb,
    Ffmpeg,
}
trait Runner {
    fn output(&mut self, tool: Tool, args: &[String], limit: usize) -> Result<Vec<u8>>;
    fn launch(&mut self, tool: Tool, args: &[String]) -> Result<()>;
}
struct SdkRunner {
    cancelled: Arc<AtomicBool>,
}
impl SdkRunner {
    fn command(tool: Tool, args: &[String]) -> Command {
        let sdk = std::env::var_os("ANDROID_HOME").or_else(|| std::env::var_os("ANDROID_SDK_ROOT"));
        let (directory, name) = match tool {
            Tool::Adb => ("platform-tools", "adb"),
            Tool::Emulator => ("emulator", "emulator"),
            Tool::Simctl => ("", "xcrun"),
            Tool::Idb => ("", "idb"),
            Tool::Ffmpeg => ("", "ffmpeg"),
        };
        let filename = if cfg!(windows) && tool != Tool::Simctl {
            format!("{name}.exe")
        } else {
            name.into()
        };
        let program = if matches!(tool, Tool::Simctl | Tool::Idb | Tool::Ffmpeg) {
            PathBuf::from(name)
        } else {
            sdk.map(PathBuf::from)
                .map(|root| root.join(directory).join(&filename))
                .unwrap_or_else(|| filename.into())
        };
        let mut command = Command::new(program);
        if tool == Tool::Simctl {
            command.arg("simctl");
        }
        command.args(args);
        command
    }
}

struct OwnedChild(Option<Child>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn prepare(command: &mut Command) {
    command.stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}
fn bounded_command(
    mut command: Command,
    maximum: usize,
    cancelled: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<Vec<u8>> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(Error::Device("DeviceCancelled"));
    }
    prepare(&mut command);
    command.stdout(Stdio::piped());
    let child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::Device("SdkUnavailable")
        } else {
            Error::Device("SdkCommandFailed")
        }
    })?;
    let mut child = OwnedChild(Some(child));
    let stdout = child
        .0
        .as_mut()
        .and_then(|child| child.stdout.take())
        .ok_or(Error::Device("SdkCommandFailed"))?;
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let started = Instant::now();
    let mut output = None;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(Error::Device("DeviceCancelled"));
        }
        if started.elapsed() > timeout {
            return Err(Error::Device("DeviceTimeout"));
        }
        if output.is_none() {
            match receiver.try_recv() {
                Ok(Ok(bytes)) => {
                    if bytes.len() > maximum {
                        return Err(Error::Device("DeviceOutputTooLarge"));
                    }
                    output = Some(bytes);
                }
                Ok(Err(_)) | Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(Error::Device("SdkCommandFailed"))
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(status) = child
            .0
            .as_mut()
            .ok_or(Error::Device("SdkCommandFailed"))?
            .try_wait()?
        {
            if !status.success() {
                return Err(Error::Device("SdkCommandFailed"));
            }
            if let Some(output) = output {
                return Ok(output);
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
}
impl Runner for SdkRunner {
    fn output(&mut self, tool: Tool, args: &[String], limit: usize) -> Result<Vec<u8>> {
        bounded_command(
            Self::command(tool, args),
            limit,
            self.cancelled.clone(),
            SDK_TIMEOUT,
        )
    }
    fn launch(&mut self, tool: Tool, args: &[String]) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::Device("DeviceCancelled"));
        }
        let mut command = Self::command(tool, args);
        prepare(&mut command);
        command.stdout(Stdio::null());
        let mut child = OwnedChild(Some(
            command
                .spawn()
                .map_err(|_| Error::Device("SdkUnavailable"))?,
        ));
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(500) {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::Device("DeviceCancelled"));
            }
            if let Some(status) = child
                .0
                .as_mut()
                .ok_or(Error::Device("SdkCommandFailed"))?
                .try_wait()?
            {
                return if status.success() {
                    child.0.take();
                    Ok(())
                } else {
                    Err(Error::Device("SdkCommandFailed"))
                };
            }
            thread::sleep(Duration::from_millis(10));
        }
        child.0.take(); // The host SDK owns the explicitly started emulator after acknowledgement.
        Ok(())
    }
}

pub fn run(command: DeviceCommand) -> Result<Value> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal = cancelled.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))
        .map_err(|_| Error::Device("DeviceCancellationUnavailable"))?;
    execute(&mut SdkRunner { cancelled }, command)
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}
fn valid_id(platform: Platform, id: &str) -> bool {
    match platform {
        Platform::Android => {
            !id.is_empty()
                && id.len() <= 256
                && !id.starts_with('-')
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-:[]".contains(&byte))
        }
        Platform::Ios => {
            id.len() == 36
                && id.bytes().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
        }
    }
}
fn capabilities(running: bool, boot: bool, android: bool, emulator: bool) -> Value {
    json!({"screenshot":running,"tap":running&&android,"swipe":running&&android,"key":running&&android,"boot":boot,"shutdown":running&&emulator,"reboot":running})
}
fn inventory(runner: &mut impl Runner, platform: Platform) -> Result<Value> {
    let mut devices = Vec::new();
    let mut avds = Vec::new();
    let mut warnings = Vec::new();
    match platform {
        Platform::Android => {
            match runner.output(Tool::Adb, &args(&["devices", "-l"]), MAX_SDK_TEXT) {
                Ok(output) => {
                    let text = std::str::from_utf8(&output)
                        .map_err(|_| Error::Device("InvalidDeviceList"))?;
                    for line in text.lines().filter(|line| {
                        !line.trim().is_empty()
                            && !line.starts_with("List of devices")
                            && !line.starts_with('*')
                    }) {
                        let mut fields = line.split_whitespace();
                        let id = fields.next().ok_or(Error::Device("InvalidDeviceList"))?;
                        let state = fields.next().ok_or(Error::Device("InvalidDeviceList"))?;
                        if !valid_id(platform, id) {
                            return Err(Error::Device("InvalidDeviceList"));
                        }
                        let name = fields
                            .find_map(|field| field.strip_prefix("model:"))
                            .unwrap_or(id)
                            .replace('_', " ");
                        if name.len() > 256 {
                            return Err(Error::Device("InvalidDeviceList"));
                        }
                        let running = state == "device";
                        let state = match state {
                            "device" => "running",
                            "offline" => "offline",
                            "unauthorized" => "unauthorized",
                            _ => "unknown",
                        };
                        let emulator = emulator_id(id);
                        devices.push(json!({"id":id,"name":name,"state":state,"kind":if emulator {"emulator"} else {"device"},"capabilities":capabilities(running,false,true,emulator)}));
                        if devices.len() == 100 {
                            warnings.push("Additional connected devices may be omitted");
                            break;
                        }
                    }
                }
                Err(Error::Device("SdkUnavailable")) => {
                    warnings.push("Android platform-tools unavailable on this host")
                }
                Err(Error::Device("DeviceCancelled")) => {
                    return Err(Error::Device("DeviceCancelled"))
                }
                Err(_) => warnings.push("Android device discovery failed"),
            }
            match runner.output(Tool::Emulator, &args(&["-list-avds"]), MAX_SDK_TEXT) {
                Ok(output) => {
                    for id in std::str::from_utf8(&output)
                        .map_err(|_| Error::Device("InvalidDeviceList"))?
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .take(101)
                    {
                        if avds.len() == 100 {
                            warnings.push("Additional Android virtual devices may be omitted");
                            break;
                        }
                        if !valid_avd(id) {
                            return Err(Error::Device("InvalidDeviceList"));
                        }
                        avds.push(json!({"id":id,"name":id.replace('_'," ")}));
                    }
                }
                Err(Error::Device("SdkUnavailable")) => {
                    warnings.push("Android emulator SDK unavailable on this host")
                }
                Err(Error::Device("DeviceCancelled")) => {
                    return Err(Error::Device("DeviceCancelled"))
                }
                Err(_) => warnings.push("Android virtual-device discovery failed"),
            }
        }
        Platform::Ios => {
            let output = runner.output(
                Tool::Simctl,
                &args(&["list", "devices", "--json"]),
                MAX_SDK_TEXT,
            )?;
            let output: Value =
                serde_json::from_slice(&output).map_err(|_| Error::Device("InvalidDeviceList"))?;
            for (runtime, entries) in output["devices"]
                .as_object()
                .ok_or(Error::Device("InvalidDeviceList"))?
            {
                if !runtime.contains(".iOS-") {
                    continue;
                }
                for entry in entries
                    .as_array()
                    .ok_or(Error::Device("InvalidDeviceList"))?
                {
                    let id = entry["udid"]
                        .as_str()
                        .filter(|id| valid_id(platform, id))
                        .ok_or(Error::Device("InvalidDeviceList"))?;
                    let name = entry["name"]
                        .as_str()
                        .filter(|name| name.len() <= 256)
                        .ok_or(Error::Device("InvalidDeviceList"))?;
                    let available = entry["isAvailable"] == true;
                    let state = if !available {
                        "unavailable"
                    } else {
                        match entry["state"].as_str() {
                            Some("Booted") => "running",
                            Some("Shutdown") => "shutdown",
                            Some("Booting") => "booting",
                            Some("Shutting Down") => "shutting_down",
                            _ => "unknown",
                        }
                    };
                    devices.push(json!({"id":id,"name":name,"state":state,"kind":"simulator","capabilities":capabilities(state=="running",state=="shutdown",false,true)}));
                    if devices.len() == 100 {
                        warnings.push("Additional iOS simulators may be omitted");
                        break;
                    }
                }
                if devices.len() == 100 {
                    break;
                }
            }
        }
    }
    Ok(
        json!({"schemaVersion":1,"platform":platform,"devices":devices,"avds":avds,"warnings":warnings}),
    )
}
fn valid_avd(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}
fn emulator_id(id: &str) -> bool {
    id.strip_prefix("emulator-")
        .is_some_and(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
}
fn execute(runner: &mut impl Runner, command: DeviceCommand) -> Result<Value> {
    if let DeviceCommand::Android { id, action } = command {
        return android::execute(runner, &id, action);
    }
    if let DeviceCommand::Ios { id, socket, action } = command {
        return idb::execute(runner, &id, &socket, action);
    }
    let (platform, id, operation) = match command {
        DeviceCommand::Android { .. } => unreachable!("Android video commands are handled above"),
        DeviceCommand::Ios { .. } => unreachable!("iOS companion commands are handled above"),
        DeviceCommand::List { platform } => return inventory(runner, platform),
        DeviceCommand::Screenshot { platform, ref id } => {
            if !valid_id(platform, id) {
                return Err(Error::InvalidArgument);
            }
            let png = match platform {
                Platform::Android => runner.output(
                    Tool::Adb,
                    &args(&["-s", id, "exec-out", "screencap", "-p"]),
                    MAX_PNG,
                )?,
                Platform::Ios => {
                    let directory = tempfile::tempdir()?;
                    let path = directory.path().join("screenshot.png");
                    runner.output(
                        Tool::Simctl,
                        &args(&[
                            "io",
                            id,
                            "screenshot",
                            "--type=png",
                            path.to_str().ok_or(Error::InvalidArgument)?,
                        ]),
                        MAX_SDK_TEXT,
                    )?;
                    let file = std::fs::File::open(&path)?;
                    if !file.metadata()?.is_file() || file.metadata()?.len() > MAX_PNG as u64 {
                        return Err(Error::Device("DeviceOutputTooLarge"));
                    }
                    let mut bytes = Vec::new();
                    file.take(MAX_PNG as u64 + 1).read_to_end(&mut bytes)?;
                    if bytes.len() > MAX_PNG {
                        return Err(Error::Device("DeviceOutputTooLarge"));
                    }
                    bytes
                }
            };
            return frame(platform, id, &png);
        }
        DeviceCommand::Tap {
            platform,
            ref id,
            x,
            y,
        } => {
            if platform != Platform::Android {
                return Err(Error::Device("DeviceActionUnsupported"));
            }
            coordinates(&[x, y])?;
            (platform, id, "tap")
        }
        DeviceCommand::Swipe {
            platform,
            ref id,
            x,
            y,
            to_x,
            to_y,
            duration_ms,
        } => {
            if platform != Platform::Android {
                return Err(Error::Device("DeviceActionUnsupported"));
            }
            coordinates(&[x, y, to_x, to_y])?;
            if !(1..=10000).contains(&duration_ms) {
                return Err(Error::InvalidArgument);
            }
            (platform, id, "swipe")
        }
        DeviceCommand::Key {
            platform, ref id, ..
        } => {
            if platform != Platform::Android {
                return Err(Error::Device("DeviceActionUnsupported"));
            }
            (platform, id, "key")
        }
        DeviceCommand::Boot { platform, ref id } => {
            if platform == Platform::Android && !valid_avd(id) {
                return Err(Error::InvalidArgument);
            }
            (platform, id, "boot")
        }
        DeviceCommand::Shutdown { platform, ref id } => {
            if platform == Platform::Android && !emulator_id(id) {
                return Err(Error::Device("DeviceActionUnsupported"));
            }
            (platform, id, "shutdown")
        }
        DeviceCommand::Reboot { platform, ref id } => (platform, id, "reboot"),
    };
    if !valid_id(platform, id) {
        return Err(Error::InvalidArgument);
    }
    let arguments = match command {
        DeviceCommand::Tap { x, y, .. } => args(&[
            "-s",
            id,
            "shell",
            "input",
            "tap",
            &x.to_string(),
            &y.to_string(),
        ]),
        DeviceCommand::Swipe {
            x,
            y,
            to_x,
            to_y,
            duration_ms,
            ..
        } => args(&[
            "-s",
            id,
            "shell",
            "input",
            "swipe",
            &x.to_string(),
            &y.to_string(),
            &to_x.to_string(),
            &to_y.to_string(),
            &duration_ms.to_string(),
        ]),
        DeviceCommand::Key { key, .. } => args(&[
            "-s",
            id,
            "shell",
            "input",
            "keyevent",
            match key {
                DeviceKey::Back => "KEYCODE_BACK",
                DeviceKey::Home => "KEYCODE_HOME",
                DeviceKey::Enter => "KEYCODE_ENTER",
                DeviceKey::Menu => "KEYCODE_MENU",
                DeviceKey::Power => "KEYCODE_POWER",
                DeviceKey::VolumeUp => "KEYCODE_VOLUME_UP",
                DeviceKey::VolumeDown => "KEYCODE_VOLUME_DOWN",
            },
        ]),
        DeviceCommand::Boot { .. } if platform == Platform::Android => {
            let available = runner.output(Tool::Emulator, &args(&["-list-avds"]), MAX_SDK_TEXT)?;
            if !std::str::from_utf8(&available)
                .map_err(|_| Error::Device("InvalidDeviceList"))?
                .lines()
                .any(|name| name.trim() == id)
            {
                return Err(Error::Device("DeviceNotFound"));
            }
            runner.launch(Tool::Emulator, &args(&["-avd", id, "-no-window"]))?;
            return Ok(
                json!({"schemaVersion":1,"platform":platform,"id":id,"operation":operation,"status":"requested"}),
            );
        }
        DeviceCommand::Boot { .. } => args(&["boot", id]),
        DeviceCommand::Shutdown { .. } if platform == Platform::Android => {
            args(&["-s", id, "emu", "kill"])
        }
        DeviceCommand::Shutdown { .. } => args(&["shutdown", id]),
        DeviceCommand::Reboot { .. } if platform == Platform::Android => {
            args(&["-s", id, "reboot"])
        }
        DeviceCommand::Reboot { .. } => {
            runner.output(Tool::Simctl, &args(&["shutdown", id]), MAX_SDK_TEXT)?;
            args(&["boot", id])
        }
        _ => return Err(Error::InvalidArgument),
    };
    runner.output(
        if platform == Platform::Android {
            Tool::Adb
        } else {
            Tool::Simctl
        },
        &arguments,
        MAX_SDK_TEXT,
    )?;
    Ok(
        json!({"schemaVersion":1,"platform":platform,"id":id,"operation":operation,"status":"requested"}),
    )
}
fn coordinates(values: &[u32]) -> Result<()> {
    if values.iter().any(|value| *value > 16383) {
        Err(Error::InvalidArgument)
    } else {
        Ok(())
    }
}
fn frame(platform: Platform, id: &str, png: &[u8]) -> Result<Value> {
    if png.len() > MAX_PNG
        || png.len() < 24
        || png[..8] != *b"\x89PNG\r\n\x1a\n"
        || png[12..16] != *b"IHDR"
    {
        return Err(Error::Device("InvalidDeviceImage"));
    }
    let width = u32::from_be_bytes(
        png[16..20]
            .try_into()
            .map_err(|_| Error::Device("InvalidDeviceImage"))?,
    );
    let height = u32::from_be_bytes(
        png[20..24]
            .try_into()
            .map_err(|_| Error::Device("InvalidDeviceImage"))?,
    );
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16 * 1024 * 1024
    {
        return Err(Error::Device("InvalidDeviceImage"));
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(png), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| Error::Device("InvalidDeviceImage"))?;
    if decoded.width() != width || decoded.height() != height {
        return Err(Error::Device("InvalidDeviceImage"));
    }
    let mut thumbnail = decoded.thumbnail(1280, 1280).to_rgb8();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 70)
        .encode_image(&thumbnail)
        .map_err(|_| Error::Device("InvalidDeviceImage"))?;
    if encoded.len() > MAX_FRAME {
        thumbnail = image::DynamicImage::ImageRgb8(thumbnail)
            .thumbnail(720, 720)
            .to_rgb8();
        encoded.clear();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 60)
            .encode_image(&thumbnail)
            .map_err(|_| Error::Device("InvalidDeviceImage"))?;
    }
    if encoded.len() > MAX_FRAME {
        return Err(Error::Device("DeviceOutputTooLarge"));
    }
    Ok(
        json!({"schemaVersion":1,"platform":platform,"id":id,"mime":"image/jpeg","base64":base64::engine::general_purpose::STANDARD.encode(encoded),"width":width,"height":height,"imageWidth":thumbnail.width(),"imageHeight":thumbnail.height()}),
    )
}

#[cfg(test)]
mod tests;
