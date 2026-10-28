//! Explicit Linux acceptance; never downloads or selects an external provider.
use super::*;
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, path::Path, time::Instant};

const REVISION: &str = "d1be6fde11ac6e0407606b4e42fe72d34add8037";

fn checked_bytes(path: &Path, maximum: usize, digest: &str) -> Vec<u8> {
    assert!(fs::symlink_metadata(path).unwrap().is_file());
    let mut bytes = Vec::new();
    fs::File::open(path)
        .unwrap()
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= maximum);
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), digest);
    bytes
}

async fn stop(process: &mut Process) {
    process.0.kill().unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while process.0.try_wait().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Owned child must actually be reaped");
}

fn sample(root: &Path) -> Vec<u8> {
    let bytes = checked_bytes(
        &root.join(format!("whisper.cpp-{REVISION}/samples/jfk.wav")),
        960044,
        "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
    );
    // The pinned sample has a LIST metadata chunk. Copy only its verified PCM;
    // the relay still receives its existing canonical 44-byte WAV layout.
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..16], b"WAVEfmt ");
    let canonical = lazysh_common::audio::pcm16_mono_16khz_header(0);
    assert_eq!(&bytes[16..36], &canonical[16..36]);
    let mut offset = 36;
    while offset + 8 <= bytes.len() {
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let end = offset.checked_add(8 + length).unwrap();
        assert!(end <= bytes.len());
        if &bytes[offset..offset + 4] == b"data" {
            assert_eq!(length % 2, 0);
            let mut wav = lazysh_common::audio::pcm16_mono_16khz_header(length.try_into().unwrap());
            wav.extend_from_slice(&bytes[offset + 8..end]);
            return wav;
        }
        offset = end + length % 2;
    }
    panic!("Pinned sample lacks PCM data");
}

