use russh::keys::{
    signature::Signer,
    ssh_encoding::Encode,
    ssh_key::{private::KeypairData, Signature},
    HashAlg, PrivateKey,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{watch, Semaphore},
    time::timeout,
};

const MAX_FRAME: usize = 256 * 1024;
const MAX_CHANNELS: usize = 4;
const MAX_REQUESTS: usize = 1024;

#[derive(Clone)]
pub(crate) struct ForwardAgent {
    key: Arc<Mutex<Option<Arc<PrivateKey>>>>,
    slots: Arc<Semaphore>,
    requests: Arc<AtomicUsize>,
    closed: watch::Sender<bool>,
}
impl Default for ForwardAgent {
    fn default() -> Self {
        let (closed, _) = watch::channel(false);
        Self {
            key: Arc::new(Mutex::new(None)),
            slots: Arc::new(Semaphore::new(MAX_CHANNELS)),
            requests: Arc::new(AtomicUsize::new(0)),
            closed,
        }
    }
}
impl ForwardAgent {
    pub(crate) fn enable(&self, key: Arc<PrivateKey>) {
        if let Ok(mut selected) = self.key.lock() {
            *selected = Some(key);
        }
    }
    pub(crate) fn enabled(&self) -> bool {
        !*self.closed.borrow() && self.key.lock().is_ok_and(|key| key.is_some())
    }
    pub(crate) fn close(&self) {
        self.closed.send_replace(true);
        if let Ok(mut key) = self.key.lock() {
            *key = None;
        }
    }
    pub(crate) async fn accept(
        &self,
        channel: russh::Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
    ) {
        if !self.enabled() {
            return;
        }
        let Ok(slot) = self.slots.clone().try_acquire_owned() else {
            return;
        };
        reply.accept().await;
        let agent = self.clone();
        tauri::async_runtime::spawn(async move {
            let _slot = slot;
            let _ = agent.serve(channel.into_stream()).await;
        });
    }
    async fn serve<S: AsyncRead + AsyncWrite + Unpin>(&self, mut stream: S) -> std::io::Result<()> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow() {
            return Ok(());
        }
        let result = tokio::select! {
            _ = closed.changed() => Ok(()),
            result = async {
                loop {
                    let length = match timeout(Duration::from_secs(300), stream.read_u32()).await {
                        Ok(Ok(length)) => length as usize,
                        Ok(Err(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                        Ok(Err(error)) => return Err(error),
                        Err(_) => return Ok(()),
                    };
                    if length == 0 || length > MAX_FRAME { return Err(std::io::Error::other("Invalid agent frame length")); }
                    if self.requests.fetch_add(1, Ordering::Relaxed) >= MAX_REQUESTS { return Ok(()); }
                    let mut request = vec![0; length];
                    timeout(Duration::from_secs(30), stream.read_exact(&mut request)).await.map_err(|_| std::io::Error::other("Agent request timed out"))??;
                    let key = self.key.lock().map_err(|_| std::io::Error::other("Agent closed"))?.clone();
                    let response = match key {
                        Some(key) => tokio::task::spawn_blocking(move || response(&key, &request)).await.map_err(|_| std::io::Error::other("Agent signing failed"))?,
                        None => vec![5],
                    };
                    timeout(Duration::from_secs(30), async {
                        stream.write_u32(response.len() as u32).await?;
                        stream.write_all(&response).await?;
                        stream.flush().await
                    }).await.map_err(|_| std::io::Error::other("Agent response timed out"))??;
                }
            } => result,
        };
        let _ = stream.shutdown().await;
        result
    }
}

fn string<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
    let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let value = bytes.get(4..4usize.checked_add(length)?)?;
    *bytes = &bytes[4 + length..];
    Some(value)
}
fn append_string(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&(value.len() as u32).to_be_bytes());
    output.extend_from_slice(value);
}

