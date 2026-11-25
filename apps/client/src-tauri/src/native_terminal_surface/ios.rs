use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject, MainThreadOnly};
use objc2_foundation::{
    MainThreadMarker, NSNotificationCenter, NSObjectProtocol, NSOperationQueue, NSRect,
};
use objc2_quartz_core::{CAMetalLayer, CATransaction};
use objc2_ui_kit::{
    UIAccessibilityIsVoiceOverRunning, UIAccessibilityVoiceOverStatusDidChangeNotification,
    UIApplication, UIApplicationDidBecomeActiveNotification, UIApplicationState,
    UIApplicationWillResignActiveNotification, UIView,
};
use std::cell::RefCell;

pub(super) type View = UIView;

thread_local! {
    // UIKit lifecycle observers live as long as the app's main web view.
    static OBSERVERS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
        const { RefCell::new(Vec::new()) };
}

pub(super) fn active(mtm: MainThreadMarker) -> bool {
    UIApplication::sharedApplication(mtm).applicationState() == UIApplicationState::Active
}

pub(super) fn watch_activity(changed: fn(bool)) {
    let center = NSNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    // SAFETY: These names are immutable UIKit notification constants and the handlers run on the main queue.
    let observers = unsafe {
        [
            (UIApplicationWillResignActiveNotification, false),
            (UIApplicationDidBecomeActiveNotification, true),
        ]
        .map(|(name, active)| {
            let block = RcBlock::new(move |_| changed(active));
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                Some(&queue),
                &block,
            )
        })
    };
    OBSERVERS.with_borrow_mut(|existing| existing.extend(observers));
}

pub(super) fn watch_voice_over(app: tauri::AppHandle) {
    use tauri::Emitter;
    let center = NSNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    let block = RcBlock::new(move |_| {
        let _ = app.emit(
            "ios-voice-over-changed",
            UIAccessibilityIsVoiceOverRunning(),
        );
    });
    // SAFETY: The notification name is a UIKit constant and the handler runs on the main queue.
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(UIAccessibilityVoiceOverStatusDidChangeNotification),
            None,
            Some(&queue),
            &block,
        )
    };
    OBSERVERS.with_borrow_mut(|observers| observers.push(observer));
}

pub(super) fn geometry(web: &View) -> Result<(Retained<View>, f64, bool), String> {
    let parent = web.superview().ok_or("The web view has no parent")?;
    let scale = parent
        .window()
        .ok_or("The web view has no window")?
        .screen()
        .scale();
    Ok((parent, scale, true))
}

pub(super) fn new_view(
    web: &View,
    parent: &View,
    frame: NSRect,
    layer: &CAMetalLayer,
    mtm: MainThreadMarker,
) -> Retained<View> {
    let view = View::initWithFrame(View::alloc(mtm), frame);
    view.setUserInteractionEnabled(false);
    view.setClipsToBounds(true);
    layer.setFrame(view.bounds());
    view.layer().addSublayer(layer);
    parent.insertSubview_belowSubview(&view, web);
    view
}

pub(super) fn resize_layer(view: &View, layer: &CAMetalLayer) {
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    layer.setFrame(view.bounds());
    CATransaction::commit();
}
