use std::{
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, Waker},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

// russh-sftp accepts u32::MAX frame lengths; validate before it allocates a packet.
pub struct SftpStream<S> {
    inner: Option<S>,
    header: [u8; 4],
    received: usize,
    emitted: usize,
    remaining: u32,
    rejected: bool,
    stop: Option<Pin<Box<dyn Future<Output = ()> + Send>>>,
    reader: Option<Waker>,
    writer: Option<Waker>,
    // Release upload capacity only after both upstream IO halves have retired.
    _retained: Option<Arc<dyn Send + Sync>>,
}
impl<S> SftpStream<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner: Some(inner),
            header: [0; 4],
            received: 0,
            emitted: 0,
            remaining: 0,
            rejected: false,
            stop: None,
            reader: None,
            writer: None,
            _retained: None,
        }
    }
    pub(crate) fn with_cancellation(
        inner: S,
        stop: Pin<Box<dyn Future<Output = ()> + Send>>,
        retained: Arc<dyn Send + Sync>,
    ) -> Self {
        Self {
            stop: Some(stop),
            _retained: Some(retained),
            ..Self::new(inner)
        }
    }
    fn stopped(&mut self, cx: &mut Context<'_>, reading: bool) -> bool {
        if self.stop.is_none() {
            return self.inner.is_none();
        }
        if reading {
            self.reader = Some(cx.waker().clone());
        } else {
            self.writer = Some(cx.waker().clone());
        }
        if self
            .stop
            .as_mut()
            .is_some_and(|stop| stop.as_mut().poll(cx).is_ready())
        {
            // Upstream may be stuck inside write_all and unable to consume its
            // queued close sentinel. Drop this transport independently of it.
            self.inner.take();
            self.stop.take();
            for waker in [self.reader.take(), self.writer.take()]
                .into_iter()
                .flatten()
            {
                waker.wake();
            }
        }
        self.inner.is_none()
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for SftpStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if out.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let s = self.get_mut();
        if s.stopped(cx, true) {
            return Poll::Ready(Ok(()));
        }
        if s.rejected {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Invalid SFTP frame",
            )));
        }
        if s.remaining == 0 && s.emitted == 4 {
            s.received = 0;
            s.emitted = 0;
        }
        if s.received < 4 {
            loop {
                let mut header = ReadBuf::new(&mut s.header[s.received..]);
                match Pin::new(s.inner.as_mut().unwrap()).poll_read(cx, &mut header) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                    Poll::Ready(Ok(())) => {
                        let n = header.filled().len();
                        if n == 0 {
                            return if s.received == 0 {
                                Poll::Ready(Ok(()))
                            } else {
                                Poll::Ready(Err(io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "Partial SFTP frame header",
                                )))
                            };
                        }
                        s.received += n;
                        if s.received == 4 {
                            break;
                        }
                    }
                }
            }
            s.remaining = u32::from_be_bytes(s.header);
            if s.remaining == 0 || s.remaining > 262144 {
                s.rejected = true;
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "SFTP frame exceeds 256 KiB",
                )));
            }
        }
        if s.emitted < 4 {
            let n = (4 - s.emitted).min(out.remaining());
            out.put_slice(&s.header[s.emitted..s.emitted + n]);
            s.emitted += n;
            return Poll::Ready(Ok(()));
        }
        let mut buffer = [0u8; 16384];
        let n = (s.remaining as usize)
            .min(out.remaining())
            .min(buffer.len());
        let mut input = ReadBuf::new(&mut buffer[..n]);
        match Pin::new(s.inner.as_mut().unwrap()).poll_read(cx, &mut input) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Ready(Ok(())) => {
                let bytes = input.filled();
                if bytes.is_empty() {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "Partial SFTP frame",
                    )));
                }
                s.remaining -= bytes.len() as u32;
                out.put_slice(bytes);
                Poll::Ready(Ok(()))
            }
        }
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for SftpStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let s = self.get_mut();
        if s.stopped(cx, false) {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "SFTP transfer stopped",
            )));
        }
        Pin::new(s.inner.as_mut().unwrap()).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().finish_io(cx, false)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().finish_io(cx, true)
    }
}

impl<S: AsyncWrite + Unpin> SftpStream<S> {
    fn finish_io(&mut self, cx: &mut Context<'_>, shutdown: bool) -> Poll<io::Result<()>> {
        if self.stopped(cx, false) {
            return Poll::Ready(Ok(()));
        }
        let inner = Pin::new(self.inner.as_mut().unwrap());
        if shutdown {
            inner.poll_shutdown(cx)
        } else {
            inner.poll_flush(cx)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn cancellation_wakes_distinct_reader_and_writer_tasks() {
        use std::{
            sync::atomic::{AtomicUsize, Ordering},
            task::Wake,
        };
        struct Counter(AtomicUsize);
        impl Wake for Counter {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let (cancel, mut cancellation) = tokio::sync::watch::channel(false);
        let (client, _peer) = tokio::io::duplex(1);
        let stream = SftpStream::with_cancellation(
            client,
            Box::pin(async move {
                let _ = cancellation.changed().await;
            }),
            Arc::new(()),
        );
        let (mut reader, mut writer) = tokio::io::split(stream);
        let reading = Arc::new(Counter(AtomicUsize::new(0)));
        let writing = Arc::new(Counter(AtomicUsize::new(0)));
        let read_waker = Waker::from(reading.clone());
        let write_waker = Waker::from(writing.clone());
        let mut read_context = Context::from_waker(&read_waker);
        let mut write_context = Context::from_waker(&write_waker);
        let mut bytes = [0; 4];
        let mut buffer = ReadBuf::new(&mut bytes);
        assert!(Pin::new(&mut reader)
            .poll_read(&mut read_context, &mut buffer)
            .is_pending());
        assert!(Pin::new(&mut writer)
            .poll_write(&mut write_context, &[1])
            .is_ready());
        assert!(Pin::new(&mut writer)
            .poll_write(&mut write_context, &[2])
            .is_pending());
        cancel.send_replace(true);
        assert!(writing.0.load(Ordering::SeqCst) > 0);
        assert!(matches!(
            Pin::new(&mut writer).poll_write(&mut write_context, &[2]),
            Poll::Ready(Err(_))
        ));
        assert!(
            reading.0.load(Ordering::SeqCst) > 0,
            "the read task must also wake when the cancellation future last registered the writer"
        );
        assert!(matches!(
            Pin::new(&mut reader).poll_read(&mut read_context, &mut buffer),
            Poll::Ready(Ok(()))
        ));
        assert!(buffer.filled().is_empty());
    }
    #[tokio::test]
    async fn oversized_header_is_rejected_before_exposing_length() {
        let (mut producer, consumer) = tokio::io::duplex(16);
        producer.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
        let mut guarded = SftpStream::new(consumer);
        let mut header = [0; 4];
        assert_eq!(
            guarded.read_exact(&mut header).await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(header, [0; 4]);
        assert!(guarded.read_exact(&mut header).await.is_err());
        assert_eq!(header, [0; 4]);
    }
    #[tokio::test]
    async fn fragmented_headers_and_multiple_frames_preserve_bytes() {
        let (mut producer, consumer) = tokio::io::duplex(3);
        let bytes = [0, 0, 0, 3, 1, 2, 3, 0, 0, 0, 1, 9];
        tokio::spawn(async move {
            for byte in bytes {
                producer.write_all(&[byte]).await.unwrap();
            }
            producer.shutdown().await.unwrap();
        });
        let mut guarded = SftpStream::new(consumer);
        let mut received = Vec::new();
        guarded.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, bytes);
    }
}