fn response(key: &PrivateKey, frame: &[u8]) -> Vec<u8> {
    try_response(key, frame).unwrap_or_else(|| vec![5])
}
fn try_response(key: &PrivateKey, frame: &[u8]) -> Option<Vec<u8>> {
    if frame.len() > MAX_FRAME {
        return None;
    }
    let (&kind, mut input) = frame.split_first()?;
    let public = key.public_key().to_bytes().ok()?;
    match kind {
        11 if input.is_empty() => {
            let mut output = vec![12];
            output.extend_from_slice(&1u32.to_be_bytes());
            append_string(&mut output, &public);
            append_string(&mut output, b"lazysh selected identity");
            Some(output)
        }
        13 => {
            if string(&mut input)? != public {
                return None;
            }
            let data = string(&mut input)?;
            let flags = u32::from_be_bytes(input.try_into().ok()?);
            let signature: Signature = match key.key_data() {
                KeypairData::Rsa(rsa) => {
                    let hash = match flags {
                        2 => HashAlg::Sha256,
                        4 => HashAlg::Sha512,
                        _ => return None,
                    };
                    (rsa, Some(hash)).try_sign(data).ok()?
                }
                _ if flags == 0 => key.try_sign(data).ok()?,
                _ => return None,
            };
            let mut encoded = Vec::new();
            signature.encode(&mut encoded).ok()?;
            let mut output = vec![14];
            append_string(&mut output, &encoded);
            Some(output)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{signature::Verifier, ssh_encoding::Decode, Algorithm};
    fn key() -> PrivateKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
    }
    fn sign_request(key: &PrivateKey, data: &[u8], flags: u32) -> Vec<u8> {
        let mut frame = vec![13];
        append_string(&mut frame, &key.public_key().to_bytes().unwrap());
        append_string(&mut frame, data);
        frame.extend_from_slice(&flags.to_be_bytes());
        frame
    }
    #[test]
    fn lists_only_selected_identity_and_signatures_verify() {
        let key = key();
        let identities = response(&key, &[11]);
        assert_eq!(identities[0], 12);
        assert_eq!(&identities[1..5], &1u32.to_be_bytes());
        let mut payload = &identities[5..];
        assert_eq!(
            string(&mut payload).unwrap(),
            key.public_key().to_bytes().unwrap()
        );
        let signature = response(&key, &sign_request(&key, b"challenge", 0));
        assert_eq!(signature[0], 14);
        let mut payload = &signature[1..];
        let mut encoded = string(&mut payload).unwrap();
        let signature = Signature::decode(&mut encoded).unwrap();
        key.public_key()
            .key_data()
            .verify(b"challenge", &signature)
            .unwrap();
    }
    #[test]
    fn rejects_other_keys_mutations_trailing_bytes_and_unsupported_flags() {
        let key = key();
        let other = self::key();
        for kind in [17, 18, 19, 20, 21, 22, 23, 25, 26, 27] {
            assert_eq!(response(&key, &[kind]), [5]);
        }
        assert_eq!(response(&key, &[11, 0]), [5]);
        assert_eq!(response(&key, &sign_request(&other, b"challenge", 0)), [5]);
        assert_eq!(response(&key, &sign_request(&key, b"challenge", 2)), [5]);
        assert_eq!(response(&key, &[13, 255, 255, 255, 255]), [5]);
    }
    #[test]
    fn rsa_requires_explicit_sha2_and_honors_requested_hash() {
        let key = PrivateKey::from_openssh(include_str!("../tests/fixtures/agent_rsa")).unwrap();
        for (flags, hash) in [(2, HashAlg::Sha256), (4, HashAlg::Sha512)] {
            let output = response(&key, &sign_request(&key, b"rsa challenge", flags));
            assert_eq!(output[0], 14);
            let mut payload = &output[1..];
            let mut encoded = string(&mut payload).unwrap();
            let signature = Signature::decode(&mut encoded).unwrap();
            assert_eq!(signature.algorithm(), Algorithm::Rsa { hash: Some(hash) });
            key.public_key()
                .key_data()
                .verify(b"rsa challenge", &signature)
                .unwrap();
        }
        for flags in [0, 1, 3, 6] {
            assert_eq!(
                response(&key, &sign_request(&key, b"rsa challenge", flags)),
                [5]
            );
        }
    }
    #[tokio::test]
    async fn disabled_by_default_bounded_before_allocation_and_closes_active_streams() {
        let agent = ForwardAgent::default();
        assert!(!agent.enabled());
        agent.enable(Arc::new(key()));
        assert!(agent.enabled());
        let (mut client, server) = tokio::io::duplex(16);
        let serving = agent.clone();
        let task = tokio::spawn(async move { serving.serve(server).await });
        client.write_u32(u32::MAX).await.unwrap();
        assert!(task.await.unwrap().is_err());
        let (mut client, server) = tokio::io::duplex(16);
        let serving = agent.clone();
        let task = tokio::spawn(async move { serving.serve(server).await });
        client.write_u32(1).await.unwrap();
        client.write_all(&[11]).await.unwrap();
        assert!(client.read_u32().await.unwrap() > 1);
        agent.close();
        assert!(!agent.enabled());
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(agent.key.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn request_budget_is_shared_between_forwarded_channels() {
        let agent = ForwardAgent::default();
        agent.enable(Arc::new(key()));
        agent.requests.store(MAX_REQUESTS - 1, Ordering::Relaxed);
        let (mut client, server) = tokio::io::duplex(4096);
        let serving = agent.clone();
        let first = tokio::spawn(async move { serving.serve(server).await });
        client.write_u32(1).await.unwrap();
        client.write_all(&[11]).await.unwrap();
        let length = client.read_u32().await.unwrap();
        let mut response = vec![0; length as usize];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(response[0], 12);
        let (mut other, server) = tokio::io::duplex(4096);
        let serving = agent.clone();
        let second = tokio::spawn(async move { serving.serve(server).await });
        other.write_u32(1).await.unwrap();
        other.write_all(&[11]).await.unwrap();
        timeout(Duration::from_secs(2), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(other.read_u32().await.is_err());
        agent.close();
        timeout(Duration::from_secs(2), first)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
