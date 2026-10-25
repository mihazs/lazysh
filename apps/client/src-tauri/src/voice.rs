use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::State;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MAX_MODEL: u64 = 160 * 1024 * 1024;
const MAX_SAMPLES: usize = 16_000 * 30;
type Result<T> = std::result::Result<T, String>;
struct Import {
    id: String,
    name: String,
    file: File,
    bytes: u64,
}
pub struct VoiceState {
    dir: PathBuf,
    import: Mutex<Option<Import>>,
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}
#[derive(Serialize)]
pub struct VoiceModel {
    id: String,
    bytes: u64,
}
impl VoiceState {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        for entry in fs::read_dir(&dir)?.flatten() {
            if entry.path().extension().is_some_and(|e| e == "part") {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(Self {
            dir,
            import: Mutex::new(None),
            busy: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
        })
    }
    fn path(&self, name: &str) -> Result<PathBuf> {
        if !valid_name(name) {
            return Err("Invalid model name".into());
        }
        Ok(self.dir.join(name))
    }
}
fn valid_name(name: &str) -> bool {
    name.len() <= 100
        && name.ends_with(".bin")
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn model_header(path: &Path) -> Result<()> {
    let mut header = [0; 48];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| "Cannot read GGML model header")?;
    let values: Vec<i32> = header[4..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|value| i32::from_le_bytes(*value))
        .collect();
    let tiny = values[2] == 384 && values[3] == 6 && values[4] == 4;
    let base = values[2] == 512 && values[3] == 8 && values[4] == 6;
    if &header[..4] != b"lmgg"
        || !matches!(values[0], 51864 | 51865)
        || values[1] != 1500
        || !(tiny || base)
        || values[5] != 448
        || values[6] != values[2]
        || values[7] != values[3]
        || values[8] != values[4]
        || values[9] != 80
    {
        return Err("Only compatible Whisper tiny/base GGML models are supported".into());
    }
    Ok(())
}
fn list(state: &VoiceState) -> Result<Vec<VoiceModel>> {
    let mut models = Vec::new();
    for entry in fs::read_dir(&state.dir)
        .map_err(|_| "Cannot read model directory")?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "Cannot inspect model")?;
        if valid_name(&name) && metadata.is_file() {
            models.push(VoiceModel {
                id: name,
                bytes: metadata.len(),
            });
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}
#[tauri::command]
pub fn voice_models(state: State<'_, VoiceState>) -> Result<Vec<VoiceModel>> {
    list(&state)
}
fn begin(state: &VoiceState, name: String, bytes: u64) -> Result<String> {
    let destination = state.path(&name)?;
    if !(1024..=MAX_MODEL).contains(&bytes) {
        return Err("Choose a Whisper tiny/base GGML model up to 160 MiB".into());
    }
    if destination.exists() || list(state)?.len() >= 3 {
        return Err("Remove an existing model first (maximum three models; existing models are never overwritten)".into());
    }
    let mut pending = state
        .import
        .lock()
        .map_err(|_| "Model import lock failed")?;
    if pending.is_some() {
        return Err("Finish or cancel the current model import".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = state.dir.join(format!("{id}.part"));
    let file = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Cannot create model import")?;
    *pending = Some(Import {
        id: id.clone(),
        name,
        file,
        bytes,
    });
    Ok(id)
}
#[tauri::command]
pub fn voice_import_begin(
    state: State<'_, VoiceState>,
    name: String,
    bytes: u64,
) -> Result<String> {
    begin(&state, name, bytes)
}
fn chunk(state: &VoiceState, id: &str, offset: u64, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > 1024 * 1024 {
        return Err("Invalid model chunk size".into());
    }
    let mut pending = state
        .import
        .lock()
        .map_err(|_| "Model import lock failed")?;
    let pending = pending
        .as_mut()
        .filter(|p| p.id == id)
        .ok_or("Model import expired")?;
    let length = pending
        .file
        .metadata()
        .map_err(|_| "Cannot inspect model import")?
        .len();
    if length != offset || offset + bytes.len() as u64 > pending.bytes {
        return Err("Model chunk is out of order or exceeds expected size".into());
    }
    if offset == 0 && !bytes.starts_with(b"lmgg") {
        return Err("This is not a Whisper GGML model".into());
    }
    pending
        .file
        .write_all(bytes)
        .map_err(|_| "Cannot write model import".to_owned())
}
#[tauri::command]
pub fn voice_import_chunk(
    state: State<'_, VoiceState>,
    id: String,
    offset: u64,
    bytes: Vec<u8>,
) -> Result<()> {
    chunk(&state, &id, offset, &bytes)
}
fn finish(state: &VoiceState, id: &str, cancel: bool) -> Result<()> {
    let mut pending = state
        .import
        .lock()
        .map_err(|_| "Model import lock failed")?;
    if !pending.as_ref().is_some_and(|p| p.id == id) {
        return Err("Model import expired".into());
    }
    let import = pending.take().ok_or("Model import expired")?;
    let temporary = state.dir.join(format!("{}.part", import.id));
    let result = (|| {
        if cancel {
            return Ok(());
        }
        if import
            .file
            .metadata()
            .map_err(|_| "Cannot inspect model import")?
            .len()
            != import.bytes
        {
            return Err("Model import is incomplete".into());
        }
        model_header(&temporary)?;
        import.file.sync_all().map_err(|_| "Cannot save model")?;
        // Exclusive linking publishes without replacing an existing model.
        fs::hard_link(&temporary, state.path(&import.name)?)
            .map_err(|_| "Cannot publish model; destination may already exist")?;
        Ok(())
    })();
    drop(import.file);
    let _ = fs::remove_file(temporary);
    result
}
#[tauri::command]
pub fn voice_import_finish(state: State<'_, VoiceState>, id: String, cancel: bool) -> Result<()> {
    finish(&state, &id, cancel)
}
#[tauri::command]
pub fn voice_remove_model(state: State<'_, VoiceState>, id: String) -> Result<()> {
    if state.busy.load(Ordering::Acquire) {
        return Err("Wait for transcription to finish before removing models".into());
    }
    fs::remove_file(state.path(&id)?).map_err(|_| "Cannot remove model".to_owned())
}
fn validate_audio(samples: &[f32], language: &str) -> Result<()> {
    // No logging backend is enabled: suppress native diagnostics that may include dictated text.
    whisper_rs::install_logging_hooks();
    if samples.len() < 1600
        || samples.len() > MAX_SAMPLES
        || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0)
    {
        return Err("Audio must contain 0.1–30 seconds of finite mono 16 kHz samples".into());
    }
    if language != "auto" && whisper_rs::get_lang_id(language).is_none() {
        return Err("Unsupported Whisper language code".into());
    }
    Ok(())
}
struct Abort {
    cancelled: Arc<AtomicBool>,
    started: Instant,
}
struct InferenceGuard(Arc<AtomicBool>);
impl Drop for InferenceGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
unsafe extern "C" fn abort_inference(data: *mut std::ffi::c_void) -> bool {
    let state = unsafe { &*(data as *const Abort) };
    state.cancelled.load(Ordering::Acquire) || state.started.elapsed() > Duration::from_secs(120)
}
fn infer(path: &Path, samples: &[f32], language: &str, cancel: Arc<AtomicBool>) -> Result<String> {
    validate_audio(samples, language)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "Model is unavailable")?;
    if !metadata.is_file() || metadata.len() > MAX_MODEL {
        return Err("Model is unavailable or exceeds the size limit".into());
    }
    model_header(path)?;
    let context = WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|_| "Whisper could not load this model; use a compatible tiny/base GGML model")?;
    if !context.is_multilingual() && language != "en" && language != "auto" {
        return Err(
            "This is an English-only model. Select English or import a multilingual model.".into(),
        );
    }
    if cancel.load(Ordering::Acquire) {
        return Err("Transcription cancelled".into());
    }
    let mut state = context
        .create_state()
        .map_err(|_| "Cannot allocate transcription state")?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(std::thread::available_parallelism().map_or(2, |n| n.get().min(4)) as i32);
    params.set_language(if language == "auto" {
        None
    } else {
        Some(language)
    });
    params.set_translate(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_print_special(false);
    let mut abort = Box::new(Abort {
        cancelled: cancel.clone(),
        started: Instant::now(),
    });
    // The boxed callback state outlives the synchronous full() call and is never mutated by Rust.
    unsafe {
        params.set_abort_callback(Some(abort_inference));
        params.set_abort_callback_user_data((&mut *abort as *mut Abort).cast());
    }
    state
        .full(params, samples)
        .map_err(|_| "Transcription failed, timed out or was cancelled")?;
    if cancel.load(Ordering::Acquire) {
        return Err("Transcription cancelled".into());
    }
    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(
            &segment
                .to_str_lossy()
                .map_err(|_| "Invalid transcription output")?,
        );
        if text.len() > 64 * 1024 {
            return Err("Transcription exceeds the text limit".into());
        }
    }
    Ok(text.trim().to_owned())
}
#[tauri::command]
pub async fn voice_transcribe(
    state: State<'_, VoiceState>,
    id: String,
    samples: Vec<f32>,
    language: String,
) -> Result<String> {
    validate_audio(&samples, &language)?;
    let path = state.path(&id)?;
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("A transcription is already running".into());
    }
    state.cancel.store(false, Ordering::Release);
    let cancel = state.cancel.clone();
    let busy = state.busy.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = InferenceGuard(busy);
        infer(&path, &samples, &language, cancel)
    })
    .await;
    result.map_err(|_| "Transcription worker failed".to_string())?
}
#[tauri::command]
pub fn voice_cancel(state: State<'_, VoiceState>) {
    state.cancel.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_import_is_bounded_ordered_exclusive_and_removable() {
        let dir = tempfile::tempdir().unwrap();
        let state = VoiceState::new(dir.path().to_owned()).unwrap();
        assert!(begin(&state, "../model.bin".into(), 1024).is_err());
        assert!(begin(&state, "base.bin".into(), MAX_MODEL + 1).is_err());
        let id = begin(&state, "base.bin".into(), 1024).unwrap();
        let mut bytes = vec![0; 1024];
        bytes[..4].copy_from_slice(b"lmgg");
        for (index, value) in [51864i32, 1500, 512, 8, 6, 448, 512, 8, 6, 80, 1]
            .iter()
            .enumerate()
        {
            bytes[4 + index * 4..8 + index * 4].copy_from_slice(&value.to_le_bytes());
        }
        assert!(chunk(&state, &id, 4, &bytes).is_err());
        chunk(&state, &id, 0, &bytes).unwrap();
        finish(&state, &id, false).unwrap();
        assert_eq!(list(&state).unwrap()[0].id, "base.bin");
        assert!(begin(&state, "base.bin".into(), 1024).is_err());
        let id = begin(&state, "tiny.bin".into(), 1024).unwrap();
        finish(&state, &id, true).unwrap();
        assert_eq!(list(&state).unwrap().len(), 1);
        let id = begin(&state, "invalid.bin".into(), 1024).unwrap();
        bytes[12..16].copy_from_slice(&i32::MAX.to_le_bytes());
        chunk(&state, &id, 0, &bytes).unwrap();
        assert!(finish(&state, &id, false).is_err());
        assert!(!state.dir.join("invalid.bin").exists());
        assert!(fs::read_dir(&state.dir).unwrap().all(|entry| entry
            .unwrap()
            .path()
            .extension()
            .unwrap()
            != "part"));
    }
    #[test]
    fn invalid_audio_and_models_are_rejected_before_native_inference() {
        assert!(validate_audio(&[0.; 1599], "en").is_err());
        assert!(validate_audio(&vec![f32::NAN; 1600], "en").is_err());
        assert!(validate_audio(&vec![0.; 1600], "not-a-language").is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(infer(
            file.path(),
            &vec![0.; 1600],
            "en",
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
    }
    #[test]
    #[ignore = "requires an explicitly supplied compatible tiny/base GGML model"]
    fn local_whisper_inference_accepts_silence_without_network() {
        let path =
            std::env::var("LAZYSH_WHISPER_TEST_MODEL").expect("set LAZYSH_WHISPER_TEST_MODEL");
        infer(
            Path::new(&path),
            &vec![0.; 16_000],
            "en",
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
    }
    #[test]
    #[ignore = "requires explicitly supplied GGML model and official 16 kHz PCM speech sample"]
    fn local_whisper_transcribes_known_speech_without_network() {
        let model =
            std::env::var("LAZYSH_WHISPER_TEST_MODEL").expect("set LAZYSH_WHISPER_TEST_MODEL");
        let wav = fs::read(
            std::env::var("LAZYSH_WHISPER_TEST_WAV").expect("set LAZYSH_WHISPER_TEST_WAV"),
        )
        .unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let mut offset = 12;
        let mut samples = Vec::new();
        let mut format_valid = false;
        while offset + 8 <= wav.len() {
            let length =
                u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let data = &wav[offset + 8..offset + 8 + length];
            if &wav[offset..offset + 4] == b"fmt " {
                format_valid = data[0..4] == [1, 0, 1, 0]
                    && u32::from_le_bytes(data[4..8].try_into().unwrap()) == 16000
                    && data[14..16] == [16, 0];
            }
            if &wav[offset..offset + 4] == b"data" {
                samples = data
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|s| i16::from_le_bytes(*s) as f32 / 32768.)
                    .collect();
                break;
            }
            offset += 8 + length + (length % 2);
        }
        assert!(format_valid);
        let text = infer(
            Path::new(&model),
            &samples,
            "en",
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(
            text.to_lowercase().contains("ask not what your country"),
            "unexpected speech transcription: {text}"
        );
    }
}
