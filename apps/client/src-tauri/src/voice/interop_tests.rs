//! Opt-in, same-client-binary native acceptance. No commands or engine selection are exposed.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

const REFERENCE: &str =
    "MISTER QUILTER IS THE APOSTLE OF THE MIDDLE CLASSES AND WE ARE GLAD TO WELCOME HIS GOSPEL";
const WAV_SHA256: &str = "799f78ed4beb4de7ceae3a809262d4ce242394342ccd1d58cef7d49dbc2def46";
const WHISPER_BYTES: u64 = 77_704_715;
const WHISPER_SHA256: &str = "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";

fn verified_file(path: &Path, bytes: u64, expected_hash: &str) -> fs::File {
    let metadata = fs::symlink_metadata(path).expect("inspect explicit public fixture");
    assert!(
        metadata.is_file(),
        "fixture must be a regular non-symlink file"
    );
    assert_eq!(metadata.len(), bytes, "fixed public fixture size");
    let mut file = fs::File::open(path).expect("open public fixture");
    let mut hash = Sha256::new();
    let mut remaining = bytes + 1;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let capacity = (remaining as usize).min(buffer.len());
        let count = file.read(&mut buffer[..capacity]).unwrap();
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        remaining -= count as u64;
    }
    assert_eq!(remaining, 1, "fixture changed size during verification");
    assert_eq!(
        format!("{:x}", hash.finalize()),
        expected_hash,
        "fixed public fixture hash"
    );
    file
}

fn samples(path: &Path) -> Vec<f32> {
    use std::io::{Seek, SeekFrom};
    let mut file = verified_file(path, 187_404, WAV_SHA256);
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut reader = hound::WavReader::new(file).unwrap();
    let format = reader.spec();
    assert_eq!(format.channels, 1);
    assert_eq!(format.sample_rate, 16_000);
    assert_eq!(format.bits_per_sample, 16);
    assert_eq!(format.sample_format, hound::SampleFormat::Int);
    assert_eq!(reader.duration(), 93_680);
    reader
        .samples::<i16>()
        .map(|sample| f32::from(sample.unwrap()) / 32768.)
        .collect()
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_uppercase)
        .collect()
}
fn word_error_rate(reference: &str, observed: &str) -> f64 {
    let reference = words(reference);
    let observed = words(observed);
    assert!(!reference.is_empty());
    let mut previous: Vec<usize> = (0..=observed.len()).collect();
    for (i, expected) in reference.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, actual) in observed.iter().enumerate() {
            row.push(
                (previous[j] + usize::from(expected != actual))
                    .min(previous[j + 1] + 1)
                    .min(row[j] + 1),
            );
        }
        previous = row;
    }
    previous[observed.len()] as f64 / reference.len() as f64
}
fn acceptable(engine: &str, text: &str) {
    let wer = word_error_rate(REFERENCE, text);
    eprintln!("voice interop engine={engine} wer={wer:.6} public_transcript={text:?}");
    // The same independent 17-word reference and threshold are chosen before either engine runs.
    assert!(
        wer <= 0.10,
        "{engine} public-reference WER must be <= 0.10, got {wer}"
    );
}

#[test]
fn linked_native_runtimes_start_and_exit() {
    assert_eq!(lazysh_parakeet_runtime::version().unwrap(), "2.0.0");
    assert_eq!(whisper_rs::get_whisper_version(), "1.8.3");
    assert!(!whisper_rs::print_system_info().is_empty());
    // The original collision aborted after the harness reported success.
    // Cargo must observe a clean process exit, without any model or inference.
}

#[test]
fn metric_preserves_case_punctuation_and_counts_errors() {
    assert_eq!(word_error_rate("one two three", "ONE, two three."), 0.);
    for value in ["one two four", "one three", "one two three four"] {
        assert_eq!(word_error_rate("one two three", value), 1. / 3.);
    }
    assert_eq!(word_error_rate("one two three", ""), 1.);
}

#[test]
#[ignore = "requires fixed public models/audio via explicit environment; run in its own Cargo test process"]
fn whisper_then_parakeet() {
    run(true);
}

#[test]
#[ignore = "requires fixed public models/audio via explicit environment; run in its own Cargo test process"]
fn parakeet_then_whisper() {
    run(false);
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
fn run(_: bool) {
    panic!("this initial experiment requires Linux x64; other platform acceptance is pending");
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn run(whisper_first: bool) {
    use lazysh_parakeet_runtime::{Recognizer, VerifiedBundle};
    use std::{os::unix::fs::PermissionsExt, path::PathBuf};
    let required = |name| {
        PathBuf::from(
            std::env::var_os(name)
                .unwrap_or_else(|| panic!("set {name}; no implicit fixture selection/download")),
        )
    };
    let whisper_path = required("LAZYSH_WHISPER_TEST_MODEL");
    let archive = required("LAZYSH_PARAKEET_TEST_ARCHIVE");
    let wav = required("LAZYSH_WHISPER_TEST_WAV");
    drop(verified_file(&whisper_path, WHISPER_BYTES, WHISPER_SHA256));
    let audio = samples(&wav);
    let whisper = || {
        eprintln!("voice interop phase=whisper-inference");
        let text = super::infer(
            &whisper_path,
            &audio,
            "en",
            Arc::new(AtomicBool::new(false)),
        )
        .expect("actual client Whisper inference");
        acceptable("whisper", &text);
        text
    };
    let initial_whisper = whisper_first.then(whisper);
    eprintln!("voice interop phase=parakeet-prepare whisper_first={whisper_first}");
    let parent = tempfile::Builder::new()
        .prefix("lazysh-voice-interop-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let bundle = VerifiedBundle::read_in(fs::File::open(archive).unwrap(), parent.path())
        .expect("sealed actual model archive");
    let mut entries = fs::read_dir(parent.path()).unwrap();
    let model_directory = entries.next().unwrap().unwrap().path();
    assert!(entries.next().is_none());
    eprintln!("voice interop phase=parakeet-load");
    let mut model = Recognizer::new(bundle).expect("actual Parakeet model in the client binary");
    eprintln!("voice interop phase=parakeet-first");
    let first = model.transcribe(&audio).unwrap();
    acceptable("parakeet", &first);
    let during = whisper();
    if let Some(initial) = initial_whisper {
        assert_eq!(
            initial, during,
            "Whisper remains stable after Parakeet initialization"
        );
    }
    eprintln!("voice interop phase=parakeet-repeat-after-whisper");
    assert_eq!(
        model.transcribe(&audio).unwrap(),
        first,
        "Parakeet remains stable after Whisper teardown"
    );
    assert_eq!(
        fs::read_dir(parent.path()).unwrap().count(),
        1,
        "reuse one extraction"
    );
    drop(model);
    assert!(
        !model_directory.exists(),
        "native model destruction precedes file cleanup"
    );
    if !whisper_first {
        assert_eq!(
            whisper(),
            during,
            "Whisper remains stable after Parakeet teardown"
        );
    }
    eprintln!(
        "voice interop phase=complete whisper_first={whisper_first} rust_debug_assertions={}",
        cfg!(debug_assertions)
    );
}
