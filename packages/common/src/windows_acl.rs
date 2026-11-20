//! Whether a Windows file or directory belongs to the current user and cannot be changed (or, for private data, read)
//! by anyone else, decided from its owner SID and its DACL.
//!
//! The decision is a pure function over a [`Descriptor`], so it is built and tested on every operating system. Only
//! the reader that fills a `Descriptor` from a path and the current user's SID needs Windows. The Windows API walks
//! the ACEs itself instead of going through SDDL text, which prints well-known accounts as aliases (`LA` for the
//! built-in Administrator) that would otherwise have to be mapped back to SIDs.

use std::{fs, io, path::Path};

/// The system account.
pub const SYSTEM: &str = "S-1-5-18";
/// The local administrators group. Anything an elevated process creates is owned by it.
pub const ADMINISTRATORS: &str = "S-1-5-32-544";
/// `OWNER RIGHTS`: stands for whoever owns the object, who is checked separately.
pub const OWNER_RIGHTS: &str = "S-1-3-4";

/// Every right that changes an object or its protection: write data and add file, append data and add subdirectory,
/// write extended attributes, delete child, write attributes, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE and
/// GENERIC_ALL. Read, execute and synchronize alone are not in it.
const CHANGE: u32 =
    0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000 | 0x4000_0000 | 0x1000_0000;

/// The rights that let an account remove or rename an object, or hand it to someone else: delete child, DELETE,
/// WRITE_DAC, WRITE_OWNER, GENERIC_WRITE and GENERIC_ALL. Adding a file or subdirectory is not in it.
const REPLACE: u32 = 0x40 | 0x1_0000 | 0x4_0000 | 0x8_0000 | 0x4000_0000 | 0x1000_0000;

/// What other accounts must be unable to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    /// Replace the object or change its protection. Others may still add entries beside the ones that exist, as to a
    /// drive root or a shared folder, and read everything: the check for a directory that merely leads to private data.
    NoForeignReplace,
    /// Change the object or its protection. Reading and running it stay allowed, as for an executable or a directory
    /// that only lists it.
    NoForeignChange,
    /// Any access at all, as for state and secrets.
    Private,
}

/// One access control entry that grants or denies a right.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ace {
    /// The trustee as a SID string such as `S-1-5-32-544`.
    pub sid: String,
    pub mask: u32,
    pub allow: bool,
    /// The entry only applies to children that inherit it, not to this object.
    pub inherit_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub owner: String,
    /// `None` is a NULL DACL, which grants everyone every right.
    pub dacl: Option<Vec<Ace>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    ForeignOwner,
    NullDacl,
    ForeignAccess,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ForeignOwner => "the owner is neither the current user nor an administrator",
            Self::NullDacl => "the object has no access control list",
            Self::ForeignAccess => "another account has access to the object",
        })
    }
}

impl std::error::Error for Refusal {}

/// The system and the administrators already control everything the user can, so their access adds no exposure.
fn trusted(sid: &str, user: &str) -> bool {
    [user, SYSTEM, ADMINISTRATORS, OWNER_RIGHTS]
        .iter()
        .any(|known| sid.eq_ignore_ascii_case(known))
}

/// Admits `descriptor` when `user` or a trusted account owns it and no other account holds an allowed right that
/// `need` forbids.
///
/// Deny entries are ignored: they only remove access, so counting the allows they sit beside is the conservative
/// reading. Inherit-only entries do not apply to the object itself.
pub fn admit(descriptor: &Descriptor, user: &str, need: Need) -> Result<(), Refusal> {
    if !trusted(&descriptor.owner, user) {
        return Err(Refusal::ForeignOwner);
    }
    let aces = descriptor.dacl.as_ref().ok_or(Refusal::NullDacl)?;
    for ace in aces
        .iter()
        .filter(|ace| ace.allow && !ace.inherit_only && !trusted(&ace.sid, user))
    {
        let exposed = match need {
            Need::Private => ace.mask != 0,
            Need::NoForeignChange => ace.mask & CHANGE != 0,
            Need::NoForeignReplace => ace.mask & REPLACE != 0,
        };
        if exposed {
            return Err(Refusal::ForeignAccess);
        }
    }
    Ok(())
}

/// Which kind of object of a managed namespace was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsafe {
    /// A directory is a link, not a directory, owned by another account, or open to change by one.
    Directory,
    /// The executable is a link, not a regular file, owned by another account, or open to access by one.
    Executable,
}

