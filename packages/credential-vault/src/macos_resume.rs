//! AppKit privacy cover. Cocoa objects are retained as opaque addresses and used only on the main thread.
use block2::RcBlock;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject},
    sel, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApplicationDidUnhideNotification, NSApplicationWillHideNotification,
    NSAutoresizingMaskOptions, NSBezierPath, NSButton, NSColor, NSResponder, NSTextField, NSView,
    NSWindow, NSWindowDidDeminiaturizeNotification, NSWindowWillMiniaturizeNotification,
    NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification,
    NSWorkspaceScreensDidWakeNotification, NSWorkspaceSessionDidBecomeActiveNotification,
    NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNotificationName, NSObjectProtocol, NSOperationQueue,
    NSPoint, NSRect, NSSize, NSString,
};
use serde_json::{json, Value};
use std::{
    ptr::NonNull,
    sync::{Arc, Mutex},
};
use tauri::ipc::Channel;

#[derive(Default)]
struct NativeState {
    ready: bool,
    native_generation: u64,
    authority_generation: u64,
    enabled: Option<bool>,
    unlocked: bool,
    inactive: u8,
    view: usize,
    webviews: Vec<usize>,
    window: usize,
    notice: usize,
    events: Option<Channel<Value>>,
    owned: Vec<usize>,
    observers: Vec<(usize, usize)>,
}
impl NativeState {
    fn covered(&self) -> bool {
        self.enabled != Some(false) && (!self.unlocked || self.inactive != 0)
    }
    fn apply(
        &mut self,
        covered: bool,
        enabled: bool,
        generation: u64,
        native_generation: u64,
    ) -> bool {
        if !self.ready
            || generation < self.authority_generation
            || (!(covered && enabled) && native_generation != self.native_generation)
            || (!covered && enabled && self.inactive != 0)
        {
            return false;
        }
        self.authority_generation = generation;
        self.enabled = Some(enabled);
        self.unlocked = !covered;
        true
    }
}
#[derive(Clone, Default)]
pub struct MacResume {
    state: Arc<Mutex<NativeState>>,
}
struct CoverIvars {
    state: Arc<Mutex<NativeState>>,
}
define_class!(
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = CoverIvars]
    struct CoverView;
    unsafe impl NSObjectProtocol for CoverView {}
    impl CoverView {
        #[unsafe(method(isOpaque))]
        fn opaque(&self)->bool {true}
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_focus(&self)->bool {true}
        #[unsafe(method(drawRect:))]
        fn draw(&self,rect:NSRect) {NSColor::blackColor().setFill();NSBezierPath::fillRect(rect);}
        #[unsafe(method(unlockResume:))]
        fn unlock(&self,_sender:&AnyObject) {
            let state=self.ivars().state.lock().expect("native cover lock");
            if state.ready && state.covered() && state.inactive==0 {send(&state,"unlock");}
        }
    }
);
fn send(state: &NativeState, kind: &str) {
    if let Some(events) = &state.events {
        let _ = events.send(json!({"kind":kind,"nativeGeneration":state.native_generation}));
    }
}
fn keep<T: objc2::Message>(state: &mut NativeState, value: Retained<T>) -> usize {
    let pointer = Retained::into_raw(value).cast::<AnyObject>() as usize;
    state.owned.push(pointer);
    pointer
}
fn render(state: &NativeState) {
    if !state.ready {
        return;
    }
    MainThreadMarker::new().expect("AppKit cover must run on the main thread");
    // The pointers are retained in `owned` until destroy(), and this function only runs on the main thread.
    unsafe {
        let cover = &*(state.view as *const NSView);
        let window = &*(state.window as *const NSWindow);
        let covered = state.covered();
        cover.setHidden(!covered);
        for webview in &state.webviews {
            (&*(*webview as *const NSView)).setHidden(covered);
        }
        if covered {
            window.makeFirstResponder(Some(cover));
        }
    }
}
impl MacResume {
    pub fn ready(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.ready)
    }
    pub fn install(&self, window: usize, webview: usize) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("Native privacy cover requires the main thread")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native privacy cover lock failed")?;
        if state.ready {
            return Ok(());
        }
        // Tauri supplies live NSWindow/content-view objects. Retain them before installing observers.
        let window = unsafe { Retained::retain(window as *mut NSWindow) }
            .ok_or("Native window unavailable")?;
        let parent = unsafe { Retained::retain(webview as *mut NSView) }
            .ok_or("Native WebView container unavailable")?;
        let children = parent.subviews();
        if children.is_empty() {
            return Err("Native WebView is not ready".into());
        }
        for child in children.iter() {
            child.setHidden(true);
            let child = keep(&mut state, child);
            state.webviews.push(child);
        }
        let view = CoverView::alloc(mtm).set_ivars(CoverIvars {
            state: self.state.clone(),
        });
        let view: Retained<CoverView> =
            unsafe { msg_send![super(view),initWithFrame:parent.bounds()] };
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        let size = parent.bounds().size;
        let title = NSTextField::labelWithString(&NSString::from_str("lazysh is locked"), mtm);
        title.setTextColor(Some(&NSColor::whiteColor()));
        title.setFrame(NSRect::new(
            NSPoint::new(30.0, size.height / 2.0 + 45.0),
            NSSize::new((size.width - 60.0).max(100.0), 36.0),
        ));
        title.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewMinYMargin
                | NSAutoresizingMaskOptions::ViewMaxYMargin,
        );
        view.addSubview(&title);
        let button = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str("Unlock lazysh"),
                Some(&view),
                Some(sel!(unlockResume:)),
                mtm,
            )
        };
        button.setFrame(NSRect::new(
            NSPoint::new(30.0, size.height / 2.0 - 10.0),
            NSSize::new(180.0, 40.0),
        ));
        button.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewMinYMargin | NSAutoresizingMaskOptions::ViewMaxYMargin,
        );
        view.addSubview(&button);
        let notice = NSTextField::labelWithString(
            &NSString::from_str("Unlock with this device's biometrics to continue."),
            mtm,
        );
        notice.setTextColor(Some(&NSColor::whiteColor()));
        notice.setFrame(NSRect::new(
            NSPoint::new(30.0, size.height / 2.0 - 100.0),
            NSSize::new((size.width - 60.0).max(100.0), 72.0),
        ));
        notice.setMaximumNumberOfLines(3);
        notice.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewMinYMargin
                | NSAutoresizingMaskOptions::ViewMaxYMargin,
        );
        view.addSubview(&notice);
        state.notice = keep(&mut state, notice);
        parent.addSubview(&view);
        state.window = keep(&mut state, window);
        keep(&mut state, parent);
        state.view = keep(&mut state, view);
        state.ready = true;
        render(&state);
        drop(state);
        let center = NSNotificationCenter::defaultCenter();
        self.observe(
            &center,
            unsafe { NSApplicationWillHideNotification },
            None,
            1,
            true,
        )?;
        self.observe(
            &center,
            unsafe { NSApplicationDidUnhideNotification },
            None,
            1,
            false,
        )?;
        let object = unsafe { &*(window_address(&self.state)? as *const AnyObject) };
        self.observe(
            &center,
            unsafe { NSWindowWillMiniaturizeNotification },
            Some(object),
            2,
            true,
        )?;
        self.observe(
            &center,
            unsafe { NSWindowDidDeminiaturizeNotification },
            Some(object),
            2,
            false,
        )?;
        let workspace = NSWorkspace::sharedWorkspace();
        let center = workspace.notificationCenter();
        for (background, foreground, reason) in unsafe {
            [
                (
                    NSWorkspaceScreensDidSleepNotification,
                    NSWorkspaceScreensDidWakeNotification,
                    4,
                ),
                (
                    NSWorkspaceWillSleepNotification,
                    NSWorkspaceDidWakeNotification,
                    8,
                ),
                (
                    NSWorkspaceSessionDidResignActiveNotification,
                    NSWorkspaceSessionDidBecomeActiveNotification,
                    16,
                ),
            ]
        } {
            self.observe(&center, background, None, reason, true)?;
            self.observe(&center, foreground, None, reason, false)?;
        }
        Ok(())
    }
    fn observe(
        &self,
        center: &NSNotificationCenter,
        name: &NSNotificationName,
        object: Option<&AnyObject>,
        reason: u8,
        background: bool,
    ) -> Result<(), String> {
        let shared = self.state.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let Ok(mut state) = shared.lock() else {
                return;
            };
            if !state.ready {
                return;
            }
            if background {
                state.native_generation = state.native_generation.wrapping_add(1);
                state.inactive |= reason;
                state.unlocked = false;
                render(&state);
                send(&state, "background");
            } else {
                state.inactive &= !reason;
                render(&state);
                if state.inactive == 0 {
                    send(&state, "foreground");
                }
            }
        });
        // Main operation queue keeps all AppKit and generation transitions on the UI thread.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                object,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        let center = unsafe {
            Retained::retain(center as *const NSNotificationCenter as *mut NSNotificationCenter)
        }
        .ok_or("Native notification center unavailable")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native privacy cover lock failed")?;
        let center = keep(&mut state, center);
        let observer = keep(&mut state, observer);
        state.observers.push((center, observer));
        Ok(())
    }
    pub fn register(&self, events: Channel<Value>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native privacy cover lock failed")?;
        state.events = Some(events);
        if state.ready {
            send(&state, "ready");
        }
        Ok(())
    }
    pub fn apply(
        &self,
        covered: bool,
        enabled: bool,
        generation: u64,
        native_generation: u64,
    ) -> Result<(), String> {
        MainThreadMarker::new().ok_or("Native privacy cover requires the main thread")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native privacy cover lock failed")?;
        if !state.apply(covered, enabled, generation, native_generation) {
            return Err("Native privacy cover generation changed".into());
        }
        render(&state);
        Ok(())
    }
    pub fn failure(&self) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        let Ok(state) = self.state.lock() else {
            return;
        };
        if state.ready && state.covered() && state.notice != 0 {
            // The text field owns a retain in `owned`; all access is on the main thread.
            unsafe {
                (&*(state.notice as *const NSTextField)).setStringValue(&NSString::from_str("Unlock failed or was cancelled. lazysh remains locked. Check device biometrics and retry."));
            }
        }
    }
    pub fn destroy(&self) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        let (observers, owned) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.ready = false;
            state.events = None;
            state.webviews.clear();
            state.view = 0;
            state.window = 0;
            state.notice = 0;
            state.unlocked = false;
            (
                std::mem::take(&mut state.observers),
                std::mem::take(&mut state.owned),
            )
        };
        for (center, observer) in observers {
            unsafe {
                (&*(center as *const NSNotificationCenter))
                    .removeObserver(&*(observer as *const AnyObject));
            }
        }
        // Release outside the state lock: Cocoa destruction can invoke application callbacks.
        for object in owned {
            unsafe {
                drop(Retained::<AnyObject>::from_raw(object as *mut AnyObject));
            }
        }
    }
}
fn window_address(state: &Mutex<NativeState>) -> Result<usize, String> {
    state
        .lock()
        .map(|state| state.window)
        .map_err(|_| "Native privacy cover lock failed".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_generation_blocks_stale_reveal_and_disabled_policy_keeps_defaults() {
        let mut state = NativeState {
            ready: true,
            ..Default::default()
        };
        assert!(state.covered());
        assert!(state.apply(false, true, 2, 0));
        assert!(!state.covered());
        state.native_generation = 1;
        state.unlocked = false;
        assert!(!state.apply(false, true, 3, 0));
        assert!(state.covered());
        assert!(state.apply(false, true, 3, 1));
        assert!(!state.apply(true, true, 2, 1));
        assert!(!state.covered());
        assert!(state.apply(false, false, 4, 1));
        state.inactive = 1;
        assert!(!state.covered());
        assert!(state.apply(false, false, 5, 1));
        assert!(state.apply(true, true, 6, 0));
        assert!(state.covered());
        assert!(!state.apply(false, true, 7, 1));
    }
}
