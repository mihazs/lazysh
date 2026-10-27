//! Task-retirement observation shared by both SSH lifetimes in the real fixture.
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Weak},
    task::Poll,
};

// Count completion even when the transport task returned an error. Never issue
// another disconnect or expose the peer's result while observing retirement.
pub(super) async fn completed_transport<F: Future + Unpin>(mut transport: F) -> bool {
    let pending =
        std::future::poll_fn(|cx| Poll::Ready(Pin::new(&mut transport).poll(cx).is_pending()))
            .await;
    if pending {
        let _ = transport.await;
    }
    pending
}

// The caller supplies its existing absolute retirement budget. Sender closure,
// wrapper disappearance and task completion are deliberately separate predicates.
pub(super) async fn retire_transport<W, F: Future + Unpin>(
    wrapper: Weak<W>,
    mut transport: Arc<F>,
    phase: &mut &'static str,
) -> bool {
    *phase = "wrapper";
    while wrapper.upgrade().is_some() {
        tokio::task::yield_now().await;
    }
    *phase = "raw_handle";
    let transport = loop {
        match Arc::try_unwrap(transport) {
            Ok(transport) => break transport,
            Err(retained) => transport = retained,
        }
        tokio::task::yield_now().await;
    };
    *phase = "task";
    completed_transport(transport).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::test_support::assert_pending;

    #[tokio::test]
    async fn retirement_waits_for_wrapper_raw_owners_and_actual_task() {
        let wrapper = Arc::new(());
        let (finish, task) = tokio::sync::oneshot::channel::<()>();
        let task = Arc::new(task);
        let retained = task.clone();
        let mut phase = "wrapper";
        let mut retired = Box::pin(retire_transport(Arc::downgrade(&wrapper), task, &mut phase));
        assert_pending(retired.as_mut()).await;
        drop(wrapper);
        assert_pending(retired.as_mut()).await;
        drop(retained);
        assert_pending(retired.as_mut()).await;
        finish.send(()).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), retired)
                .await
                .expect("fixture retirement gate did not complete")
        );
        assert_eq!(phase, "task");
    }

    #[tokio::test]
    async fn retirement_observes_already_completed_success_or_error_once() {
        for success in [true, false] {
            let (finish, task) = tokio::sync::oneshot::channel::<()>();
            if success {
                finish.send(()).unwrap();
            } else {
                drop(finish);
            }
            let mut phase = "wrapper";
            assert!(!retire_transport(Weak::<()>::new(), Arc::new(task), &mut phase).await);
            assert_eq!(phase, "task");
        }
    }

    #[tokio::test]
    async fn retirement_preserves_the_callers_expired_budget_for_a_pending_task() {
        let (_held, task) = tokio::sync::oneshot::channel::<()>();
        let mut phase = "wrapper";
        assert!(tokio::time::timeout(
            std::time::Duration::ZERO,
            retire_transport(Weak::<()>::new(), Arc::new(task), &mut phase),
        )
        .await
        .is_err());
        assert_eq!(phase, "task");
    }
}
