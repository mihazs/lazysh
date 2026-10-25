use super::*;
use bzip2::{write::BzEncoder, Compression};
use std::io::Cursor;
use std::os::unix::fs::PermissionsExt;

fn private_directory() -> TempDir {
    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

fn archive(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
    let mut tar = tar::Builder::new(BzEncoder::new(Vec::new(), Compression::fast()));
    for (path, bytes, kind) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_size(bytes.len() as u64);
        header.set_entry_type(*kind);
        if kind.is_symlink() {
            header.set_link_name("/outside").unwrap();
        }
        header.set_cksum();
        tar.append_data(&mut header, *path, Cursor::new(*bytes))
            .unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}
fn fixture_entries() -> Vec<(String, Vec<u8>, tar::EntryType)> {
    FILES
        .iter()
        .enumerate()
        .map(|(i, (name, _, _))| {
            (
                format!("{PREFIX}/{name}"),
                vec![i as u8; 8],
                tar::EntryType::Regular,
            )
        })
        .collect()
}
fn prepare_fixture(
    entries: &[(String, Vec<u8>, tar::EntryType)],
) -> Result<(VerifiedBundle, TempDir), Error> {
    let source: Vec<_> = entries
        .iter()
        .map(|(name, data, kind)| (name.as_str(), data.as_slice(), *kind))
        .collect();
    let bytes = archive(&source);
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let data_hashes: Vec<_> = (0..4)
        .map(|i| format!("{:x}", Sha256::digest(vec![i as u8; 8])))
        .collect();
    let files = std::array::from_fn(|i| (FILES[i].0, 8, Some(data_hashes[i].as_str())));
    let parent = private_directory();
    let bundle = prepare(
        Cursor::new(&bytes),
        parent.path(),
        &Catalog {
            bytes: bytes.len() as u64,
            sha256: &hash,
            files: &files,
        },
    )?;
    Ok((bundle, parent))
}
#[test]
fn public_boundary_refuses_every_non_catalog_archive_without_extraction() {
    let root = private_directory();
    let source = archive(&[]);
    assert!(matches!(
        VerifiedBundle::read_in(Cursor::new(source), root.path()),
        Err(Error::InvalidBundle)
    ));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
#[test]
fn unsafe_storage_fails_before_reading_any_model_bytes() {
    struct NoRead;
    impl Read for NoRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("unsafe storage must fail before consuming the archive")
        }
    }
    let root = private_directory();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(matches!(
        VerifiedBundle::read_in(NoRead, root.path()),
        Err(Error::Storage)
    ));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
#[test]
fn authenticated_fixed_files_remain_owned_then_are_removed_on_drop() {
    let (bundle, _parent) = prepare_fixture(&fixture_entries()).unwrap();
    let path = bundle.directory.path().to_owned();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for file in bundle.files() {
        assert_eq!(std::fs::read(file).unwrap().len(), 8);
    }
    drop(bundle);
    assert!(!path.exists());
}
#[test]
fn duplicate_missing_oversized_and_wrong_content_entries_fail() {
    let mut duplicate = fixture_entries();
    duplicate.push(duplicate[0].clone());
    assert!(prepare_fixture(&duplicate).is_err());
    let mut missing = fixture_entries();
    missing.pop();
    assert!(prepare_fixture(&missing).is_err());
    let mut oversized = fixture_entries();
    oversized[0].1.push(0);
    assert!(prepare_fixture(&oversized).is_err());
    let mut wrong = fixture_entries();
    wrong[1].1[0] = 99;
    assert!(prepare_fixture(&wrong).is_err());
}
#[test]
fn links_and_paths_outside_the_fixed_bundle_are_never_extracted() {
    let mut link = fixture_entries();
    link[0].2 = tar::EntryType::Symlink;
    assert!(prepare_fixture(&link).is_err());
    let mut outside = fixture_entries();
    outside[0].0 = "other/encoder.int8.onnx".into();
    assert!(prepare_fixture(&outside).is_err());
}
#[test]
fn spool_reader_stops_at_the_fixed_byte_budget_and_deletes_its_private_copy() {
    struct Counting {
        read: usize,
    }
    impl Read for Counting {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            self.read += out.len();
            out.fill(0);
            Ok(out.len())
        }
    }
    let mut reader = Counting { read: 0 };
    let root = private_directory();
    assert!(prepare(
        &mut reader,
        root.path(),
        &Catalog {
            bytes: 8,
            sha256: "invalid",
            files: &FILES
        }
    )
    .is_err());
    assert_eq!(reader.read, 9);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
