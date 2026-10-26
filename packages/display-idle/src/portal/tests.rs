use super::*;
use std::{
    cell::RefCell,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    thread,
};
thread_local! { static DELAYED: RefCell<Vec<glib::JoinHandle<()>>> = const { RefCell::new(Vec::new()) }; }
#[repr(u8)]
#[derive(Clone, Copy)]
enum Outcome {
    Success,
    Denied,
    NoResponse,
    DelayedResponse,
    StalledReply,
    UnexpectedHandle,
    MalformedResponse,
    StalledClose,
    SpoofedResponse,
    ForeignHandle,
}
fn private_connection(address: &str) -> gio::DBusConnection {
    let connection = gio::DBusConnection::for_address_sync(
        address,
        gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
            | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
        None,
        gio::Cancellable::NONE,
    )
    .unwrap();
    connection.set_exit_on_close(false);
    connection
}
fn later(duration: Duration, action: impl FnOnce() + 'static) {
    let task = glib::MainContext::ref_thread_default().spawn_local(async move {
        glib::timeout_future(duration).await;
        action();
    });
    DELAYED.with(|tasks| tasks.borrow_mut().push(task));
}

const XML: &str = "<node><interface name='org.freedesktop.portal.Inhibit'><method name='Inhibit'><arg type='s' direction='in'/><arg type='u' direction='in'/><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method></interface><interface name='org.freedesktop.portal.Request'><method name='Close'/><signal name='Response'><arg type='u'/><arg type='a{sv}'/></signal></interface></node>";
#[derive(Default)]
struct Evidence {
    calls: Mutex<Vec<(String, String, u32)>>,
    closed: Mutex<Vec<String>>,
    changed: Condvar,
    mode: AtomicU8,
}
struct OwnedDaemon(Option<Child>);
impl OwnedDaemon {
    fn stop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for OwnedDaemon {
    fn drop(&mut self) {
        self.stop();
    }
}
fn close_object(connection: &gio::DBusConnection, handle: &str, evidence: Arc<Evidence>) {
    connection
        .register_object(
            handle,
            &gio::DBusNodeInfo::for_xml(XML)
                .unwrap()
                .lookup_interface(REQUEST)
                .unwrap(),
            move |_, _, path, _, method, _, invocation| {
                assert_eq!(method, "Close");
                evidence.closed.lock().unwrap().push(path.into());
                if evidence.mode.load(Ordering::SeqCst) == Outcome::StalledClose as u8 {
                    later(Duration::from_secs(2), move || {
                        invocation.return_value(None)
                    });
                } else {
                    invocation.return_value(None);
                }
            },
            |_, _, _, _, _| ().to_variant(),
            |_, _, _, _, _, _| false,
        )
        .unwrap();
}
struct Fixture {
    portal: Portal,
    evidence: Arc<Evidence>,
    connection: gio::DBusConnection,
    losses: mpsc::Receiver<(Request, String)>,
    departed: mpsc::Receiver<String>,
    late_attempted: mpsc::Receiver<()>,
    main_loop: glib::MainLoop,
    thread: Option<thread::JoinHandle<()>>,
    daemon: OwnedDaemon,
}
impl Fixture {
    fn new(mode: Outcome) -> Self {
        let mut daemon = OwnedDaemon(Some(
            Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("native portal tests require dbus-daemon"),
        ));
        let stdout = daemon.0.as_mut().unwrap().stdout.take().unwrap();
        let (sent, received) = mpsc::sync_channel(1);
        let (departed_tx, departed) = mpsc::sync_channel(32);
        let (late_sent, late_attempted) = mpsc::sync_channel(32);
        let address_reader = thread::spawn(move || {
            let mut address = String::new();
            let result = BufReader::new(stdout)
                .read_line(&mut address)
                .map(|_| address.trim().to_owned());
            let _ = sent.send(result);
        });
        let address = match received.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(address)) => address,
            result => {
                daemon.stop();
                address_reader.join().unwrap();
                panic!("private bus startup failed: {result:?}");
            }
        };
        address_reader.join().unwrap();
        let context = glib::MainContext::new();
        let main_loop = glib::MainLoop::new(Some(&context), false);
        let worker_context = context.clone();
        let worker_loop = main_loop.clone();
        let (ready, started) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            worker_context
                .with_thread_default(|| {
                    ready.send(()).unwrap();
                    worker_loop.run()
                })
                .unwrap()
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let evidence = Arc::new(Evidence::default());
        evidence.mode.store(mode as u8, Ordering::SeqCst);
        let observed = evidence.clone();
        let (sent, received) = mpsc::sync_channel(1);
        let service_address = address.clone();
        context.invoke(move || {
            let connection = private_connection(&service_address);
            connection.signal_subscribe(
                Some("org.freedesktop.DBus"),
                Some("org.freedesktop.DBus"),
                Some("NameOwnerChanged"),
                Some("/org/freedesktop/DBus"),
                None,
                gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, value| {
                    if let Some((name, _, new)) = value.get::<(String, String, String)>() {
                        if name.starts_with(':') && new.is_empty() {
                            let _ = departed_tx.try_send(name);
                        }
                    }
                },
            );
            connection
                .call_sync(
                    Some("org.freedesktop.DBus"),
                    "/org/freedesktop/DBus",
                    "org.freedesktop.DBus",
                    "RequestName",
                    Some(&(BUS, 0u32).to_variant()),
                    None,
                    gio::DBusCallFlags::NONE,
                    1000,
                    gio::Cancellable::NONE,
                )
                .unwrap();
            let node = gio::DBusNodeInfo::for_xml(XML).unwrap();
            connection
                .register_object(
                    PATH,
                    &node
                        .lookup_interface("org.freedesktop.portal.Inhibit")
                        .unwrap(),
                    move |connection, sender, _, _, method, parameters, invocation| {
                        assert_eq!(method, "Inhibit");
                        let (_, flags, options) = parameters
                            .get::<(String, u32, HashMap<String, glib::Variant>)>()
                            .unwrap();
                        let token = options["handle_token"].get::<String>().unwrap();
                        let handle = format!(
                            "{PATH}/request/{}/{token}",
                            sender.trim_start_matches(':').replace('.', "_")
                        );
                        let mode = observed.mode.load(Ordering::SeqCst);
                        let returned = if mode == Outcome::UnexpectedHandle as u8 {
                            format!("{handle}_different")
                        } else if mode == Outcome::ForeignHandle as u8 {
                            format!("{}_foreign/not_owned", handle.rsplit_once('/').unwrap().0)
                        } else {
                            handle.clone()
                        };
                        close_object(&connection, &handle, observed.clone());
                        if returned != handle {
                            close_object(&connection, &returned, observed.clone());
                        }
                        observed
                            .calls
                            .lock()
                            .unwrap()
                            .push((sender.into(), handle.clone(), flags));
                        observed.changed.notify_all();
                        let response = if mode == Outcome::Denied as u8 {
                            1u32
                        } else {
                            0u32
                        };
                        let response_body = if mode == Outcome::MalformedResponse as u8 {
                            ("bad response",).to_variant()
                        } else {
                            (response, HashMap::<String, glib::Variant>::new()).to_variant()
                        };
                        let sender = sender.to_owned();
                        let response_handle = handle.clone();
                        let connection = if mode == Outcome::SpoofedResponse as u8 {
                            private_connection(&service_address)
                        } else {
                            connection
                        };
                        let late_sent = late_sent.clone();
                        let send = move || {
                            let _ = connection.emit_signal(
                                Some(&sender),
                                &response_handle,
                                REQUEST,
                                "Response",
                                Some(&response_body),
                            );
                            if mode == Outcome::SpoofedResponse as u8 {
                                connection.flush_sync(gio::Cancellable::NONE).unwrap();
                                connection.close_sync(gio::Cancellable::NONE).unwrap();
                            }
                            let _ = late_sent.try_send(());
                        };
                        if mode == Outcome::DelayedResponse as u8 {
                            later(Duration::from_millis(150), send);
                        } else if mode != Outcome::NoResponse as u8 {
                            send();
                        }
                        let reply = move || {
                            invocation.return_value(Some(
                                &(glib::variant::ObjectPath::try_from(returned).unwrap(),)
                                    .to_variant(),
                            ))
                        };
                        if mode == Outcome::StalledReply as u8 {
                            later(Duration::from_secs(2), reply);
                        } else {
                            reply();
                        }
                    },
                    |_, _, _, _, _| ().to_variant(),
                    |_, _, _, _, _, _| false,
                )
                .unwrap();
            sent.send(connection).unwrap();
        });
        let connection = received.recv_timeout(Duration::from_secs(2)).unwrap();
        let (lost, losses) = mpsc::sync_channel(8);
        let portal = Portal::new(
            context,
            Some(address),
            Arc::new(move |owner, reason| {
                let _ = lost.try_send((owner, reason));
            }),
        );
        Self {
            portal,
            evidence,
            connection,
            losses,
            departed,
            late_attempted,
            main_loop,
            thread: Some(worker),
            daemon,
        }
    }
    fn ticket(&self) -> (Request, Request) {
        let status = self.portal.status().unwrap();
        let native = Request {
            epoch: status.epoch,
            ticket: status.ticket,
        };
        let original = Request {
            epoch: format!("42/{}", native.epoch),
            ticket: native.ticket,
        };
        (native, original)
    }
    fn own(&self) -> (Request, Request) {
        let (native, original) = self.ticket();
        assert!(
            self.portal
                .acquire(native.clone(), original.clone(), Arc::new(|| Ok(())))
                .unwrap()
                .active
        );
        (native, original)
    }
    fn wait_calls(&self, count: usize) {
        let (calls, _) = self
            .evidence
            .changed
            .wait_timeout_while(
                self.evidence.calls.lock().unwrap(),
                Duration::from_secs(2),
                |calls| calls.len() < count,
            )
            .unwrap();
        assert!(calls.len() >= count, "expected native Inhibit call");
    }
    fn cancel_pending(&self, calls: usize, invalidate: bool) {
        let (native, original) = self.ticket();
        let portal = &self.portal;
        thread::scope(|scope| {
            let acquiring =
                scope.spawn(|| portal.acquire(native.clone(), original, Arc::new(|| Ok(()))));
            self.wait_calls(calls);
            let started = std::time::Instant::now();
            if invalidate {
                self.portal.invalidate();
            } else {
                self.portal.cancel(&native).unwrap();
            }
            assert!(acquiring.join().unwrap().is_err());
            assert!(
                started.elapsed() < CLOSE_LIMIT * 2,
                "cancellation waited for the acquisition deadline"
            );
        });
        assert!(!self.portal.release(&native).unwrap().active);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.portal.invalidate();
        let retiring = self.portal.0.state.lock().unwrap().retiring.clone();
        if let Some(retiring) = retiring {
            let _ = retiring.wait_closed();
        }
        let connection = self.connection.clone();
        let main_loop = self.main_loop.clone();
        self.portal.0.context.invoke(move || {
            DELAYED.with(|tasks| {
                for task in tasks.borrow_mut().drain(..) {
                    task.abort();
                }
            });
            connection.close(gio::Cancellable::NONE, |_| {});
            main_loop.quit();
        });
        if let Some(worker) = self.thread.take() {
            worker.join().unwrap();
        }
        self.daemon.stop();
    }
}
#[test]
fn private_bus_acknowledgement_before_method_reply_is_owned_and_released() {
    let fixture = Fixture::new(Outcome::Success);
    let (native, original) = fixture.ticket();
    let result = fixture
        .portal
        .acquire(native.clone(), original, Arc::new(|| Ok(())))
        .unwrap();
    assert!(result.active);
    assert_eq!(fixture.evidence.calls.lock().unwrap()[0].2, 8);
    assert!(!fixture.portal.release(&native).unwrap().active);
    assert_eq!(fixture.evidence.closed.lock().unwrap().len(), 1);
    assert!(
        fixture.losses.try_recv().is_err(),
        "intentional release must not report unexpected loss"
    );
}
#[test]
fn private_bus_denial_is_never_active() {
    let fixture = Fixture::new(Outcome::Denied);
    let (native, original) = fixture.ticket();
    assert!(fixture
        .portal
        .acquire(native.clone(), original, Arc::new(|| Ok(())))
        .err()
        .unwrap()
        .contains("denied"));
    assert!(!fixture.portal.release(&native).unwrap().active);
}
#[test]
fn release_interrupts_pending_response_without_waiting_for_acquisition_serialization() {
    let fixture = Fixture::new(Outcome::NoResponse);
    fixture.cancel_pending(1, false);
}
#[test]
fn missing_response_and_stalled_method_reply_have_bounded_failure() {
    for outcome in [
        Outcome::NoResponse,
        Outcome::StalledReply,
        Outcome::SpoofedResponse,
    ] {
        let fixture = Fixture::new(outcome);
        let (native, original) = fixture.ticket();
        let started = std::time::Instant::now();
        assert!(fixture
            .portal
            .acquire(native.clone(), original, Arc::new(|| Ok(())))
            .is_err());
        assert!(started.elapsed() < ACQUIRE_LIMIT + CLOSE_LIMIT * 3);
        assert!(!fixture.portal.release(&native).unwrap().active);
    }
}
#[test]
fn malformed_response_and_unexpected_handle_are_not_acknowledgement() {
    for outcome in [
        Outcome::MalformedResponse,
        Outcome::UnexpectedHandle,
        Outcome::ForeignHandle,
    ] {
        let fixture = Fixture::new(outcome);
        let (native, original) = fixture.ticket();
        assert!(fixture
            .portal
            .acquire(native.clone(), original, Arc::new(|| Ok(())))
            .is_err());
        assert!(!fixture.portal.release(&native).unwrap().active);
        let closed = fixture.evidence.closed.lock().unwrap();
        if matches!(outcome, Outcome::UnexpectedHandle) {
            assert!(closed.iter().any(|handle| handle.ends_with("_different")));
        }
        assert!(
            !closed.iter().any(|handle| handle.ends_with("/not_owned")),
            "cleanup targeted another sender's path"
        );
    }
}
#[test]
fn late_acknowledgement_after_cancel_or_document_invalidation_cannot_restore_ownership() {
    for invalidate in [false, true] {
        let fixture = Fixture::new(Outcome::DelayedResponse);
        fixture.cancel_pending(1, invalidate);
        fixture
            .late_attempted
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let sender = fixture.evidence.calls.lock().unwrap()[0].0.clone();
        assert_eq!(
            fixture
                .departed
                .recv_timeout(Duration::from_secs(2))
                .unwrap(),
            sender
        );
        assert!(!fixture.portal.status().unwrap().active);
    }
}
#[test]
fn owner_shutdown_and_explicit_negative_response_report_original_identity_while_focused() {
    for disconnect in [true, false] {
        let fixture = Fixture::new(Outcome::Success);
        let (native, original) = fixture.own();
        if disconnect {
            fixture
                .connection
                .close_sync(gio::Cancellable::NONE)
                .unwrap();
        } else {
            let calls = fixture.evidence.calls.lock().unwrap();
            let (sender, handle, _) = &calls[0];
            fixture
                .connection
                .emit_signal(
                    Some(sender),
                    handle,
                    REQUEST,
                    "Response",
                    Some(&(2u32, HashMap::<String, glib::Variant>::new()).to_variant()),
                )
                .unwrap();
        }
        let (ended, _) = fixture.losses.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(same(&ended, &original));
        assert!(
            fixture.losses.try_recv().is_err(),
            "duplicate ownership-loss event"
        );
        assert!(!fixture.portal.status().unwrap().active);
        assert!(!fixture.portal.release(&native).unwrap().active);
    }
}
#[test]
fn stalled_close_falls_back_to_closing_only_the_owned_connection() {
    let fixture = Fixture::new(Outcome::StalledClose);
    let (native, original) = fixture.ticket();
    fixture
        .portal
        .acquire(native.clone(), original, Arc::new(|| Ok(())))
        .unwrap();
    let sender = fixture.evidence.calls.lock().unwrap()[0].0.clone();
    assert!(!fixture.portal.release(&native).unwrap().active);
    assert_eq!(
        fixture
            .departed
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        sender
    );
    assert!(
        !fixture.connection.is_closed(),
        "the portal service's connection is not client-owned"
    );
}
#[test]
fn repeated_pending_cancellation_retires_every_owned_bus_connection() {
    let fixture = Fixture::new(Outcome::NoResponse);
    for index in 0..8 {
        fixture.cancel_pending(index + 1, false);
        assert_eq!(
            fixture
                .departed
                .recv_timeout(Duration::from_secs(2))
                .unwrap(),
            fixture.evidence.calls.lock().unwrap()[index].0
        );
    }
}
#[test]
fn stale_unissued_and_already_released_tickets_never_reach_the_portal() {
    let fixture = Fixture::new(Outcome::Success);
    let (native, original) = fixture.ticket();
    for rejected in [
        Request {
            ticket: native.ticket + 1,
            ..native.clone()
        },
        Request {
            epoch: uuid::Uuid::new_v4().to_string(),
            ..native.clone()
        },
    ] {
        assert!(fixture
            .portal
            .acquire(rejected, original.clone(), Arc::new(|| Ok(())))
            .is_err());
    }
    fixture.portal.cancel(&native).unwrap();
    assert!(fixture
        .portal
        .acquire(native, original, Arc::new(|| Ok(())))
        .is_err());
    assert!(fixture.evidence.calls.lock().unwrap().is_empty());
}
#[test]
fn original_authority_is_checked_after_async_connection_setup_before_inhibit() {
    let fixture = Fixture::new(Outcome::Success);
    let (native, original) = fixture.ticket();
    assert!(fixture
        .portal
        .acquire(
            native.clone(),
            original,
            Arc::new(|| Err("original lease expired".into()))
        )
        .is_err());
    assert!(fixture.evidence.calls.lock().unwrap().is_empty());
    assert!(!fixture.portal.release(&native).unwrap().active);
}
#[test]
fn dropping_the_native_owner_retires_its_private_connection() {
    let mut fixture = Fixture::new(Outcome::Success);
    let (native, original) = fixture.ticket();
    fixture
        .portal
        .acquire(native, original, Arc::new(|| Ok(())))
        .unwrap();
    let old = std::mem::replace(
        &mut fixture.portal,
        Portal::new(fixture.main_loop.context(), None, Arc::new(|_, _| {})),
    );
    drop(old);
    assert_eq!(
        fixture
            .departed
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        fixture.evidence.calls.lock().unwrap()[0].0
    );
}
#[test]
fn an_acknowledged_request_outlives_its_acquisition_deadline_and_ignores_duplicate_confirmation() {
    let fixture = Fixture::new(Outcome::Success);
    let (native, original) = fixture.ticket();
    fixture
        .portal
        .acquire(native.clone(), original, Arc::new(|| Ok(())))
        .unwrap();
    // The acquisition deadline must not become a lifetime limit for an active request.
    thread::sleep(ACQUIRE_LIMIT + Duration::from_millis(20));
    let pending = fixture
        .portal
        .0
        .state
        .lock()
        .unwrap()
        .policy
        .active
        .as_ref()
        .unwrap()
        .1
        .clone();
    let (sent, received) = mpsc::sync_channel(1);
    fixture.portal.0.context.invoke(move || {
        pending.confirm();
        sent.send((
            pending.phase.load(Ordering::SeqCst),
            pending.bus.lock().unwrap().closing,
        ))
        .unwrap();
    });
    assert_eq!(
        received.recv_timeout(Duration::from_secs(2)).unwrap(),
        (1, false)
    );
    assert!(fixture.portal.status().unwrap().active);
    assert!(!fixture.portal.release(&native).unwrap().active);
}
#[test]
fn losing_the_owned_bus_connection_reports_loss_without_a_window_transition() {
    let mut fixture = Fixture::new(Outcome::Success);
    let (native, original) = fixture.own();
    fixture.daemon.stop();
    let (ended, reason) = fixture.losses.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(same(&ended, &original));
    assert!(reason.contains("connection closed"));
    assert!(!fixture.portal.release(&native).unwrap().active);
}
#[test]
fn setup_and_cleanup_dispatch_never_execute_inline_on_an_unowned_context() {
    for operation in ["setup", "cleanup"] {
        let context = glib::MainContext::default();
        let queued = context.clone();
        let (sent, received) = mpsc::sync_channel(1);
        let caller = thread::spawn(move || {
            let caller = thread::current().id();
            dispatch(&queued, move || {
                sent.send(thread::current().id()).unwrap();
            });
            caller
        })
        .join()
        .unwrap();
        assert!(
            received.try_recv().is_err(),
            "{operation} ran inline on a worker before the context owner iterated"
        );
        let owner = thread::current().id();
        assert_ne!(caller, owner);
        context
            .with_thread_default(|| {
                assert!(context.iteration(false));
            })
            .unwrap();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            owner
        );
    }
}