async fn owned_listener(process: &mut Process) -> SocketAddr {
    // Port zero avoids releasing/rebinding an ephemeral reservation. Inspect
    // only this unreaped owned child's descriptors and its network namespace.
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            assert!(
                process.0.try_wait().unwrap().is_none(),
                "Owned engine exited before readiness"
            );
            let process_path = format!("/proc/{}", process.0.id());
            let mut sockets = Vec::new();
            for (index, entry) in fs::read_dir(format!("{process_path}/fd"))
                .unwrap()
                .enumerate()
            {
                assert!(index < 64);
                if let Ok(target) = fs::read_link(entry.unwrap().path()) {
                    let text = target.to_string_lossy();
                    if let Some(inode) = text
                        .strip_prefix("socket:[")
                        .and_then(|value| value.strip_suffix(']'))
                    {
                        sockets.push(inode.to_owned());
                    }
                }
            }
            let mut table = String::new();
            fs::File::open(format!("{process_path}/net/tcp"))
                .unwrap()
                .take(131073)
                .read_to_string(&mut table)
                .unwrap();
            assert!(table.len() <= 131072);
            for line in table.lines().skip(1) {
                let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
                if fields.len() > 9
                    && fields[3] == "0A"
                    && sockets.iter().any(|inode| inode == fields[9])
                {
                    let (ip, port) = fields[1].split_once(':').unwrap();
                    assert_eq!(ip, "0100007F");
                    let port = u16::from_str_radix(port, 16).unwrap();
                    assert_ne!(port, 0);
                    return SocketAddr::from(([127, 0, 0, 1], port));
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Owned engine listener readiness deadline")
}

async fn json(response: reqwest::Response) -> serde_json::Value {
    let bytes = response.bytes().await.unwrap();
    assert!(bytes.len() <= 65536);
    serde_json::from_slice(&bytes).unwrap()
}
async fn register(client: &reqwest::Client, base: &str, token: &str, language: &str) -> String {
    let response = client
        .post(format!("{base}/v1/transcriptions"))
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(format!(r#"{{"language":"{language}"}}"#))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    json(response).await["jobId"].as_str().unwrap().to_owned()
}
async fn usage(client: &reqwest::Client, base: &str, token: &str) -> u64 {
    json(
        client
            .get(format!("{base}/v1/quota"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap(),
    )
    .await["quota"]["deviceUsedSamples"]
        .as_u64()
        .unwrap()
}
fn upload(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    id: &str,
    wav: Vec<u8>,
) -> reqwest::RequestBuilder {
    client
        .put(format!("{base}/v1/transcriptions/{id}/audio"))
        .bearer_auth(token)
        .header("content-type", "audio/wav")
        .body(wav)
}

#[tokio::test]
#[ignore = "requires isolated pinned whisper.cpp v1.9.5/base/JFK fixture; see cloud-transcription.md"]
async fn compiled_relay_transcribes_with_the_real_owned_whisper_engine() {
    tokio::time::timeout(Duration::from_secs(180), acceptance())
        .await
        .expect("Real engine acceptance deadline");
}
async fn acceptance() {
    let root = std::path::PathBuf::from(
        std::env::var_os("LAZYSH_TEST_WHISPER_FIXTURE").expect("Require explicit owned fixture"),
    );
    assert!(root.is_absolute());
    assert!(lazysh_common::fs::owner_only(
        &fs::symlink_metadata(&root).unwrap(),
        true
    ));
    checked_bytes(
        &root.join("source.tar.gz"),
        16 * 1024 * 1024,
        "645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4",
    );
    checked_bytes(
        &root.join("ggml-base.bin"),
        150 * 1024 * 1024,
        "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    );
    let wav = sample(&root);
    let samples = (wav.len() - 44) / 2;
    let started = Instant::now();
    let mut engine = Process(
        Command::new(root.join("build/bin/whisper-server"))
            .current_dir(&root)
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--threads",
                "2",
                "--no-gpu",
                "--no-timestamps",
                "--model",
            ])
            .arg(root.join("ggml-base.bin"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let address = owned_listener(&mut engine).await;
    let fixture = Fixture::new();
    fs::remove_file(fixture.0.path().join("provider")).unwrap();
    let (mut relay, base) = start_relay(fixture.serve_with(
        "300",
        "600",
        "127.0.0.1:0",
        Some(&address.port().to_string()),
    ));
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(50))
        .build()
        .unwrap();
    let response = client
        .post(format!("{base}/v1/devices"))
        .bearer_auth(ADMIN)
        .header("content-type", "application/json")
        .body(r#"{"label":"owned engine acceptance"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let token = json(response).await["token"].as_str().unwrap().to_owned();
    let caps = json(
        client
            .get(format!("{base}/v1/capabilities"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(caps["model"], "whisper.cpp");
    for language in ["auto", "en"] {
        let id = register(&client, &base, &token, language).await;
        let response = upload(&client, &base, &token, &id, wav.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let result = json(response).await;
        let words = result["text"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
            .collect::<String>();
        let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            words.contains("ask not what your country can do for you"),
            "Known public sample phrase missing"
        );
    }
    assert_eq!(usage(&client, &base, &token).await, (samples * 2) as u64);
    // Observe the actual relay debit, then cancel this owned request. This
    // proves relay cancellation, not the instant the model stops computing.
    let id = register(&client, &base, &token, "auto").await;
    let mut long = lazysh_common::audio::pcm16_mono_16khz_header(960000);
    long.extend(wav[44..].iter().copied().cycle().take(960000));
    let pending = upload(&client, &base, &token, &id, long).send();
    let pending = tokio::spawn(pending);
    tokio::time::timeout(Duration::from_secs(5), async {
        while usage(&client, &base, &token).await == (samples * 2) as u64 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let cancellation = client
        .delete(format!("{base}/v1/transcriptions/{id}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(cancellation.status(), 204);
    let response = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 409);
    assert_eq!(json(response).await["error"], "cancelled");
    assert_eq!(
        usage(&client, &base, &token).await,
        (samples * 2 + 480000) as u64
    );
    stop(&mut engine).await;
    let id = register(&client, &base, &token, "en").await;
    let response = upload(&client, &base, &token, &id, wav)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(json(response).await["error"], "provider_unavailable");
    assert_eq!(
        usage(&client, &base, &token).await,
        (samples * 3 + 480000) as u64
    );
    stop(&mut relay).await;
    eprintln!("real_whisper_acceptance: engine=v1.9.5 model=base samples={samples} auto_and_en=true relay_cancel=true stopped_upstream_failure=true elapsed_ms={}", started.elapsed().as_millis());
}
