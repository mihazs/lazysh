//! Native workers own background execution; neither the renderer nor Activity owns a count.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
#[cfg(any(target_os = "android", test))]
use std::{collections::HashSet, future::Future, time::Duration};
use tokio::sync::{mpsc, oneshot};

const FAILURE: &str = "Could not keep the terminal connection active in the background";
// Only Android installs the receiver; desktop retains the no-op Controller path.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
enum Command {
    Acquire(u64, oneshot::Sender<Result<(), String>>),
    Release(u64),
}
#[derive(Clone, Default)]
pub(crate) struct Controller(Option<Arc<Owner>>);
struct Owner {
    commands: mpsc::UnboundedSender<Command>,
    next: AtomicU64,
}
pub(crate) struct Reservation {
    owner: Option<Arc<Owner>>,
    id: u64,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(owner) = &self.owner {
            let _ = owner.commands.send(Command::Release(self.id));
        }
    }
}
impl Controller {
    pub(crate) async fn acquire(&self) -> Result<Reservation, String> {
        let Some(owner) = &self.0 else {
            return Ok(Reservation { owner: None, id: 0 });
        };
        // Create cleanup authority before the first suspension point. Cancellation after
        // native start but before its acknowledgment must still enqueue exact-owner release.
        let reservation = Reservation {
            owner: Some(owner.clone()),
            id: owner.next.fetch_add(1, Ordering::Relaxed),
        };
        let (reply, response) = oneshot::channel();
        owner
            .commands
            .send(Command::Acquire(reservation.id, reply))
            .map_err(|_| FAILURE)?;
        response.await.map_err(|_| FAILURE)??;
        Ok(reservation)
    }
    #[cfg(any(target_os = "android", test))]
    pub(crate) fn start<F, Fut>(mut update: F) -> Self
    where
        F: FnMut(u64, bool) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), String>> + Send,
    {
        let (commands, mut incoming) = mpsc::unbounded_channel();
        tauri::async_runtime::spawn(async move {
            let mut workers = HashSet::new();
            let mut revision = 0;
            while let Some(command) = incoming.recv().await {
                match command {
                    Command::Acquire(id, reply) => {
                        workers.insert(id);
                        revision += 1;
                        let result =
                            tokio::time::timeout(Duration::from_secs(10), update(revision, true))
                                .await
                                .unwrap_or_else(|_| Err(FAILURE.into()));
                        if result.is_err() {
                            workers.remove(&id);
                            revision += 1;
                            let _ = tokio::time::timeout(
                                Duration::from_secs(10),
                                update(revision, !workers.is_empty()),
                            )
                            .await;
                        }
                        let _ = reply.send(result);
                    }
                    Command::Release(id) if workers.remove(&id) => {
                        revision += 1;
                        let _ = tokio::time::timeout(
                            Duration::from_secs(10),
                            update(revision, !workers.is_empty()),
                        )
                        .await;
                    }
                    Command::Release(_) => {}
                }
            }
        });
        Self(Some(Arc::new(Owner {
            commands,
            next: AtomicU64::new(1),
        })))
    }
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("lazysh-session-background")
        // This private plugin has no renderer command or renderer-owned connection count.
        .invoke_handler(|invoke| {
            invoke.resolver.reject("unavailable");
            true
        })
        .setup(|app, api| {
            use tauri::Manager;
            #[cfg(target_os = "android")]
            let controller = {
                let handle =
                    api.register_android_plugin("app.lazysh.client", "SessionBackgroundPlugin")?;
                Controller::start(move |revision, active| {
                    let handle = handle.clone();
                    async move {
                        handle
                            .run_mobile_plugin_async::<()>(
                                "update",
                                serde_json::json!({ "revision": revision, "active": active }),
                            )
                            .await
                            .map_err(|_| FAILURE.to_owned())
                    }
                })
            };
            #[cfg(not(target_os = "android"))]
            let controller = {
                let _ = api;
                Controller::default()
            };
            app.manage(controller);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    type Update = (u64, bool, oneshot::Sender<Result<(), String>>);
    fn controlled() -> (Controller, mpsc::UnboundedReceiver<Update>) {
        let (send, updates) = mpsc::unbounded_channel();
        let controller = Controller::start(move |revision, active| {
            let (reply, response) = oneshot::channel();
            send.send((revision, active, reply)).unwrap();
            async move { response.await.unwrap() }
        });
        (controller, updates)
    }
    async fn next_update(updates: &mut mpsc::UnboundedReceiver<Update>) -> Update {
        tokio::time::timeout(Duration::from_secs(2), updates.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn update(
        updates: &mut mpsc::UnboundedReceiver<Update>,
        expected: (u64, bool),
        fail: bool,
    ) {
        let (revision, active, reply) = next_update(updates).await;
        assert_eq!((revision, active), expected);
        reply
            .send(if fail {
                Err("start denied".into())
            } else {
                Ok(())
            })
            .unwrap();
    }
    fn acquire(controller: &Controller) -> tokio::task::JoinHandle<Result<Reservation, String>> {
        let controller = controller.clone();
        tokio::spawn(async move { controller.acquire().await })
    }
    #[tokio::test]
    async fn only_last_actual_worker_releases_background_execution() {
        let (controller, mut updates) = controlled();
        let first = acquire(&controller);
        update(&mut updates, (1, true), false).await;
        let first = first.await.unwrap().unwrap();
        let second = acquire(&controller);
        update(&mut updates, (2, true), false).await;
        let second = second.await.unwrap().unwrap();
        // Neither a UI owner nor a replaced Activity owns a reservation.
        drop(controller.clone());
        drop(first);
        update(&mut updates, (3, true), false).await;
        drop(second);
        update(&mut updates, (4, false), false).await;
    }
    #[tokio::test]
    async fn cancelled_and_failed_acquisition_compensate_before_new_workers() {
        let (controller, mut updates) = controlled();
        let cancelled = acquire(&controller);
        let (revision, active, reply) = next_update(&mut updates).await;
        assert_eq!((revision, active), (1, true));
        cancelled.abort();
        assert!(matches!(cancelled.await, Err(error) if error.is_cancelled()));
        reply.send(Ok(())).unwrap();
        update(&mut updates, (2, false), false).await;
        let failed = acquire(&controller);
        update(&mut updates, (3, true), true).await;
        update(&mut updates, (4, false), false).await;
        assert!(failed.await.unwrap().is_err());
        let successful = acquire(&controller);
        update(&mut updates, (5, true), false).await;
        drop(successful.await.unwrap().unwrap());
        update(&mut updates, (6, false), false).await;
    }
}
