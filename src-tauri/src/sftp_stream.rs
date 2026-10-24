use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

// russh-sftp accepts u32::MAX frame lengths; validate before it allocates a packet.
pub struct SftpStream<S> {
    inner: S,
    header: [u8; 4],
    received: usize,
    emitted: usize,
    remaining: u32,
    rejected: bool,
}
impl<S> SftpStream<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            header: [0; 4],
            received: 0,
            emitted: 0,
            remaining: 0,
            rejected: false,
        }
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
                match Pin::new(&mut s.inner).poll_read(cx, &mut header) {
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
        match Pin::new(&mut s.inner).poll_read(cx, &mut input) {
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
        Pin::new(&mut self.get_mut().inner).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