/// Admits a managed namespace: `root`, each of `below` under it in turn, and `executable` in the last one.
/// Directories must be free of foreign change and the executable private, as [`Need`] says. `Ok(true)` when
/// the executable exists and passed, `Ok(false)` when it or a directory above it does not exist yet.
///
/// `admit` decides one existing path, as [`admit_path`] does: an error of kind `NotFound` means it is not there,
/// any other error refuses it, so a path that cannot be read is never admitted. Nothing under a refused or
/// missing directory is looked at.
pub fn admit_namespace(
    root: &Path,
    below: &[&str],
    executable: &str,
    admit: impl Fn(&Path, Need) -> io::Result<()>,
) -> Result<bool, Unsafe> {
    let directory = |path: &Path| match admit(path, Need::NoForeignChange) {
        Ok(()) if is_a(path, fs::FileType::is_dir) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        _ => Err(Unsafe::Directory),
    };
    let mut path = root.to_owned();
    if !directory(&path)? {
        return Ok(false);
    }
    for name in below {
        path.push(name);
        if !directory(&path)? {
            return Ok(false);
        }
    }
    path.push(executable);
    match admit(&path, Need::Private) {
        Ok(()) if is_a(&path, fs::FileType::is_file) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        _ => Err(Unsafe::Executable),
    }
}
/// Whether `path` is itself a file of the kind `of` asks for; a link is not.
fn is_a(path: &Path, of: fn(&fs::FileType) -> bool) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| of(&metadata.file_type()))
}

