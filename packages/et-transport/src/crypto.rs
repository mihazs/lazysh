// Adapted from AArnott/eternal-terminal-client crypto.rs; see LICENSE-MIT and PROVENANCE.md.
use crate::{Error, Result};
use xsalsa20poly1305::{
    aead::{Aead, KeyInit},
    XSalsa20Poly1305,
};
use zeroize::Zeroizing;

pub(crate) struct Cipher {
    key: Zeroizing<[u8; 32]>,
    nonce: [u8; 24],
    exhausted: bool,
}
impl Cipher {
    pub fn new(key: &[u8; 32], direction: u8) -> Self {
        let mut nonce = [0; 24];
        nonce[23] = direction;
        Self {
            key: Zeroizing::new(*key),
            nonce,
            exhausted: false,
        }
    }
    fn advance(&mut self) -> Result<()> {
        if self.exhausted {
            return Err(Error::Protocol("ET nonce exhausted"));
        }
        for value in &mut self.nonce[..23] {
            *value = value.wrapping_add(1);
            if *value != 0 {
                return Ok(());
            }
        }
        self.exhausted = true;
        Err(Error::Protocol("ET nonce exhausted"))
    }
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        self.advance()?;
        XSalsa20Poly1305::new((&*self.key).into())
            .encrypt((&self.nonce).into(), plaintext)
            .map_err(|_| Error::Authentication)
    }
    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.len() < 16 {
            return Err(Error::Authentication);
        }
        self.advance()?;
        XSalsa20Poly1305::new((&*self.key).into())
            .decrypt((&self.nonce).into(), ciphertext)
            .map_err(|_| Error::Authentication)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direction_counters_advance_and_corrupt_packets_fail() {
        let key = [7; 32];
        let mut send = Cipher::new(&key, 0);
        let mut receive = Cipher::new(&key, 0);
        let first = send.encrypt(b"hello").unwrap();
        let second = send.encrypt(b"hello").unwrap();
        assert_ne!(first, second);
        assert_eq!(receive.decrypt(&first).unwrap(), b"hello");
        assert_eq!(receive.decrypt(&second).unwrap(), b"hello");
        assert!(Cipher::new(&key, 1).decrypt(&first).is_err());
        let mut corrupt = first;
        corrupt[0] ^= 1;
        assert!(Cipher::new(&key, 0).decrypt(&corrupt).is_err());
    }
    #[test]
    fn counter_exhaustion_cannot_enter_the_other_direction() {
        let mut cipher = Cipher::new(&[0; 32], 0);
        cipher.nonce[..23].fill(255);
        assert!(cipher.encrypt(b"no").is_err());
        assert!(cipher.encrypt(b"still no").is_err());
        assert_eq!(cipher.nonce[23], 0);
    }
}
