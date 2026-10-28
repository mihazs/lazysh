//! Real xdg-desktop-portal frontend, controlled implementation, isolated bus only.
//! This proves protocol interoperability, not compositor or physical idle behavior.
use super::*;
use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

thread_local! {
    static HELD: RefCell<HashMap<String, gio::DBusMethodInvocation>> = RefCell::new(HashMap::new());
}
const BACKEND: &str = "org.freedesktop.impl.portal.LazyshTest";
const IMPL_REQUEST: &str = "org.freedesktop.impl.portal.Request";
const IMPL_XML: &str = "<node><interface name='org.freedesktop.impl.portal.Inhibit'><property name='version' type='u' access='read'/><method name='Inhibit'><arg type='o' direction='in'/><arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='u' direction='in'/><arg type='a{sv}' direction='in'/></method></interface><interface name='org.freedesktop.impl.portal.Request'><method name='Close'/></interface></node>";

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = Path::new("/tmp").join(format!("lazysh-portal-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        let sandbox = Self(path);
        for name in [
            "home", "runtime", "config", "cache", "data", "portals", "services",
        ] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(sandbox.0.join(name))
                .unwrap();
        }
        sandbox
    }
    fn command(&self, executable: &str, address: &str) -> Command {
        // Only these children see these values. In particular, inherit neither the
        // user's bus nor display, portal selection, preload or system-bus address.
        let mut command = Command::new(executable);
        command
            .env_clear()
            .current_dir(&self.0)
            .env("LANG", "C")
            .env("GSETTINGS_SCHEMA_DIR", "/usr/share/glib-2.0/schemas")
            .env("GSETTINGS_BACKEND", "memory")
            .env("HOME", self.0.join("home"))
            .env("TMPDIR", self.0.join("runtime"))
            .env("XDG_RUNTIME_DIR", self.0.join("runtime"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_CONFIG_DIRS", self.0.join("config"))
            .env("XDG_CACHE_HOME", self.0.join("cache"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("XDG_DATA_DIRS", self.0.join("data"))
            .env("XDG_DESKTOP_PORTAL_DIR", self.0.join("portals"))
            .env("XDG_CURRENT_DESKTOP", "lazysh-test")
            .env("DBUS_SESSION_BUS_ADDRESS", address)
            .env("DBUS_SYSTEM_BUS_ADDRESS", address)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        command
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn installed(name: &str) -> String {
    ["/usr/libexec", "/usr/lib"]
        .into_iter()
        .map(|directory| Path::new(directory).join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("Linux interoperability tests require installed {name}"))
        .to_str()
        .unwrap()
        .to_owned()
}
fn owner(connection: &gio::DBusConnection, name: &str) -> Result<String, glib::Error> {
    connection
        .call_sync(
            Some(DBUS.0),
            DBUS.1,
            DBUS.2,
            "GetNameOwner",
            Some(&(name,).to_variant()),
            None,
            gio::DBusCallFlags::NONE,
            200,
            gio::Cancellable::NONE,
        )
        .map(|reply| reply.get::<(String,)>().unwrap().0)
}
fn wait_owner(connection: &gio::DBusConnection, name: &str, child: &mut OwnedDaemon) -> String {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(owner) = owner(connection, name) {
            return owner;
        }
        assert!(
            child.0.as_mut().unwrap().try_wait().unwrap().is_none(),
            "{name} exited before owning its private-bus name"
        );
        assert!(
            Instant::now() < until,
            "{name} private-bus startup deadline"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

struct RealFrontend {
    portal: Portal,
    evidence: Arc<Evidence>,
    frontend_owner: String,
    connection: gio::DBusConnection,
    main_loop: glib::MainLoop,
    thread: Option<thread::JoinHandle<()>>,
    frontend: OwnedDaemon,
    permissions: OwnedDaemon,
    bus: OwnedDaemon,
    _sandbox: Sandbox,
}
impl RealFrontend {
    fn new(held: bool) -> Self {
        let sandbox = Sandbox::new();
        // Only the already-running frontend is discoverable by StartServiceByName.
        // Its sole private activation entry fails closed if it is not running;
        // no installed/user backend or service can be activated.
        fs::write(
            sandbox
                .0
                .join("services/org.freedesktop.portal.Desktop.service"),
            "[D-BUS Service]\nName=org.freedesktop.portal.Desktop\nExec=/usr/bin/false\n",
        )
        .unwrap();
        let bus_config = sandbox.0.join("bus.conf");
        fs::write(&bus_config, format!("<busconfig><type>session</type><listen>unix:tmpdir={}</listen><auth>EXTERNAL</auth><servicedir>{}</servicedir><policy context='default'><allow send_destination='*'/><allow receive_sender='*'/><allow own='*'/></policy></busconfig>", sandbox.0.join("runtime").display(), sandbox.0.join("services").display())).unwrap();
        let mut command =
            sandbox.command("/usr/bin/dbus-daemon", "unix:path=/nonexistent/lazysh-test");
        command
            .arg(format!("--config-file={}", bus_config.display()))
            .args(["--nofork", "--print-address=1"]);
        let (bus, address) = start_bus(command);
        let (context, main_loop, worker) = event_loop();
        let evidence = Arc::new(Evidence::default());
        let observed = evidence.clone();
        let backend_address = address.clone();
        let (ready, started) = mpsc::sync_channel(1);
        context.invoke(move || {
            let connection = private_connection(&backend_address);
            connection
                .call_sync(
                    Some(DBUS.0),
                    DBUS.1,
                    DBUS.2,
                    "RequestName",
                    Some(&(BACKEND, 0u32).to_variant()),
                    None,
                    gio::DBusCallFlags::NONE,
                    1000,
                    gio::Cancellable::NONE,
                )
                .unwrap();
            let node = gio::DBusNodeInfo::for_xml(IMPL_XML).unwrap();
            connection
                .register_object(
                    PATH,
                    &node
                        .lookup_interface("org.freedesktop.impl.portal.Inhibit")
                        .unwrap(),
                    move |connection, sender, _, _, method, parameters, invocation| {
                        assert_eq!(method, "Inhibit");
                        let (handle, _app_id, window, flags, options) = parameters
                            .get::<(
                                glib::variant::ObjectPath,
                                String,
                                String,
                                u32,
                                HashMap<String, glib::Variant>,
                            )>()
                            .unwrap();
                        assert!(window.is_empty());
                        assert_eq!(
                            options.get("reason").unwrap().get::<String>().unwrap(),
                            "Keep the visible lazysh agents board awake"
                        );
                        let handle = handle.as_str().to_owned();
                        let closed = observed.clone();
                        connection
                            .register_object(
                                &handle,
                                &gio::DBusNodeInfo::for_xml(IMPL_XML)
                                    .unwrap()
                                    .lookup_interface(IMPL_REQUEST)
                                    .unwrap(),
                                move |_, _, path, _, method, _, invocation| {
                                    assert_eq!(method, "Close");
                                    closed.closed.lock().unwrap().push(path.into());
                                    closed.changed.notify_all();
                                    invocation.return_value(None);
                                    HELD.with(|pending| {
                                        if let Some(reply) = pending.borrow_mut().remove(path) {
                                            reply.return_value(None);
                                        }
                                    });
                                },
                                |_, _, _, _, _| ().to_variant(),
                                |_, _, _, _, _, _| false,
                            )
                            .unwrap();
                        observed.calls.lock().unwrap().push((
                            sender.to_owned(),
                            handle.clone(),
                            flags,
                        ));
                        observed.changed.notify_all();
                        if held {
                            HELD.with(|pending| {
                                pending.borrow_mut().insert(handle, invocation);
                            });
                        } else {
                            invocation.return_value(None);
                        }
                    },
                    |_, _, _, _, _| 3u32.to_variant(),
                    |_, _, _, _, _, _| false,
                )
                .unwrap();
            ready.send(connection).unwrap();
        });
        let connection = started.recv_timeout(Duration::from_secs(2)).unwrap();
        let activatable = connection
            .call_sync(
                Some(DBUS.0),
                DBUS.1,
                DBUS.2,
                "ListActivatableNames",
                None,
                None,
                gio::DBusCallFlags::NONE,
                1000,
                gio::Cancellable::NONE,
            )
            .unwrap()
            .get::<(Vec<String>,)>()
            .unwrap()
            .0;
        assert!(activatable.iter().any(|name| name == BUS));
        assert!(activatable.iter().all(|name| name == BUS || name == DBUS.0));
        // Portal 1.14 selects the backend through UseIn, before portals.conf existed.
        fs::write(
            sandbox.0.join("portals/lazysh-test.portal"),
            format!(
                "[portal]\nDBusName={BACKEND}\nInterfaces=org.freedesktop.impl.portal.Inhibit;\nUseIn=lazysh-test;\n"
            ),
        )
        .unwrap();
        fs::write(
            sandbox.0.join("portals/lazysh-test-portals.conf"),
            "[preferred]\ndefault=lazysh-test;\n",
        )
        .unwrap();
        let mut fixture = Self {
            portal: Portal::new(
                context,
                Some(address.clone()),
                Arc::new(|_, reason| panic!("unexpected real-frontend loss: {reason}")),
            ),
            evidence,
            frontend_owner: String::new(),
            connection,
            main_loop,
            thread: Some(worker),
            frontend: OwnedDaemon(None),
            permissions: OwnedDaemon(None),
            bus,
            _sandbox: sandbox,
        };
        fixture.permissions = OwnedDaemon(Some(
            fixture
                ._sandbox
                .command(&installed("xdg-permission-store"), &address)
                .spawn()
                .unwrap(),
        ));
        wait_owner(
            &fixture.connection,
            "org.freedesktop.impl.portal.PermissionStore",
            &mut fixture.permissions,
        );
        fixture.frontend = OwnedDaemon(Some(
            fixture
                ._sandbox
                .command(&installed("xdg-desktop-portal"), &address)
                .spawn()
                .unwrap(),
        ));
        fixture.frontend_owner = wait_owner(&fixture.connection, BUS, &mut fixture.frontend);

        fixture
    }
    fn ticket(&self) -> Request {
        let status = self.portal.status().unwrap();
        Request {
            epoch: status.epoch,
            ticket: status.ticket,
        }
    }
    fn wait_for(&self, predicate: impl Fn(&Evidence) -> bool) {
        let until = Instant::now() + Duration::from_secs(2);
        while !predicate(&self.evidence) {
            assert!(
                Instant::now() < until,
                "controlled backend observation deadline"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for RealFrontend {
    fn drop(&mut self) {
        retire(&self.portal);
        self.frontend.stop();
        self.permissions.stop();
        stop_loop(
            &self.portal,
            &self.connection,
            &self.main_loop,
            &mut self.thread,
            || {
                HELD.with(|pending| pending.borrow_mut().clear());
            },
        );
        self.bus.stop();
    }
}
#[test]
fn real_portal_frontend_acknowledges_and_closes_the_owned_backend_request() {
    let fixture = RealFrontend::new(false);
    let native = fixture.ticket();
    assert!(
        fixture
            .portal
            .acquire(native.clone(), native.clone(), Arc::new(|| Ok(())))
            .unwrap()
            .active
    );
    let calls = fixture.evidence.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, fixture.frontend_owner);
    assert_eq!(calls[0].2, 8);
    assert!(!fixture.portal.release(&native).unwrap().active);
    fixture.wait_for(|evidence| evidence.closed.lock().unwrap().len() == 1);
    assert_eq!(
        *fixture.evidence.closed.lock().unwrap(),
        vec![calls[0].1.clone()]
    );
}
#[test]
fn real_portal_frontend_cancellation_closes_a_pending_backend_without_adoption() {
    let fixture = RealFrontend::new(true);
    let native = fixture.ticket();
    thread::scope(|scope| {
        let pending = scope.spawn(|| {
            fixture
                .portal
                .acquire(native.clone(), native.clone(), Arc::new(|| Ok(())))
        });
        fixture.wait_for(|evidence| evidence.calls.lock().unwrap().len() == 1);
        fixture.portal.cancel(&native).unwrap();
        assert!(pending.join().unwrap().is_err());
    });
    fixture.wait_for(|evidence| evidence.closed.lock().unwrap().len() == 1);
    assert!(!fixture.portal.release(&native).unwrap().active);
    assert_eq!(
        fixture.evidence.calls.lock().unwrap()[0].0,
        fixture.frontend_owner
    );
}