#[cfg(windows)]
pub use native::{admit_chain, admit_path, current_user, describe};

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        ffi::c_void,
        io,
        os::windows::ffi::OsStrExt,
        path::{Component, Path},
        ptr,
    };

    const SE_FILE_OBJECT: u32 = 1;
    const OWNER_AND_DACL: u32 = 0x1 | 0x4; // OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
    const ACL_SIZE_INFORMATION: u32 = 2;
    const TOKEN_QUERY: u32 = 0x8;
    const TOKEN_USER: u32 = 1;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    // The four ACE types a file DACL may hold; the callback forms keep the prefix read below.
    const ACCESS_ALLOWED: u8 = 0;
    const ACCESS_DENIED: u8 = 1;
    const ACCESS_ALLOWED_CALLBACK: u8 = 9;
    const ACCESS_DENIED_CALLBACK: u8 = 0xA;

    // The two structs mirror their Win32 layouts, so some fields are only ever read by the system.
    #[allow(dead_code)]
    #[repr(C)]
    struct AclSizeInformation {
        ace_count: u32,
        bytes_in_use: u32,
        bytes_free: u32,
    }
    #[allow(dead_code)]
    #[repr(C)]
    struct AceHeader {
        ace_type: u8,
        flags: u8,
        size: u16,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetNamedSecurityInfoW(
            name: *const u16,
            object: u32,
            information: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut c_void,
            sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn GetAclInformation(acl: *mut c_void, data: *mut c_void, length: u32, class: u32) -> i32;
        fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> i32;
        fn ConvertSidToStringSidW(sid: *mut c_void, string: *mut *mut u16) -> i32;
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            data: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// # Safety
    /// `sid` must point to a valid SID.
    unsafe fn sid_string(sid: *mut c_void) -> io::Result<String> {
        let mut text = ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut text) == 0 {
            return Err(io::Error::last_os_error());
        }
        // The API returned a NUL-terminated string that is freed once copied.
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        Ok(value)
    }

    /// The SID of the user this process runs as.
    pub fn current_user() -> io::Result<String> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = (|| {
            let mut needed = 0;
            // The first call only reports the size; it fails with an insufficient-buffer error by design.
            unsafe { GetTokenInformation(token, TOKEN_USER, ptr::null_mut(), 0, &mut needed) };
            if needed == 0 {
                return Err(io::Error::last_os_error());
            }
            // u64 elements keep the buffer aligned for the pointers TOKEN_USER holds.
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let length = needed;
            if unsafe {
                GetTokenInformation(
                    token,
                    TOKEN_USER,
                    buffer.as_mut_ptr().cast(),
                    length,
                    &mut needed,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: TOKEN_USER starts with the user's SID pointer.
            unsafe { sid_string(*buffer.as_ptr().cast::<*mut c_void>()) }
        })();
        unsafe { CloseHandle(token) };
        user
    }

    /// The owner and DACL of `path`, following no link: the caller refuses links first.
    pub fn describe(path: &Path) -> io::Result<Descriptor> {
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let (mut owner, mut dacl, mut security) =
            (ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
        // SAFETY: a NUL-terminated name and out-pointers that the call fills; `security` owns the memory they point into.
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_AND_DACL,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut security,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let descriptor = unsafe { read(owner, dacl) };
        unsafe { LocalFree(security) };
        descriptor
    }

    /// # Safety
    /// `owner` and `dacl` must belong to a live security descriptor.
    unsafe fn read(owner: *mut c_void, dacl: *mut c_void) -> io::Result<Descriptor> {
        if owner.is_null() {
            return Err(io::Error::other("the object has no owner"));
        }
        let owner = sid_string(owner)?;
        if dacl.is_null() {
            return Ok(Descriptor { owner, dacl: None });
        }
        let mut size = AclSizeInformation {
            ace_count: 0,
            bytes_in_use: 0,
            bytes_free: 0,
        };
        if GetAclInformation(
            dacl,
            (&mut size as *mut AclSizeInformation).cast(),
            std::mem::size_of::<AclSizeInformation>() as u32,
            ACL_SIZE_INFORMATION,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut aces = Vec::new();
        for index in 0..size.ace_count {
            let mut ace = ptr::null_mut();
            if GetAce(dacl, index, &mut ace) == 0 {
                return Err(io::Error::last_os_error());
            }
            let header = &*ace.cast::<AceHeader>();
            let allow = match header.ace_type {
                ACCESS_ALLOWED | ACCESS_ALLOWED_CALLBACK => true,
                ACCESS_DENIED | ACCESS_DENIED_CALLBACK => false,
                _ => return Err(io::Error::other("the DACL holds an unsupported entry type")),
            };
            // Header (4 bytes), mask (4 bytes), then the trustee SID.
            let mask = ace.cast::<u8>().add(4).cast::<u32>().read_unaligned();
            let sid = ace.cast::<u8>().add(8).cast::<c_void>();
            aces.push(Ace {
                sid: sid_string(sid)?,
                mask,
                allow,
                inherit_only: header.flags & INHERIT_ONLY_ACE != 0,
            });
        }
        Ok(Descriptor {
            owner,
            dacl: Some(aces),
        })
    }

    /// Admits an existing file or directory that is no link and whose owner and DACL satisfy `need` for the
    /// current user. Parents are the caller's to check, each the same way.
    pub fn admit_path(path: &Path, need: Need) -> io::Result<()> {
        if crate::storage_namespace::is_link(&fs::symlink_metadata(path)?) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the path is a symbolic link, junction or other reparse point",
            ));
        }
        admit(&describe(path)?, &current_user()?, need)
            .map_err(|refusal| io::Error::new(io::ErrorKind::PermissionDenied, refusal))
    }

    /// Admits every directory from `path`'s volume root down to `path`, which must already be canonical: the
    /// directories above it by `NoForeignReplace`, so nobody else can swap one for another, and `path` by `leaf`.
    /// The volume root itself is not read: it cannot be replaced, and a drive's root usually lets any account add
    /// subdirectories.
    pub fn admit_chain(path: &Path, leaf: Need) -> io::Result<()> {
        if !path.has_root() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the path is not absolute",
            ));
        }
        let mut current = std::path::PathBuf::new();
        let mut parts = path.components().peekable();
        while let Some(part) = parts.next() {
            current.push(part);
            match part {
                Component::Prefix(_) | Component::RootDir => {}
                Component::Normal(_) => {
                    if !std::fs::symlink_metadata(&current)?.is_dir() {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "a component of the path is not a directory",
                        ));
                    }
                    admit_path(
                        &current,
                        if parts.peek().is_none() {
                            leaf
                        } else {
                            Need::NoForeignReplace
                        },
                    )?;
                }
                Component::CurDir | Component::ParentDir => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "the path is not canonical",
                    ))
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";
    const OTHER: &str = "S-1-5-21-1004336348-1177238915-682003330-1002";
    const USERS: &str = "S-1-5-32-545";
    const EVERYONE: &str = "S-1-1-0";
    const AUTHENTICATED: &str = "S-1-5-11";
    const FULL: u32 = 0x1f_01ff;
    const MODIFY: u32 = 0x13_01bf;
    const READ_EXECUTE: u32 = 0x12_00a9;

    fn allow(sid: &str, mask: u32) -> Ace {
        Ace {
            sid: sid.into(),
            mask,
            allow: true,
            inherit_only: false,
        }
    }
    fn profile() -> Vec<Ace> {
        vec![
            allow(SYSTEM, FULL),
            allow(ADMINISTRATORS, FULL),
            allow(USER, FULL),
        ]
    }
    fn with(extra: Ace) -> Descriptor {
        let mut aces = profile();
        aces.push(extra);
        Descriptor {
            owner: USER.into(),
            dacl: Some(aces),
        }
    }
    fn both(descriptor: &Descriptor) -> [Result<(), Refusal>; 2] {
        [Need::NoForeignChange, Need::Private].map(|need| admit(descriptor, USER, need))
    }

    #[test]
    fn a_default_user_profile_descriptor_is_private_to_its_owner() {
        let descriptor = Descriptor {
            owner: USER.into(),
            dacl: Some(profile()),
        };
        assert_eq!(both(&descriptor), [Ok(()), Ok(())]);
        // An elevated process creates files owned by the administrators group.
        let administrators = Descriptor {
            owner: ADMINISTRATORS.into(),
            ..descriptor.clone()
        };
        assert_eq!(both(&administrators), [Ok(()), Ok(())]);
        // An empty DACL grants nobody anything, so nobody else can reach it.
        let empty = Descriptor {
            dacl: Some(vec![]),
            ..descriptor
        };
        assert_eq!(both(&empty), [Ok(()), Ok(())]);
    }

    #[test]
    fn another_owner_is_refused_even_with_a_private_dacl() {
        for owner in [OTHER, USERS, EVERYONE, "not-a-sid"] {
            let descriptor = Descriptor {
                owner: owner.into(),
                dacl: Some(profile()),
            };
            assert_eq!(
                both(&descriptor),
                [Err(Refusal::ForeignOwner); 2],
                "{owner}"
            );
        }
    }

    #[test]
    fn a_null_dacl_grants_everyone_everything() {
        let descriptor = Descriptor {
            owner: USER.into(),
            dacl: None,
        };
        assert_eq!(both(&descriptor), [Err(Refusal::NullDacl); 2]);
    }

    #[test]
    fn read_access_for_others_keeps_an_executable_admissible_but_not_private_data() {
        for reader in [USERS, EVERYONE, AUTHENTICATED, OTHER] {
            for mask in [READ_EXECUTE, 0x12_0089, 0x8000_0000, 0xa000_0000, 0x10_0000] {
                assert_eq!(
                    both(&with(allow(reader, mask))),
                    [Ok(()), Err(Refusal::ForeignAccess)],
                    "{reader} {mask:#x}"
                );
            }
        }
    }

    #[test]
    fn any_right_that_changes_the_object_by_another_account_is_refused() {
        // Modify and full control, then each right on its own: write data, append data, write extended attributes,
        // delete child, write attributes, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE and GENERIC_ALL.
        let single = [
            0x2,
            0x4,
            0x10,
            0x40,
            0x100,
            0x1_0000,
            0x4_0000,
            0x8_0000,
            0x4000_0000,
            0x1000_0000,
        ];
        for writer in [USERS, EVERYONE, AUTHENTICATED, OTHER] {
            for mask in [MODIFY, FULL].into_iter().chain(single) {
                assert_eq!(
                    both(&with(allow(writer, mask))),
                    [Err(Refusal::ForeignAccess); 2],
                    "{writer} {mask:#x}"
                );
            }
        }
    }

    #[test]
    fn others_may_add_beside_the_entries_of_a_directory_but_not_replace_or_reprotect_it() {
        let admitted = |descriptor| admit(&descriptor, USER, Need::NoForeignReplace);
        for mask in [0x2, 0x4, 0x6, READ_EXECUTE, READ_EXECUTE | 0x6] {
            assert_eq!(
                admitted(with(allow(AUTHENTICATED, mask))),
                Ok(()),
                "{mask:#x}"
            );
        }
        // Delete child, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE and GENERIC_ALL each, then the usual grants.
        let replace = [0x40, 0x1_0000, 0x4_0000, 0x8_0000, 0x4000_0000, 0x1000_0000];
        for mask in [MODIFY, FULL].into_iter().chain(replace) {
            assert_eq!(
                admitted(with(allow(AUTHENTICATED, mask))),
                Err(Refusal::ForeignAccess),
                "{mask:#x}"
            );
        }
        // Who owns the directory and whether it has a DACL still decide.
        let mut stranger = with(allow(AUTHENTICATED, READ_EXECUTE));
        stranger.owner = OTHER.into();
        assert_eq!(admitted(stranger), Err(Refusal::ForeignOwner));
        let open = Descriptor {
            owner: USER.into(),
            dacl: None,
        };
        assert_eq!(admitted(open), Err(Refusal::NullDacl));
    }

    #[test]
    fn deny_entries_and_inherit_only_entries_do_not_count_as_access() {
        let denied = Ace {
            allow: false,
            ..allow(EVERYONE, FULL)
        };
        let inherited_only = Ace {
            inherit_only: true,
            ..allow(EVERYONE, FULL)
        };
        for extra in [denied, inherited_only] {
            assert_eq!(both(&with(extra)), [Ok(()), Ok(())]);
        }
    }

    #[test]
    fn trusted_accounts_match_without_regard_to_case_and_owner_rights_stands_for_the_owner() {
        let lower = USER.to_ascii_lowercase();
        for sid in [lower.as_str(), OWNER_RIGHTS] {
            assert_eq!(both(&with(allow(sid, FULL))), [Ok(()), Ok(())], "{sid}");
        }
        // The creator-owner template is not a real account, so it is not trusted as one.
        assert_eq!(
            both(&with(allow("S-1-3-0", FULL))),
            [Err(Refusal::ForeignAccess); 2]
        );
    }
}

