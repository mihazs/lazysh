#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() -> std::process::ExitCode {
    if let Some(code) = lazysh_lib::account_usage_worker() {
        return code;
    }
    lazysh_lib::run();
    std::process::ExitCode::SUCCESS
}
