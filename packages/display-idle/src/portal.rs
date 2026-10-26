//! An acknowledged portal request is owned until its private bus connection closes.
//! None of these operations claims that a compositor's physical idle timer changed.
use crate::{policy::Policy, Request, Status};
use gio::prelude::*;
use glib::variant::ToVariant;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex, Weak,
    },
    time::{Duration, Instant},
};

const BUS: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const REQUEST: &str = "org.freedesktop.portal.Request";
const DBUS: (&str, &str, &str) = (
    "org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    "org.freedesktop.DBus",
);
const ACQUIRE_LIMIT: Duration = Duration::from_secs(5);
const CLOSE_LIMIT: Duration = Duration::from_secs(1);
#[cfg(test)]
mod tests;
type Check = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
type Lost = Arc<dyn Fn(Request, String) + Send + Sync>;
type Reply = mpsc::SyncSender<Result<Status, String>>;
fn dispatch(context: &glib::MainContext, action: impl FnOnce() + Send + 'static) {
    // `invoke` can execute inline on a worker while the default context is unowned.
    // Dropping this handle detaches the task; it still executes on the context loop.
    drop(context.spawn(async move {
        action();
    }));
}

#[derive(Clone)]
pub(crate) struct Portal(Arc<Inner>);
struct Inner {
    context: glib::MainContext,
    address: Option<String>,
    state: Mutex<State>,
    lost: Lost,
}
#[derive(Default)]
struct State {
    policy: Policy<Arc<Pending>>,
    retiring: Option<Arc<Pending>>,
}
struct Pending {
    inner: Weak<Inner>,
    context: glib::MainContext,
    native: Request,
    original: Request,
    before: Check,
    phase: AtomicU8, // pending, acknowledged, cancelling, closed
    acknowledged: AtomicBool,
    connecting: AtomicBool,
    expires: Instant,
    cancellable: gio::Cancellable,
    reply: Mutex<Option<Reply>>,
    bus: Mutex<Bus>,
    closed: (Mutex<Option<Result<(), String>>>, Condvar),
}
#[derive(Default)]
struct Bus {
    connection: Option<gio::DBusConnection>,
    owner: Option<String>,
    observed_owner: Option<String>,
    expected: String,
    other: Option<String>,
    returned: bool,
    response: Option<u32>,
    subscriptions: Vec<gio::SignalSubscriptionId>,
    deadline: Option<glib::Source>,
    closing: bool,
}
fn same(a: &Request, b: &Request) -> bool {
    a.epoch == b.epoch && a.ticket == b.ticket
}
impl Portal {
    pub(crate) fn new(context: glib::MainContext, address: Option<String>, lost: Lost) -> Self {
        Self(Arc::new(Inner {
            context,
            address: address.filter(|value| !value.is_empty() && value.len() <= 4096),
            state: Mutex::new(State::default()),
            lost,
        }))
    }
    pub(crate) fn status(&self) -> Result<Status, String> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "Portal ownership is unavailable.")?;
        let mut status = state.policy.status(
            self.0.address.is_some(),
            if self.0.address.is_some() {
                "The desktop portal must acknowledge an owned idle-inhibition request."
            } else {
                "The session D-Bus address is unavailable."
            }
            .into(),
        )?;
        status.active = state.active();
        Ok(status)
    }
    pub(crate) fn acquire(
        &self,
        native: Request,
        original: Request,
        before: Check,
    ) -> Result<Status, String> {
        let (sent, received) = mpsc::sync_channel(1);
        let pending = Arc::new(Pending {
            inner: Arc::downgrade(&self.0),
            context: self.0.context.clone(),
            native: native.clone(),
            original,
            before,
            phase: AtomicU8::new(0),
            acknowledged: AtomicBool::new(false),
            connecting: AtomicBool::new(false),
            expires: Instant::now() + ACQUIRE_LIMIT,
            cancellable: gio::Cancellable::new(),
            reply: Mutex::new(Some(sent)),
            bus: Mutex::new(Bus::default()),
            closed: (Mutex::new(None), Condvar::new()),
        });
        let previous = {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| "Portal ownership is unavailable.")?;
            if state.retiring.as_ref().is_some_and(|old| !old.is_closed()) {
                return Err("Previous portal cleanup is still pending.".into());
            }
            state.retiring = None;
            state.policy.admit(&native)?;
            let old = state
                .policy
                .active
                .replace((native.ticket, pending.clone()))
                .map(|(_, old)| old);
            state.retiring = old.clone();
            old
        };
        if let Some(old) = previous {
            old.cancel(None);
            if let Err(error) = old.wait_closed() {
                pending.cancel(None);
                return Err(error);
            }
        }
        let start = pending.clone();
        dispatch(&self.0.context, move || start.start());
        match received
            .recv_timeout(pending.expires.saturating_duration_since(Instant::now()) + CLOSE_LIMIT)
        {
            Ok(result) => result,
            Err(_) => {
                pending.cancel(None);
                Err("The portal request deadline expired.".into())
            }
        }
    }
    /// This fast path must run BEFORE the outer display serialization mutex is taken.
    pub(crate) fn cancel(&self, request: &Request) -> Result<(), String> {
        let pending = {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| "Portal ownership is unavailable.")?;
            let active = state.policy.release(request)?;
            if let Some(active) = active {
                if state.retiring.as_ref().is_none_or(|old| old.is_closed()) {
                    state.retiring = Some(active.clone());
                }
                Some(active)
            } else {
                state
                    .retiring
                    .as_ref()
                    .filter(|old| same(&old.native, request))
                    .cloned()
            }
        };
        if let Some(pending) = pending {
            pending.cancel(None);
        }
        Ok(())
    }
    pub(crate) fn release(&self, request: &Request) -> Result<Status, String> {
        self.cancel(request)?;
        let pending = self
            .0
            .state
            .lock()
            .map_err(|_| "Portal ownership is unavailable.")?
            .retiring
            .as_ref()
            .filter(|old| same(&old.native, request))
            .cloned();
        if let Some(pending) = pending {
            pending.wait_closed()?;
        }
        let state = self
            .0
            .state
            .lock()
            .map_err(|_| "Portal ownership is unavailable.")?;
        Ok(Status {
            available: self.0.address.is_some(),
            reason: "Portal request ownership was released.".into(),
            active: state.active(),
            epoch: request.epoch.clone(),
            ticket: request.ticket,
        })
    }
    pub(crate) fn invalidate(&self) {
        let (active, retiring) = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let active = state.policy.invalidate();
            if state.retiring.as_ref().is_none_or(|old| old.is_closed()) {
                state.retiring = active.clone();
            }
            (active, state.retiring.clone())
        };
        for pending in [active, retiring].into_iter().flatten() {
            pending.cancel(None);
        }
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for pending in [
            state.policy.active.take().map(|(_, active)| active),
            state.retiring.take(),
        ]
        .into_iter()
        .flatten()
        {
            pending.cancel(None);
        }
    }
}
impl State {
    fn active(&self) -> bool {
        self.policy
            .active
            .as_ref()
            .is_some_and(|(_, value)| value.acknowledged.load(Ordering::SeqCst))
            || self
                .retiring
                .as_ref()
                .is_some_and(|value| value.acknowledged.load(Ordering::SeqCst))
    }
}
impl Pending {
    fn is_closed(&self) -> bool {
        self.phase.load(Ordering::SeqCst) == 3
    }
    fn timer(
        self: &Arc<Self>,
        duration: Duration,
        action: impl FnOnce(Arc<Self>) + Send + 'static,
    ) -> glib::Source {
        let pending = self.clone();
        let mut action = Some(action);
        let source =
            glib::source::timeout_source_new(duration, None, glib::Priority::DEFAULT, move || {
                if let Some(action) = action.take() {
                    action(pending.clone());
                }
                glib::ControlFlow::Break
            });
        source.attach(Some(&self.context));
        source
    }
    fn send(&self, result: Result<Status, String>) {
        if let Some(sent) = self.reply.lock().unwrap().take() {
            let _ = sent.send(result);
        }
    }
    fn cancel(self: &Arc<Self>, loss: Option<&str>) {
        if self.phase.fetch_max(2, Ordering::SeqCst) == 3 {
            return;
        }
        if let Some(reason) = loss {
            if self.acknowledged.swap(false, Ordering::SeqCst) {
                if let Some(inner) = self.inner.upgrade() {
                    (inner.lost)(self.original.clone(), reason.into());
                }
            }
        }
        self.cancellable.cancel();
        self.send(Err(loss
            .unwrap_or("Portal request ownership was cancelled.")
            .into()));
        let pending = self.clone();
        dispatch(&self.context, move || pending.close());
    }
    fn start(self: Arc<Self>) {
        if self.phase.load(Ordering::SeqCst) >= 2 {
            self.finish_closed(Ok(()));
            return;
        }
        let Some(inner) = self.inner.upgrade() else {
            self.cancel(None);
            return;
        };
        let Some(address) = inner.address.as_deref() else {
            self.cancel(Some("The session D-Bus address is unavailable."));
            return;
        };
        if Instant::now() >= self.expires {
            self.cancel(Some("The portal request deadline expired."));
            return;
        }
        self.bus.lock().unwrap().deadline = Some(self.timer(
            self.expires.saturating_duration_since(Instant::now()),
            |pending| {
                pending.cancel(Some(
                    "The portal did not acknowledge the request before its deadline.",
                ))
            },
        ));
        self.connecting.store(true, Ordering::SeqCst);
        let pending = self.clone();
        gio::DBusConnection::for_address(
            address,
            gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
                | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
            None,
            Some(&self.cancellable),
            move |result| {
                pending.connecting.store(false, Ordering::SeqCst);
                match result {
                    Ok(connection) => {
                        connection.set_exit_on_close(false);
                        pending.bus.lock().unwrap().connection = Some(connection.clone());
                        if pending.phase.load(Ordering::SeqCst) >= 2 {
                            pending.close();
                            return;
                        }
                        pending.discover(connection);
                    }
                    Err(_) => {
                        pending.cancel(Some(
                            "The desktop portal bus connection could not be opened.",
                        ));
                        pending.finish_closed(Ok(()));
                    }
                }
            },
        );
    }
    fn call(
        self: &Arc<Self>,
        endpoint: (&str, &str, &str),
        method: &str,
        parameters: glib::Variant,
        reply: &'static str,
        callback: impl FnOnce(Arc<Self>, Result<glib::Variant, glib::Error>) + 'static,
    ) {
        let connection = self.bus.lock().unwrap().connection.clone();
        if let Some(connection) = connection {
            let pending = self.clone();
            connection.call(
                Some(endpoint.0),
                endpoint.1,
                endpoint.2,
                method,
                Some(&parameters),
                Some(glib::VariantTy::new(reply).unwrap()),
                gio::DBusCallFlags::NONE,
                1000,
                Some(&self.cancellable),
                move |result| callback(pending, result),
            );
        }
    }
    fn discover(self: &Arc<Self>, connection: gio::DBusConnection) {
        let weak = Arc::downgrade(self);
        connection.connect_closed(move |_, _, _| {
            if let Some(pending) = weak.upgrade() {
                let closing = pending.bus.lock().unwrap().closing;
                if !closing {
                    pending.cancel(Some("The owned portal connection closed."));
                }
                pending.finish_closed(Ok(()));
            }
        });
        let weak = Arc::downgrade(self);
        let subscription = connection.signal_subscribe(
            Some("org.freedesktop.DBus"),
            Some("org.freedesktop.DBus"),
            Some("NameOwnerChanged"),
            Some("/org/freedesktop/DBus"),
            Some(BUS),
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, value| {
                if let Some(pending) = weak.upgrade() {
                    if let Some((_, old, new)) = value.get::<(String, String, String)>() {
                        let owner = {
                            let mut bus = pending.bus.lock().unwrap();
                            bus.observed_owner = Some(new.clone());
                            bus.owner.clone()
                        };
                        if owner
                            .as_ref()
                            .is_some_and(|owner| owner == &old && owner != &new)
                        {
                            pending.cancel(Some(
                                "The desktop portal owner changed; its request is no longer owned.",
                            ));
                        }
                    }
                }
            },
        );
        self.bus.lock().unwrap().subscriptions.push(subscription);
        self.call(
            DBUS,
            "StartServiceByName",
            (BUS, 0u32).to_variant(),
            "(u)",
            |pending, result| {
                if result.is_err() {
                    pending.cancel(Some("The desktop portal is unavailable."));
                    return;
                }
                pending.call(
                    DBUS,
                    "GetNameOwner",
                    (BUS,).to_variant(),
                    "(s)",
                    |pending, result| {
                        let owner = result
                            .ok()
                            .and_then(|value| value.get::<(String,)>().map(|(owner,)| owner));
                        match owner {
                            Some(owner) if gio::dbus_is_unique_name(&owner) => {
                                pending.inhibit(owner)
                            }
                            _ => pending
                                .cancel(Some("The desktop portal has no valid unique owner.")),
                        }
                    },
                );
            },
        );
    }
    fn inhibit(self: &Arc<Self>, owner: String) {
        if self.phase.load(Ordering::SeqCst) >= 2 {
            self.clone().close();
            return;
        }
        if (self.before)().is_err() {
            self.cancel(Some(
                "Original display authority expired before the portal request.",
            ));
            return;
        }
        if Instant::now() >= self.expires {
            self.cancel(Some("The portal request deadline expired."));
            return;
        }
        let connection = self.bus.lock().unwrap().connection.clone().unwrap();
        let token = format!("lazysh_{}", uuid::Uuid::new_v4().simple());
        let Some(unique) = connection.unique_name() else {
            self.cancel(Some("The owned portal connection has no unique bus name."));
            return;
        };
        let sender = unique.trim_start_matches(':').replace('.', "_");
        let expected = format!("{PATH}/request/{sender}/{token}");
        {
            let mut bus = self.bus.lock().unwrap();
            if bus
                .observed_owner
                .as_ref()
                .is_some_and(|observed| observed != &owner)
            {
                drop(bus);
                self.cancel(Some("The desktop portal owner changed before admission."));
                return;
            }
            bus.owner = Some(owner.clone());
            bus.expected = expected.clone();
        }
        let weak = Arc::downgrade(self);
        let subscription = connection.signal_subscribe(
            Some(&owner),
            Some(REQUEST),
            Some("Response"),
            Some(&expected),
            None,
            gio::DBusSignalFlags::NONE,
            move |_, sender, path, _, _, value| {
                if let Some(pending) = weak.upgrade() {
                    let response = (value.size() <= 1024)
                        .then(|| value.get::<(u32, HashMap<String, glib::Variant>)>())
                        .flatten();
                    let matches = {
                        let bus = pending.bus.lock().unwrap();
                        bus.owner.as_deref() == Some(sender) && bus.expected == path
                    };
                    if !matches {
                        return;
                    }
                    match response {
                        Some((0, _)) => {
                            pending.bus.lock().unwrap().response = Some(0);
                            pending.confirm();
                        }
                        _ => pending.cancel(Some(
                            "The portal denied or revoked the idle-inhibition request.",
                        )),
                    }
                }
            },
        );
        self.bus.lock().unwrap().subscriptions.push(subscription);
        let options = HashMap::from([
            ("handle_token", token.to_variant()),
            (
                "reason",
                "Keep the visible lazysh agents board awake".to_variant(),
            ),
        ]);
        self.call(
            (&owner, PATH, "org.freedesktop.portal.Inhibit"),
            "Inhibit",
            ("", 8u32, options).to_variant(),
            "(o)",
            |pending, result| {
                let handle = result
                    .ok()
                    .filter(|value| value.size() <= 512)
                    .and_then(|value| value.child_value(0).get::<String>());
                let expected = pending.bus.lock().unwrap().expected.clone();
                if handle.as_deref() != Some(&expected) {
                    if let Some(handle) = handle.filter(|handle| {
                        handle.starts_with(&format!("{}/", expected.rsplit_once('/').unwrap().0))
                    }) {
                        pending.bus.lock().unwrap().other = Some(handle);
                    }
                    pending.cancel(Some("The portal returned an unexpected request handle."));
                    return;
                }
                pending.bus.lock().unwrap().returned = true;
                pending.confirm();
            },
        );
    }
    fn confirm(self: &Arc<Self>) {
        // Only acquisition has a deadline. Duplicate signals must neither renew an
        // acknowledged request nor change cancellation/cleanup already in progress.
        if self.phase.load(Ordering::SeqCst) != 0 {
            return;
        }
        if Instant::now() >= self.expires {
            self.cancel(Some(
                "The portal acknowledgement arrived after its deadline.",
            ));
            return;
        }
        let ready = {
            let bus = self.bus.lock().unwrap();
            bus.returned && bus.response == Some(0)
        };
        if !ready {
            return;
        }
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let current = inner
            .state
            .lock()
            .unwrap()
            .policy
            .active
            .as_ref()
            .is_some_and(|(_, active)| Arc::ptr_eq(active, self));
        if !current {
            self.cancel(None);
            return;
        }
        if self
            .phase
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        self.acknowledged.store(true, Ordering::SeqCst);
        if let Some(timer) = self.bus.lock().unwrap().deadline.take() {
            timer.destroy();
        }
        self.send(Ok(Status {
            available: true,
            reason: "The portal acknowledged an owned idle-inhibition request.".into(),
            active: true,
            epoch: self.native.epoch.clone(),
            ticket: self.native.ticket,
        }));
    }
    fn close(self: Arc<Self>) {
        let (connection, owner, mut handles) = {
            let mut bus = self.bus.lock().unwrap();
            if let Some(timer) = bus.deadline.take() {
                timer.destroy();
            }
            if bus.closing {
                return;
            }
            let Some(connection) = bus.connection.clone() else {
                drop(bus);
                if !self.connecting.load(Ordering::SeqCst) {
                    self.finish_closed(Ok(()));
                }
                return;
            };
            bus.closing = true;
            (
                connection,
                bus.owner.clone(),
                [Some(bus.expected.clone()), bus.other.clone()]
                    .into_iter()
                    .flatten()
                    .filter(|handle| !handle.is_empty())
                    .collect::<Vec<_>>(),
            )
        };
        if connection.is_closed() {
            self.finish_closed(Ok(()));
            return;
        }
        if let Some(owner) = owner.filter(|_| !handles.is_empty()) {
            self.bus.lock().unwrap().deadline =
                Some(self.timer(CLOSE_LIMIT, |pending| pending.close_connection()));
            handles.dedup();
            let remaining = Arc::new(AtomicUsize::new(handles.len()));
            for handle in handles {
                let pending = self.clone();
                let remaining = remaining.clone();
                connection.call(
                    Some(&owner),
                    &handle,
                    REQUEST,
                    "Close",
                    None,
                    Some(glib::VariantTy::UNIT),
                    gio::DBusCallFlags::NONE,
                    500,
                    gio::Cancellable::NONE,
                    move |_| {
                        if remaining.fetch_sub(1, Ordering::SeqCst) == 1 {
                            pending.close_connection();
                        }
                    },
                );
            }
        } else {
            self.close_connection();
        }
    }
    fn close_connection(self: Arc<Self>) {
        let connection = {
            let mut bus = self.bus.lock().unwrap();
            if let Some(timer) = bus.deadline.take() {
                timer.destroy();
            }
            bus.connection.clone()
        };
        let Some(connection) = connection else {
            self.finish_closed(Ok(()));
            return;
        };
        if connection.is_closed() {
            self.finish_closed(Ok(()));
            return;
        }
        let pending = self.clone();
        connection.close(gio::Cancellable::NONE, move |result| {
            pending.finish_closed(
                result.map_err(|_| "The owned portal connection could not be closed.".into()),
            )
        });
    }
    fn finish_closed(&self, result: Result<(), String>) {
        if result.is_ok() {
            self.phase.store(3, Ordering::SeqCst);
            self.acknowledged.store(false, Ordering::SeqCst);
            let mut bus = self.bus.lock().unwrap();
            if let Some(timer) = bus.deadline.take() {
                timer.destroy();
            }
            if let Some(connection) = bus.connection.take() {
                for subscription in bus.subscriptions.drain(..) {
                    connection.signal_unsubscribe(subscription);
                }
            }
        } else {
            self.bus.lock().unwrap().closing = false;
        }
        *self.closed.0.lock().unwrap() = Some(result);
        self.closed.1.notify_all();
    }
    fn wait_closed(&self) -> Result<(), String> {
        let (result, _) = self
            .closed
            .1
            .wait_timeout_while(self.closed.0.lock().unwrap(), CLOSE_LIMIT * 2, |result| {
                result.is_none()
            })
            .map_err(|_| "Portal cleanup state is unavailable.")?;
        result
            .clone()
            .unwrap_or_else(|| Err("Portal cleanup has not been confirmed.".into()))
    }
}