#[cfg(test)]
mod namespace_tests {
    use super::*;
    use std::{cell::RefCell, path::PathBuf};

    const BELOW: [&str; 2] = ["lazysh", "companion"];
    const EXECUTABLE: &str = "lazysh-agent.exe";

    /// A root holding `lazysh/companion/lazysh-agent.exe`.
    fn namespace() -> (tempfile::TempDir, [PathBuf; 4]) {
        let root = tempfile::tempdir().unwrap();
        let paths = [
            root.path().to_owned(),
            root.path().join("lazysh"),
            root.path().join("lazysh/companion"),
            root.path().join("lazysh/companion").join(EXECUTABLE),
        ];
        fs::create_dir_all(&paths[2]).unwrap();
        fs::write(&paths[3], b"x").unwrap();
        (root, paths)
    }
    /// Walks `root` with an `admit` that follows the filesystem (a missing path is `NotFound`) except for the
    /// paths it refuses, and reports every decision it was asked for.
    fn walk(root: &Path, refused: &[&Path]) -> (Result<bool, Unsafe>, Vec<(PathBuf, Need)>) {
        let asked = RefCell::new(Vec::new());
        let result = admit_namespace(root, &BELOW, EXECUTABLE, |path, need| {
            asked.borrow_mut().push((path.to_owned(), need));
            if refused.contains(&path) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "refused"));
            }
            fs::symlink_metadata(path).map(|_| ())
        });
        (result, asked.into_inner())
    }
    fn paths(asked: &[(PathBuf, Need)]) -> Vec<&Path> {
        asked.iter().map(|(path, _)| path.as_path()).collect()
    }

    #[test]
    fn every_directory_from_the_root_down_is_unchangeable_and_the_executable_is_private() {
        let (_root, all) = namespace();
        let (result, asked) = walk(&all[0], &[]);
        assert_eq!(result, Ok(true));
        assert_eq!(
            paths(&asked),
            all.iter().map(PathBuf::as_path).collect::<Vec<_>>()
        );
        assert_eq!(
            asked.iter().map(|(_, need)| *need).collect::<Vec<_>>(),
            [
                Need::NoForeignChange,
                Need::NoForeignChange,
                Need::NoForeignChange,
                Need::Private
            ]
        );
    }

    #[test]
    fn a_namespace_that_is_not_there_yet_is_admitted_as_absent_and_nothing_under_it_is_read() {
        let (_root, all) = namespace();
        fs::remove_file(&all[3]).unwrap();
        let (result, asked) = walk(&all[0], &[]);
        assert_eq!((result, asked.len()), (Ok(false), 4));
        fs::remove_dir(&all[2]).unwrap();
        let (result, asked) = walk(&all[0], &[]);
        assert_eq!(
            (result, paths(&asked)),
            (Ok(false), all[..3].iter().map(PathBuf::as_path).collect())
        );
        fs::remove_dir(&all[1]).unwrap();
        assert_eq!(walk(&all[0], &[]).0, Ok(false));
        assert_eq!(walk(&all[0].join("absent"), &[]).1.len(), 1);
    }

    #[test]
    fn a_refused_component_is_named_by_its_kind_and_nothing_below_it_is_read() {
        let (_root, all) = namespace();
        for (index, kind) in [
            (0, Unsafe::Directory),
            (1, Unsafe::Directory),
            (2, Unsafe::Directory),
            (3, Unsafe::Executable),
        ] {
            let (result, asked) = walk(&all[0], &[&all[index]]);
            assert_eq!((result, asked.len()), (Err(kind), index + 1), "{index}");
        }
    }

    #[test]
    fn a_file_where_a_directory_belongs_and_a_directory_where_the_executable_belongs_are_refused() {
        let (_root, all) = namespace();
        fs::remove_dir_all(&all[2]).unwrap();
        fs::write(&all[2], b"not a directory").unwrap();
        assert_eq!(walk(&all[0], &[]).0, Err(Unsafe::Directory));
        fs::remove_file(&all[2]).unwrap();
        fs::create_dir_all(&all[3]).unwrap();
        assert_eq!(walk(&all[0], &[]).0, Err(Unsafe::Executable));
    }

    #[test]
    fn a_path_that_cannot_be_read_is_refused_and_never_taken_for_an_absent_one() {
        let (_root, all) = namespace();
        let unreadable = |_: &Path, _| Err(io::Error::other("unreadable"));
        assert_eq!(
            admit_namespace(&all[0], &BELOW, EXECUTABLE, unreadable),
            Err(Unsafe::Directory)
        );
        let unreadable_executable = |path: &Path, _| {
            if path.ends_with(EXECUTABLE) {
                return Err(io::Error::other("unreadable"));
            }
            Ok(())
        };
        assert_eq!(
            admit_namespace(&all[0], &BELOW, EXECUTABLE, unreadable_executable),
            Err(Unsafe::Executable)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_place_of_a_directory_or_the_executable_is_refused_even_when_admit_follows_it()
    {
        let (root, all) = namespace();
        let follows = |path: &Path, _| fs::metadata(path).map(|_| ());
        let elsewhere = root.path().join("elsewhere");
        fs::rename(&all[2], &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &all[2]).unwrap();
        assert_eq!(
            admit_namespace(&all[0], &BELOW, EXECUTABLE, follows),
            Err(Unsafe::Directory)
        );
        fs::remove_file(&all[2]).unwrap();
        fs::rename(&elsewhere, &all[2]).unwrap();
        fs::rename(&all[3], root.path().join("target")).unwrap();
        std::os::unix::fs::symlink(root.path().join("target"), &all[3]).unwrap();
        assert_eq!(
            admit_namespace(&all[0], &BELOW, EXECUTABLE, follows),
            Err(Unsafe::Executable)
        );
    }
}

/// Real ACLs set through `icacls`, for this module's tests and for the crates whose storage checks use it.
#[cfg(all(windows, any(test, feature = "test-support")))]
pub mod fixtures {
    use super::current_user;
    use std::{path::Path, process::Command};

    pub fn icacls(path: &Path, args: &[&str]) {
        let output = Command::new("icacls")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "icacls {args:?}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    /// Drops what a temporary folder inherits (a data volume's root grants Authenticated Users modify) so only the
    /// current user and the system hold access. What a directory holds inherits that.
    pub fn restrict(path: &Path) {
        let inherit = if path.is_dir() { "(OI)(CI)" } else { "" };
        let user = format!("*{}:{inherit}F", current_user().unwrap());
        let system = format!("*S-1-5-18:{inherit}F");
        icacls(
            path,
            &["/inheritance:r", "/grant:r", &user, "/grant:r", &system],
        );
    }
    /// Lets every account modify `path` and what it holds.
    pub fn expose(path: &Path) {
        icacls(path, &["/grant", "*S-1-1-0:(OI)(CI)M"]);
    }
    /// A junction at `link` that leads to the directory `target`; it needs no privilege, unlike a symbolic link.
    pub fn junction(link: &Path, target: &Path) {
        let made = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stdout)
        );
    }
}

