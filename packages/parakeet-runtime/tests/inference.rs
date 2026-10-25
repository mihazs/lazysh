use sha2::{Digest, Sha256};
use std::io::Cursor;

const WAV: &[u8] = include_bytes!("fixtures/librispeech/1272-128104-0000.wav");
const REFERENCE: &str = include_str!("fixtures/librispeech/reference.txt");

fn speech_samples() -> Vec<f32> {
    assert_eq!(
        format!("{:x}", Sha256::digest(WAV)),
        "799f78ed4beb4de7ceae3a809262d4ce242394342ccd1d58cef7d49dbc2def46",
        "the public speech fixture must match its recorded provenance"
    );
    let mut reader = hound::WavReader::new(Cursor::new(WAV)).unwrap();
    assert_eq!(reader.spec().channels, 1);
    assert_eq!(reader.spec().sample_rate, 16_000);
    assert_eq!(reader.spec().bits_per_sample, 16);
    assert_eq!(reader.spec().sample_format, hound::SampleFormat::Int);
    assert_eq!(reader.duration(), 93_680);
    reader
        .samples::<i16>()
        .map(|value| f32::from(value.unwrap()) / 32768.)
        .collect()
}

use lazysh_common::test_support::{word_error_rate, words};

#[test]
fn licensed_speech_fixture_has_the_recorded_format_and_bounds() {
    let samples = speech_samples();
    assert_eq!(samples.len(), 93_680);
    assert!(samples
        .iter()
        .all(|value| value.is_finite() && value.abs() <= 1.));
    assert_eq!(words(REFERENCE).len(), 17);
}

#[test]
fn acceptance_metric_counts_substitution_deletion_and_insertion() {
    assert_eq!(word_error_rate("one two three", "ONE, two three."), 0.);
    for observed in ["one two four", "one three", "one two three four"] {
        assert_eq!(word_error_rate("one two three", observed), 1. / 3.);
    }
    assert_eq!(word_error_rate("one two three", ""), 1.);
}

#[test]
#[ignore = "requires explicit LAZYSH_PARAKEET_TEST_ARCHIVE and Linux native acceptance; never downloads weights"]
fn offline_public_speech_with_reused_recognizer() {
    run_inference_acceptance();
}

#[cfg(not(target_os = "linux"))]
fn run_inference_acceptance() {
    panic!(
        "this acceptance fixture requires Linux; platform storage/runtime acceptance is pending"
    );
}

#[cfg(target_os = "linux")]
fn run_inference_acceptance() {
    use lazysh_parakeet_runtime::{version, Recognizer, VerifiedBundle};
    use std::{fs, os::unix::fs::PermissionsExt, time::Instant};

    fn peak_rss_kib() -> libc::c_long {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // SAFETY: a correctly sized writable rusage is provided; success initializes its fields.
        assert_eq!(
            unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
            0
        );
        // SAFETY: getrusage succeeded. On Linux ru_maxrss is the process lifetime peak in KiB.
        unsafe { usage.assume_init() }.ru_maxrss
    }
    fn ms(start: Instant) -> f64 {
        start.elapsed().as_secs_f64() * 1000.
    }
    fn current_rss_kib() -> u64 {
        let status = fs::read_to_string("/proc/self/status").expect("Linux process memory status");
        let mut value = status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:"))
            .expect("Linux VmRSS")
            .split_whitespace();
        let kib = value.next().unwrap().parse().unwrap();
        assert_eq!(value.next(), Some("kB"));
        kib
    }

    let archive = std::env::var_os("LAZYSH_PARAKEET_TEST_ARCHIVE").expect(
        "set LAZYSH_PARAKEET_TEST_ARCHIVE to the fixed catalog archive; no implicit skip/download",
    );
    let archive = fs::File::open(archive).expect("open explicitly supplied fixed catalog archive");
    let parent = tempfile::Builder::new()
        .prefix("lazysh-parakeet-acceptance-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let samples = speech_samples();
    assert_eq!(version().unwrap(), "2.0.0");
    let baseline_peak = peak_rss_kib();
    let start = Instant::now();
    let bundle =
        VerifiedBundle::read_in(archive, parent.path()).expect("verify/extract fixed catalog");
    let prepare_ms = ms(start);
    eprintln!("Parakeet phase=prepared prepare_ms={prepare_ms:.3}");
    let mut entries = fs::read_dir(parent.path()).unwrap();
    let model_directory = entries.next().unwrap().unwrap().path();
    assert!(entries.next().is_none(), "one owned model extraction");
    assert_eq!(fs::read_dir(&model_directory).unwrap().count(), 4);
    let start = Instant::now();
    let mut recognizer = Recognizer::new(bundle).expect("load verified real CPU model");
    let load_ms = ms(start);
    eprintln!("Parakeet phase=loaded load_ms={load_ms:.3}");
    let loaded_peak = peak_rss_kib();
    let start = Instant::now();
    let first = recognizer
        .transcribe(&samples)
        .expect("first real inference");
    let first_ms = ms(start);
    eprintln!("Parakeet phase=first first_ms={first_ms:.3}");
    let first_peak = peak_rss_kib();
    let start = Instant::now();
    let warm = recognizer
        .transcribe(&samples)
        .expect("repeat on the same recognizer");
    let warm_ms = ms(start);
    eprintln!("Parakeet phase=warm warm_ms={warm_ms:.3}");
    let warm_peak = peak_rss_kib();
    let wer = word_error_rate(REFERENCE, &first);
    println!(
        "Parakeet CPU acceptance arch={} rust_debug_assertions={} native_profile=Release audio_seconds=5.855 prepare_ms={prepare_ms:.3} load_ms={load_ms:.3} first_ms={first_ms:.3} warm_ms={warm_ms:.3} baseline_process_peak_rss_kib={baseline_peak} loaded_process_peak_rss_kib={loaded_peak} first_process_peak_rss_kib={first_peak} warm_process_peak_rss_kib={warm_peak} wer={wer:.6} transcript={first:?}",
        std::env::consts::ARCH, cfg!(debug_assertions)
    );
    assert!(!first.is_empty());
    assert!(
        wer <= 0.10,
        "independent corpus reference WER must be <= 0.10; got {wer}: {first:?}"
    );
    assert_eq!(
        warm, first,
        "repeat inference must remain stable on one model"
    );
    eprintln!("Parakeet phase=warm current_rss_kib={}", current_rss_kib());
    // Observe eight further identical inputs without inventing an allocator-dependent RAM cap.
    // Peak RSS alone cannot distinguish retained allocator pages from continued growth.
    for iteration in 3..=10 {
        let start = Instant::now();
        let repeated = recognizer
            .transcribe(&samples)
            .expect("bounded repeat inference");
        assert_eq!(repeated, first, "stable output at iteration {iteration}");
        eprintln!("Parakeet phase=repeat iteration={iteration} elapsed_ms={:.3} current_rss_kib={} process_peak_rss_kib={}", ms(start), current_rss_kib(), peak_rss_kib());
    }
    assert!(model_directory.is_dir());
    assert_eq!(
        fs::read_dir(parent.path()).unwrap().count(),
        1,
        "no second extraction during inference"
    );
    drop(recognizer);
    eprintln!(
        "Parakeet phase=dropped current_rss_kib={} process_peak_rss_kib={}",
        current_rss_kib(),
        peak_rss_kib()
    );
    assert!(
        !model_directory.exists(),
        "model files removed after native destruction"
    );
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
}
