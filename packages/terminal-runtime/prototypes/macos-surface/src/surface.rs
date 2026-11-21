//! The native surface: an `NSView` that hosts a `CAMetalLayer`, a sibling of the web view inside wry's `WryWebViewParent`.
//! It clears to one colour when asked and draws nothing else.
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::MainThreadOnly;
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use objc2_metal::{
    MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
    MTLCreateSystemDefaultDevice, MTLDevice, MTLLoadAction, MTLPixelFormat,
    MTLRenderPassDescriptor, MTLStoreAction,
};
use objc2_quartz_core::{CALayer, CAMetalDrawable, CAMetalLayer};

pub struct Surface {
    view: Retained<NSView>,
    layer: Retained<CAMetalLayer>,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    color: MTLClearColor,
}

impl Surface {
    /// Inserts the view into `parent`, below `web` (or above it, for the comparison that must fail). Nothing is drawn or sized yet.
    pub fn new(
        mtm: MainThreadMarker,
        parent: &NSView,
        web: &NSView,
        above: bool,
        rgb: u32,
    ) -> Result<Self, String> {
        let device = MTLCreateSystemDefaultDevice().ok_or("no Metal device")?;
        let queue = device.newCommandQueue().ok_or("no Metal command queue")?;
        let layer = CAMetalLayer::new();
        layer.setDevice(Some(&device));
        layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        layer.setOpaque(true);
        let view = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0)),
        );
        // A layer-hosting view: the layer is ours and AppKit keeps its frame equal to the view's bounds.
        let host: &CALayer = &layer;
        view.setLayer(Some(host));
        view.setWantsLayer(true);
        let order = if above {
            NSWindowOrderingMode::Above
        } else {
            NSWindowOrderingMode::Below
        };
        parent.addSubview_positioned_relativeTo(&view, order, Some(web));
        let channel = |shift: u32| f64::from((rgb >> shift) & 0xff) / 255.0;
        let color = MTLClearColor {
            red: channel(16),
            green: channel(8),
            blue: channel(0),
            alpha: 1.0,
        };
        Ok(Self {
            view,
            layer,
            queue,
            color,
        })
    }

    pub fn view(&self) -> &NSView {
        &self.view
    }

    /// Puts the surface at an anchor given in CSS pixels from the web view's top left corner, with `scale` device pixels per point,
    /// and draws it again (resizing a drawable discards its contents).
    pub fn place(&self, parent: &NSView, css: [f64; 4], scale: f64) {
        let height = parent.bounds().size.height;
        let y = if parent.isFlipped() {
            css[1]
        } else {
            height - css[1] - css[3]
        };
        self.view.setFrame(NSRect::new(
            NSPoint::new(css[0], y),
            NSSize::new(css[2], css[3]),
        ));
        self.layer.setContentsScale(scale);
        self.layer.setDrawableSize(NSSize::new(
            (css[2] * scale).round(),
            (css[3] * scale).round(),
        ));
        self.paint();
    }

    pub fn paint(&self) {
        let Some(drawable) = self.layer.nextDrawable() else {
            return;
        };
        let pass = MTLRenderPassDescriptor::renderPassDescriptor();
        let attachment = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setTexture(Some(&drawable.texture()));
        attachment.setLoadAction(MTLLoadAction::Clear);
        attachment.setStoreAction(MTLStoreAction::Store);
        attachment.setClearColor(self.color);
        let Some(commands) = self.queue.commandBuffer() else {
            return;
        };
        let Some(encoder) = commands.renderCommandEncoderWithDescriptor(&pass) else {
            return;
        };
        encoder.endEncoding();
        commands.presentDrawable(ProtocolObject::from_ref(&*drawable));
        commands.commit();
        commands.waitUntilCompleted();
    }

    pub fn remove(self) {
        self.view.removeFromSuperview();
    }
}
