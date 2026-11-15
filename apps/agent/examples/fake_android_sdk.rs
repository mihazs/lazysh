//! A stand-in for the Android SDK's `adb` and `emulator` and for `ffmpeg`, chosen by the name it is
//! run under, so tests can drive the real `lazysh-agent devices` commands on any platform. It
//! answers the exact argv the companion sends, never anything else, and is not a provider.
use image::{codecs::jpeg::JpegEncoder, ImageFormat, RgbImage};
use std::{
    io::{Cursor, Write},
    path::Path,
    time::Duration,
};

/// A long-lived child ends by itself after this many frames, so a leaked one cannot outlive a test.
const FRAMES: usize = 600;
const SERIAL: &str = "emulator-5554";

fn picture() -> RgbImage {
    RgbImage::from_pixel(64, 128, image::Rgb([30, 120, 200]))
}
fn encode(format: ImageFormat) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    match format {
        ImageFormat::Jpeg => picture()
            .write_with_encoder(JpegEncoder::new(&mut bytes))
            .unwrap(),
        _ => picture().write_to(&mut bytes, format).unwrap(),
    }
    bytes.into_inner()
}
/// Tells the test which long-lived children exist, one empty file per child: `<role>-<pid>`.
fn announce(role: &str) {
    if let Some(directory) = std::env::var_os("LAZYSH_FAKE_SDK_PIDS") {
        std::fs::write(
            Path::new(&directory).join(format!("{role}-{}", std::process::id())),
            "",
        )
        .unwrap();
    }
}
/// Writes `piece` every 100 ms. Like an SDK tool that does not notice its reader is gone, it keeps
/// running after a failed write, so only the companion ending it removes it before `FRAMES` pass.
fn repeat(role: &str, piece: &[u8]) {
    announce(role);
    let mut out = std::io::stdout().lock();
    let mut reader_gone = false;
    for _ in 0..FRAMES {
        reader_gone = reader_gone || out.write_all(piece).and_then(|()| out.flush()).is_err();
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn adb(args: &[String]) {
    // `-s SERIAL` selects the device and is not part of what is asked.
    let asked = if args.first().is_some_and(|flag| flag == "-s") {
        assert_eq!(args[1], SERIAL, "unexpected device");
        &args[2..]
    } else {
        args
    };
    match asked.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["devices", "-l"] => print!(
            "List of devices attached\n{SERIAL} device product:sdk model:Pixel_8 transport_id:1\n"
        ),
        ["features"] => print!("shell_v2,cmd"),
        ["exec-out", "screencap", "-p"] => std::io::stdout()
            .write_all(&encode(ImageFormat::Png))
            .unwrap(),
        // The capability probe: `screenrecord` parses its options and `--help` exits.
        ["shell", .., "--help"] => {}
        ["shell", .., "-"] => repeat("capture", b"fake-h264\n"),
        _ => std::process::exit(2),
    }
}
fn ffmpeg(args: &[String]) {
    if let [.., "-h", topic] = &args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        let (kind, name) = topic.split_once('=').unwrap();
        println!("{} {name} (fake)", kind[..1].to_uppercase() + &kind[1..]);
        return;
    }
    let jpeg = encode(ImageFormat::Jpeg);
    let mut part = format!(
        "--lazysh-frame\r\nContent-type: image/jpeg\r\nContent-length: {}\r\n\r\n",
        jpeg.len()
    )
    .into_bytes();
    part.extend_from_slice(&jpeg);
    part.extend_from_slice(b"\r\n");
    repeat("decode", &part);
}
fn main() {
    let mut args = std::env::args();
    let name = args.next().unwrap();
    let args: Vec<String> = args.collect();
    match Path::new(&name).file_stem().and_then(|name| name.to_str()) {
        Some("adb") => adb(&args),
        Some("emulator") => println!("Pixel_API_36"),
        Some("ffmpeg") => ffmpeg(&args),
        _ => std::process::exit(2),
    }
}
