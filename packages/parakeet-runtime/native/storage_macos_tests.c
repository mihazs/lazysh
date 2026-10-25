#include "storage_macos.h"
#include <fcntl.h>
#include <membership.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <uuid/uuid.h>

static void check(int condition, int line) {
  if (!condition) { fprintf(stderr, "macOS storage assertion failed at line %d\n", line); exit(1); }
}
#define CHECK(value) check((value), __LINE__)
static void replace_acl(int fd, acl_tag_t tag, acl_perm_t permission, int inherit_only) {
  acl_t acl = acl_init(1);
  CHECK(acl != NULL);
  if (permission != 0) {
    acl_entry_t entry;
    acl_permset_t permissions;
    uuid_t identity;
    CHECK(mbr_uid_to_uuid(geteuid(), identity) == 0);
    CHECK(acl_create_entry(&acl, &entry) == 0);
    CHECK(acl_set_tag_type(entry, tag) == 0);
    CHECK(acl_set_qualifier(entry, identity) == 0);
    CHECK(acl_get_permset(entry, &permissions) == 0);
    CHECK(acl_add_perm(permissions, permission) == 0);
    CHECK(acl_set_permset(entry, permissions) == 0);
    if (inherit_only) {
      acl_flagset_t flags;
      CHECK(acl_get_flagset_np(entry, &flags) == 0);
      CHECK(acl_add_flag_np(flags, ACL_ENTRY_DIRECTORY_INHERIT) == 0);
      CHECK(acl_add_flag_np(flags, ACL_ENTRY_ONLY_INHERIT) == 0);
      CHECK(acl_set_flagset_np(entry, flags) == 0);
    }
  }
  CHECK(acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED) == 0);
  CHECK(acl_free(acl) == 0);
}
int main(void) {
  char temporary[] = "/tmp/lazysh-parakeet-storage-XXXXXX";
  CHECK(mkdtemp(temporary) != NULL);
  int directory = open(temporary, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  CHECK(directory >= 0);
  CHECK(fchmod(directory, 0700) == 0);
  replace_acl(directory, ACL_EXTENDED_ALLOW, 0, 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 1) == 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 0) == 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 2) != 0);
  CHECK(lazysh_parakeet_macos_check_fd(-1, 1) != 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 99) != 0);
  CHECK(fchmod(directory, 0770) == 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 1) != 0);
  CHECK(fchmod(directory, 0700) == 0);
  const acl_perm_t unsafe[] = { ACL_DELETE, ACL_DELETE_CHILD, ACL_WRITE_ATTRIBUTES,
      ACL_WRITE_EXTATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER };
  for (size_t index = 0; index < sizeof(unsafe) / sizeof(unsafe[0]); ++index) {
    replace_acl(directory, ACL_EXTENDED_ALLOW, unsafe[index], 0);
    /* chmod cannot turn a separate extended ACL into a private object. */
    CHECK(fchmod(directory, 0700) == 0);
    CHECK(lazysh_parakeet_macos_check_fd(directory, 0) != 0);
    CHECK(lazysh_parakeet_macos_check_fd(directory, 1) != 0);
  }
  replace_acl(directory, ACL_EXTENDED_ALLOW, ACL_WRITE_SECURITY, 1);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 0) != 0);
  replace_acl(directory, ACL_EXTENDED_DENY, ACL_DELETE, 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 1) == 0);
  replace_acl(directory, ACL_EXTENDED_ALLOW, ACL_READ_ATTRIBUTES, 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 0) == 0);
  CHECK(lazysh_parakeet_macos_check_fd(directory, 1) != 0);
  const acl_perm_t create_only[] = { ACL_ADD_FILE, ACL_ADD_SUBDIRECTORY };
  for (size_t index = 0; index < 2; ++index) {
    replace_acl(directory, ACL_EXTENDED_ALLOW, create_only[index], 0);
    CHECK(lazysh_parakeet_macos_check_fd(directory, 0) == 0);
    CHECK(lazysh_parakeet_macos_check_fd(directory, 1) != 0);
  }
  replace_acl(directory, ACL_EXTENDED_ALLOW, 0, 0);
  int file = openat(directory, "fixture", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  CHECK(file >= 0);
  CHECK(lazysh_parakeet_macos_check_fd(file, 2) == 0);
  replace_acl(file, ACL_EXTENDED_ALLOW, ACL_WRITE_DATA, 0);
  CHECK(lazysh_parakeet_macos_check_fd(file, 2) != 0);
  replace_acl(file, ACL_EXTENDED_ALLOW, 0, 0);
  CHECK(close(file) == 0);
  CHECK(unlinkat(directory, "fixture", 0) == 0);
  CHECK(close(directory) == 0);
  CHECK(rmdir(temporary) == 0);
  return 0;
}
