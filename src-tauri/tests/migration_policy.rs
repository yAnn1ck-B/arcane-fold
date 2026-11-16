#[path = "../build_support/migrations.rs"]
mod migration_policy;

#[test]
fn native_build_guard_rejects_crlf_before_migrations_are_embedded() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("001_initial.sql");
    let canonical = include_str!("../migrations/001_initial.sql");
    std::fs::write(&file, canonical.replace('\n', "\r\n")).unwrap();
    assert!(migration_policy::check_migrations(directory.path())
        .unwrap_err()
        .contains("CR/CRLF"));
    std::fs::write(&file, canonical).unwrap();
    assert_eq!(
        migration_policy::check_migrations(directory.path()).unwrap(),
        vec![file]
    );
}
