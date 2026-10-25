use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const CHUNK: usize = 2048;
const LIMIT: usize = 128 * 1024;

pub(crate) trait Store {
    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, key: &str, value: &[u8]) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Generation {
    id: String,
    parts: usize,
    len: usize,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u8,
    active: Option<Generation>,
    pending: Vec<Generation>,
}

fn manifest(store: &impl Store, key: &str) -> Result<Manifest, String> {
    let Some(bytes) = store.read(key)? else {
        return Ok(Manifest {
            version: 1,
            ..Default::default()
        });
    };
    if bytes.len() > CHUNK {
        return Err("Invalid credential manifest".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid credential manifest")?;
    if manifest.version != 1 || manifest.pending.len() > 2 {
        return Err("Unsupported credential manifest".into());
    }
    let mut generations = std::collections::HashSet::new();
    for generation in manifest.active.iter().chain(&manifest.pending) {
        if generation.id.len() != 32
            || !generation.id.bytes().all(|c| c.is_ascii_hexdigit())
            || generation.len > LIMIT
            || generation.parts != generation.len.div_ceil(CHUNK)
            || generation.parts == 0
            || !generations.insert(&generation.id)
        {
            return Err("Invalid credential generation".into());
        }
    }
    Ok(manifest)
}

fn part(key: &str, generation: &Generation, index: usize) -> String {
    format!("{key}.{}.{}", generation.id, index)
}
fn write_manifest(store: &impl Store, key: &str, manifest: &Manifest) -> Result<(), String> {
    let bytes = serde_json::to_vec(manifest).map_err(|_| "Cannot encode credential manifest")?;
    if bytes.len() > CHUNK {
        return Err("Credential manifest exceeds storage limit".into());
    }
    store.write(key, &bytes)
}
fn cleanup(store: &impl Store, key: &str, manifest: &mut Manifest) -> Result<(), String> {
    if manifest.pending.is_empty() {
        return Ok(());
    }
    for generation in &manifest.pending {
        for index in 0..generation.parts {
            store.remove(&part(key, generation, index))?;
        }
    }
    manifest.pending.clear();
    write_manifest(store, key, manifest)
}

pub(crate) fn get(store: &impl Store, key: &str) -> Result<Option<String>, String> {
    let manifest = manifest(store, key)?;
    let Some(generation) = manifest.active else {
        return Ok(None);
    };
    let mut bytes = Zeroizing::new(Vec::with_capacity(generation.len));
    for index in 0..generation.parts {
        let chunk = Zeroizing::new(
            store
                .read(&part(key, &generation, index))?
                .ok_or("Saved credential is incomplete")?,
        );
        let expected = if index + 1 == generation.parts {
            generation.len - index * CHUNK
        } else {
            CHUNK
        };
        if chunk.len() != expected {
            return Err("Invalid saved credential chunk".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes.to_vec())
        .map(Some)
        .map_err(|_| "Invalid saved credential encoding".into())
}

pub(crate) fn set(store: &impl Store, key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > LIMIT {
        return Err("Invalid credential size".into());
    }
    let mut manifest = manifest(store, key)?;
    cleanup(store, key, &mut manifest)?;
    let next = Generation {
        id: uuid::Uuid::new_v4().simple().to_string(),
        parts: value.len().div_ceil(CHUNK),
        len: value.len(),
    };
    // Journal every generation before writing chunks so failed writes remain deletable.
    manifest.pending.push(next.clone());
    write_manifest(store, key, &manifest)?;
    for (index, chunk) in value.as_bytes().chunks(CHUNK).enumerate() {
        store.write(&part(key, &next, index), chunk)?;
    }
    manifest.pending.clear();
    if let Some(previous) = manifest.active.replace(next) {
        manifest.pending.push(previous);
    }
    write_manifest(store, key, &manifest)?;
    cleanup(store, key, &mut manifest)
}

pub(crate) fn delete(store: &impl Store, key: &str) -> Result<(), String> {
    let manifest = manifest(store, key)?;
    for generation in manifest.active.iter().chain(&manifest.pending) {
        for index in 0..generation.parts {
            store.remove(&part(key, generation, index))?;
        }
    }
    store.remove(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
    };
    #[derive(Default)]
    struct Memory {
        data: RefCell<HashMap<String, Vec<u8>>>,
        fail: Cell<Option<usize>>,
        calls: Cell<usize>,
    }
    impl Memory {
        fn operation(&self) -> Result<(), String> {
            let call = self.calls.get() + 1;
            self.calls.set(call);
            if self.fail.get() == Some(call) {
                Err("Fixture storage failure".into())
            } else {
                Ok(())
            }
        }
    }
    impl Store for Memory {
        fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
            self.operation()?;
            Ok(self.data.borrow().get(key).cloned())
        }
        fn write(&self, key: &str, value: &[u8]) -> Result<(), String> {
            self.operation()?;
            assert!(value.len() <= CHUNK);
            self.data.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), String> {
            self.operation()?;
            self.data.borrow_mut().remove(key);
            Ok(())
        }
    }
    #[test]
    fn large_unicode_secrets_roundtrip_and_cleanup() {
        let store = Memory::default();
        let value = "rsa-private-key-世界".repeat(1000);
        set(&store, "host", &value).unwrap();
        assert_eq!(get(&store, "host").unwrap(), Some(value));
        set(&store, "host", "replacement").unwrap();
        assert_eq!(store.data.borrow().len(), 2);
        delete(&store, "host").unwrap();
        assert!(store.data.borrow().is_empty());
    }
    #[test]
    fn failed_updates_never_publish_partial_values_and_all_generations_remain_deletable() {
        for fail in 1..24 {
            let store = Memory::default();
            set(&store, "host", "old secret").unwrap();
            store.calls.set(0);
            store.fail.set(Some(fail));
            let next = "new secret".repeat(1000);
            let _ = set(&store, "host", &next);
            store.fail.set(None);
            let actual = get(&store, "host").unwrap().unwrap();
            assert!(actual == "old secret" || actual == next);
            delete(&store, "host").unwrap();
            assert!(
                store.data.borrow().is_empty(),
                "orphaned generation at failure {fail}"
            );
        }
    }
    #[test]
    fn partial_initial_writes_remain_deletable() {
        for fail in 1..12 {
            let store = Memory::default();
            store.fail.set(Some(fail));
            let _ = set(&store, "host", &"secret".repeat(1000));
            store.fail.set(None);
            delete(&store, "host").unwrap();
            assert!(
                store.data.borrow().is_empty(),
                "orphaned initial generation at failure {fail}"
            );
        }
    }
}
