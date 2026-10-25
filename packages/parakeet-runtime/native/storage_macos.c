#include "storage_macos.h"
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static int admitted_acl(acl_t acl, int private_object) {
  if (acl_valid(acl) != 0) return -1;
  acl_flagset_t flags;
  if (acl_get_flagset_np(acl, &flags) != 0 ||
      acl_get_flag_np(flags, ACL_FLAG_DEFER_INHERIT) != 0) return -1;
  /* Adding a different child cannot replace the existing trusted child on the
   * descriptor walk. Delete/security/owner/attribute grants are not equivalent. */
  const acl_permset_mask_t ancestor_allow = ACL_READ_DATA | ACL_EXECUTE |
      ACL_READ_ATTRIBUTES | ACL_READ_EXTATTRIBUTES | ACL_READ_SECURITY |
      ACL_SYNCHRONIZE | ACL_ADD_FILE | ACL_ADD_SUBDIRECTORY;
  acl_entry_t entry;
  for (int count = 0; count <= ACL_MAX_ENTRIES; ++count) {
    errno = 0;
    if (acl_get_entry(acl, count == 0 ? ACL_FIRST_ENTRY : ACL_NEXT_ENTRY, &entry) != 0)
      return errno == EINVAL ? 0 : -1; /* Darwin documents EINVAL at end, not POSIX 0. */
    if (count == ACL_MAX_ENTRIES) return -1;
    acl_tag_t tag;
    acl_permset_mask_t permissions;
    if (acl_get_tag_type(entry, &tag) != 0 ||
        acl_get_permset_mask_np(entry, &permissions) != 0) return -1;
    if (tag == ACL_EXTENDED_DENY) continue;
    if (tag != ACL_EXTENDED_ALLOW ||
        (permissions & ~(private_object ? 0 : ancestor_allow)) != 0) return -1;
    /* Inherit-only ALLOW entries are deliberately checked too: the private child
     * must never inherit a writable ACL before a later inspection can run. */
  }
  return -1;
}

int lazysh_parakeet_macos_check_fd(int fd, int role) {
  if (role < 0 || role > 2) return -1;
  struct statfs volume;
  if (fstatfs(fd, &volume) != 0 || !(volume.f_flags & MNT_LOCAL) ||
      (volume.f_flags & MNT_IGNORE_OWNERSHIP) ||
      fpathconf(fd, _PC_EXTENDED_SECURITY_NP) != 1) return -1;
  filesec_t security = filesec_init();
  if (!security) return -1;
  struct stat status;
  int result = -1;
  acl_t acl = NULL;
  if (fstatx_np(fd, &status, security) != 0) goto done;
  if ((role == 2 && !S_ISREG(status.st_mode)) ||
      (role != 2 && !S_ISDIR(status.st_mode))) goto done;
  const uid_t current = geteuid();
  if (status.st_uid != 0 && status.st_uid != current) goto done;
  if (role != 0) {
    if (status.st_uid != current || (status.st_mode & 0077)) goto done;
  } else if ((status.st_mode & 0022) && !(status.st_mode & S_ISVTX)) goto done;
  int has_acl = 0;
  if (filesec_query_property(security, FILESEC_ACL, &has_acl) != 0) goto done;
  if (!has_acl) { result = 0; goto done; }
  if (filesec_get_property(security, FILESEC_ACL, &acl) != 0 || !acl) goto done;
  result = admitted_acl(acl, role != 0);
done:
  if (acl) acl_free(acl);
  filesec_free(security);
  return result;
}
