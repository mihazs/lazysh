use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

/// Result of offering a chunk. Rejected chunks are handed back, never dropped.
#[derive(Debug, PartialEq, Eq)]
pub enum Offer {
    Accepted,
    /// Over budget right now: retry after [`Ingress`] drains and credits are returned.
    Full(Vec<u8>),
    /// Larger than the whole budget; it could never be admitted.
    TooLarge(Vec<u8>),
}

/// Ordered, binary-safe byte queue with a hard byte budget. The budget doubles as the transport
/// credit window: bytes are credited back only after the VT has processed them.
#[derive(Debug)]
pub struct Ingress {
    chunks: VecDeque<Vec<u8>>,
    queued: usize,
    capacity: usize,
}

impl Ingress {
    pub fn new(capacity: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            queued: 0,
            capacity,
        }
    }

    pub fn offer(&mut self, chunk: Vec<u8>) -> Offer {
        if chunk.len() > self.capacity {
            return Offer::TooLarge(chunk);
        }
        if self.queued + chunk.len() > self.capacity {
            return Offer::Full(chunk);
        }
        self.queued += chunk.len();
        if !chunk.is_empty() {
            self.chunks.push_back(chunk);
        }
        Offer::Accepted
    }

    pub fn queued(&self) -> usize {
        self.queued
    }

    pub fn available(&self) -> usize {
        self.capacity - self.queued
    }

    /// Pop whole chunks in arrival order until `budget` bytes were taken (a zero budget takes none).
    /// Chunks are never split, so an escape sequence is never cut by the queue itself.
    pub(crate) fn take(&mut self, budget: usize) -> Vec<Vec<u8>> {
        let mut taken = Vec::new();
        let mut bytes = 0;
        while bytes < budget {
            let Some(chunk) = self.chunks.pop_front() else {
                break;
            };
            bytes += chunk.len();
            taken.push(chunk);
        }
        self.queued -= bytes;
        taken
    }
}

/// Shared producer side of one session's [`Ingress`]: a transport offers bytes without waiting
/// for the VT worker that is parsing earlier ones.
#[derive(Debug, Clone)]
pub struct IngressHandle(Arc<Mutex<Ingress>>);

impl IngressHandle {
    pub(crate) fn new(capacity: usize) -> Self {
        Self(Arc::new(Mutex::new(Ingress::new(capacity))))
    }

    fn with<R>(&self, f: impl FnOnce(&mut Ingress) -> R) -> R {
        f(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }

    pub fn offer(&self, chunk: Vec<u8>) -> Offer {
        self.with(|ingress| ingress.offer(chunk))
    }

    pub fn queued(&self) -> usize {
        self.with(|ingress| ingress.queued())
    }

    pub fn available(&self) -> usize {
        self.with(|ingress| ingress.available())
    }

    pub(crate) fn take(&self, budget: usize) -> Vec<Vec<u8>> {
        self.with(|ingress| ingress.take(budget))
    }

    /// Drop everything queued; returns how many bytes that was (their credit is still owed).
    pub(crate) fn clear(&self) -> usize {
        self.with(|ingress| {
            let queued = ingress.queued;
            ingress.chunks.clear();
            ingress.queued = 0;
            queued
        })
    }
}