/// Real files and real ACLs, run by the hosted Windows jobs: the SIDs and DACLs below come from the operating
/// system, not from this file.
#[cfg(all(test, windows))]
mod native_tests {
    use super::{fixtures::*, *};
    use std::{path::Path, process::Command};

    fn admitted(path: &Path, need: Need) -> bool {
        match admit_path(path, need) {
            Ok(()) => true,
            Err(error) => {
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}");
                false
            }
        }
    }

    #[test]
    fn the_current_user_is_the_one_whoami_reports() {
        let output = Command::new("whoami")
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .unwrap();
        let line = String::from_utf8(output.stdout).unwrap();
        // "DOMAIN\name","S-1-5-21-..."
        let reported = line.trim().rsplit(',').next().unwrap().trim_matches('"');
        assert_eq!(current_user().unwrap(), reported);
    }

    #[test]
    fn files_are_admitted_or_refused_by_the_acl_the_system_reports() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("lazysh-agent.exe");
        std::fs::write(&file, b"x").unwrap();
        let user = current_user().unwrap();
        // The owner is the current user or the administrators, whichever the process token makes the default owner.
        let owner = describe(&file).unwrap().owner;
        assert!(
            owner.eq_ignore_ascii_case(&user) || owner == ADMINISTRATORS,
            "owner {owner} for {user}"
        );
        restrict(&file);
        assert!(admitted(&file, Need::Private));
        assert!(admitted(&file, Need::NoForeignChange));
        // Everyone may read and run it: still an intact executable, no longer private.
        icacls(&file, &["/grant", "*S-1-1-0:RX"]);
        assert!(admitted(&file, Need::NoForeignChange));
        assert!(!admitted(&file, Need::Private));
        // Everyone may modify it: refused both ways.
        icacls(&file, &["/grant", "*S-1-1-0:M"]);
        assert!(!admitted(&file, Need::NoForeignChange));
        assert!(!admitted(&file, Need::Private));
        // Taking that access away again admits it again.
        icacls(&file, &["/remove:g", "*S-1-1-0"]);
        assert!(admitted(&file, Need::Private));
    }

    #[test]
    fn a_junction_is_refused_before_its_target_is_read() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = directory.path().join("junction");
        junction(&link, &target);
        restrict(&target);
        assert!(!admitted(&link, Need::NoForeignChange));
        assert!(admitted(&target, Need::NoForeignChange));
    }

    #[test]
    fn a_directory_others_may_only_add_to_stays_admitted_as_an_ancestor() {
        let directory = tempfile::tempdir().unwrap();
        restrict(directory.path());
        // Authenticated Users add subdirectories, as they do to a drive root.
        icacls(directory.path(), &["/grant", "*S-1-5-11:(AD)"]);
        assert!(admitted(directory.path(), Need::NoForeignReplace));
        assert!(!admitted(directory.path(), Need::NoForeignChange));
        expose(directory.path());
        assert!(!admitted(directory.path(), Need::NoForeignReplace));
    }

    #[test]
    fn a_chain_from_the_drive_root_is_admitted_for_a_private_leaf_and_refused_through_a_foreign_ancestor(
    ) {
        let directory = tempfile::tempdir().unwrap();
        restrict(directory.path());
        let leaf = directory.path().join("leaf");
        std::fs::create_dir(&leaf).unwrap();
        let canonical = std::fs::canonicalize(&leaf).unwrap();
        admit_chain(&canonical, Need::Private).unwrap();
        // A foreign account that may read the leaf is fine for an ancestor's role but not for private data.
        icacls(&leaf, &["/grant", "*S-1-1-0:RX"]);
        admit_chain(&canonical, Need::NoForeignReplace).unwrap();
        assert!(admit_chain(&canonical, Need::Private).is_err());
        // The same account able to replace the directory above it makes every path below it untrustworthy.
        expose(directory.path());
        let error = admit_chain(&canonical, Need::NoForeignReplace).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn a_chain_refuses_a_relative_path_and_a_file_in_it() {
        let directory = tempfile::tempdir().unwrap();
        restrict(directory.path());
        let file = directory.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert!(admit_chain(&canonical, Need::NoForeignReplace).is_err());
        let relative = admit_chain(Path::new("relative"), Need::NoForeignReplace).unwrap_err();
        assert_eq!(relative.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_missing_path_is_an_error_not_a_refusal() {
        let directory = tempfile::tempdir().unwrap();
        let error = admit_path(&directory.path().join("absent"), Need::Private).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
