// The blocking worker owns admission even if its async caller is dropped.
pub(crate) async fn retained_write<G: Send + 'static>(
    guard: G,
    write: impl FnOnce() -> Result<(), String> + Send + 'static,
    stopped: &'static str,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        write()
    })
    .await
    .map_err(|_| stopped.to_owned())?
}
