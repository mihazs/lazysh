//! One-shot real-read mutation seam shared by native transcript fixtures only.
use std::{
    cell::RefCell,
    fs::File,
    io::{self, Read},
};

thread_local! {
    static MUTATE: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
}
pub(super) fn set(action: impl FnOnce() + 'static) {
    MUTATE.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}
pub(super) fn clear() {
    MUTATE.with(|slot| {
        slot.borrow_mut().take();
    });
}
pub(super) struct ObservedRead<'a>(pub &'a mut File);
impl Read for ObservedRead<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.0.read(bytes)?;
        if count > 0 {
            MUTATE.with(|slot| {
                if let Some(mutate) = slot.borrow_mut().take() {
                    mutate();
                }
            });
        }
        Ok(count)
    }
}
