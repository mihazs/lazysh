//! Whether a Windows file or directory belongs to the current user and cannot be changed (or, for private data, read)
//! by anyone else, decided from its owner SID and its DACL.
//!
//! The decision is a pure function over a [`Descriptor`], so it is built and tested on every operating system. Only
//! the reader that fills a `Descriptor` from a path and the current user's SID needs Windows. The Windows API walks
//! the ACEs itself instead of going through SDDL text, which prints well-known accounts as aliases (`LA` for the
//! built-in Administrator) that would otherwise have to be mapped back to SIDs.

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

/// What other accounts must be unable to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
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
        };
        if exposed {
            return Err(Refusal::ForeignAccess);
        }
    }
    Ok(())
}

#[cfg(windows)]
pub use native::{admit_path, current_user, describe};

#[cfg(windows)]
mod native {
    use super::*;
    use std::{ffi::c_void, io, os::windows::ffi::OsStrExt, path::Path, ptr};

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
        if crate::storage_namespace::is_link(&std::fs::symlink_metadata(path)?) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the path is a symbolic link, junction or other reparse point",
            ));
        }
        admit(&describe(path)?, &current_user()?, need)
            .map_err(|refusal| io::Error::new(io::ErrorKind::PermissionDenied, refusal))
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

/// Real files and real ACLs, run by the hosted Windows jobs: the SIDs and DACLs below come from the operating
/// system, not from this file.
#[cfg(all(test, windows))]
mod native_tests {
    use super::*;
    use std::{path::Path, process::Command};

    fn icacls(path: &Path, args: &[&str]) {
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
    /// current user and the system hold access.
    fn restrict(path: &Path) {
        let user = format!("*{}:F", current_user().unwrap());
        icacls(
            path,
            &[
                "/inheritance:r",
                "/grant:r",
                &user,
                "/grant:r",
                "*S-1-5-18:F",
            ],
        );
    }
    fn admitted(path: &Path, need: Need) -> bool {
        match admit_path(path, need) {
            Ok(()) => true,
            Err(error) => {
                assert_eq!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied,
                    "{error}"
                );
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
        let junction = directory.path().join("junction");
        let made = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stdout)
        );
        restrict(&target);
        assert!(!admitted(&junction, Need::NoForeignChange));
        assert!(admitted(&target, Need::NoForeignChange));
    }

    #[test]
    fn a_missing_path_is_an_error_not_a_refusal() {
        let directory = tempfile::tempdir().unwrap();
        let error = admit_path(&directory.path().join("absent"), Need::Private).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
}
