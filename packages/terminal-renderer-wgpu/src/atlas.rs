//! A glyph atlas of bounded size with least-recently-used eviction.
//!
//! The texture is a grid of slots the size of one cell (narrow glyphs) or two cells (wide ones),
//! so evicting a glyph frees exactly the room of the next one: there is no fragmentation and no
//! compaction, and the memory is fixed when the atlas is created. A glyph is rasterized once per
//! (cluster, width, weight) while it stays resident. Slots used since [`Atlas::begin_batch`] are
//! never evicted, because the draw that references them has not been submitted yet; when a batch
//! needs more than the atlas holds, [`Slot::Full`] tells the caller to submit and begin again.

use lazysh_terminal_runtime::CellMetrics;
use std::collections::HashMap;
use std::sync::Arc;

const NONE: u32 = u32::MAX;
const VARIANTS: usize = 4;

/// The masks one cluster can have: narrow or wide, regular or bold.
fn variant(wide: bool, bold: bool) -> usize {
    usize::from(wide) * 2 + usize::from(bold)
}

#[derive(Debug)]
struct Node {
    text: Option<Arc<str>>,
    variant: u8,
    prev: u32,
    next: u32,
    /// The batch that last used the slot.
    used: u64,
}

/// Slots of one size in a rectangle of the texture, linked from most to least recently used.
#[derive(Debug)]
struct Pool {
    nodes: Vec<Node>,
    head: u32,
    tail: u32,
    /// Slots per texture row, and the pixel origin and size of the first slot.
    per_row: u32,
    origin_y: u32,
    size: (u32, u32),
}

impl Pool {
    fn new(per_row: u32, rows: u32, origin_y: u32, size: (u32, u32)) -> Self {
        let count = per_row * rows;
        let nodes = (0..count)
            .map(|i| Node {
                text: None,
                variant: 0,
                prev: if i == 0 { NONE } else { i - 1 },
                next: if i + 1 == count { NONE } else { i + 1 },
                used: 0,
            })
            .collect();
        Self {
            nodes,
            head: if count == 0 { NONE } else { 0 },
            tail: if count == 0 { NONE } else { count - 1 },
            per_row,
            origin_y,
            size,
        }
    }

    fn position(&self, slot: u32) -> (u32, u32) {
        (
            slot % self.per_row * self.size.0,
            self.origin_y + slot / self.per_row * self.size.1,
        )
    }

    fn unlink(&mut self, slot: u32) {
        let Node { prev, next, .. } = self.nodes[slot as usize];
        match prev {
            NONE => self.head = next,
            p => self.nodes[p as usize].next = next,
        }
        match next {
            NONE => self.tail = prev,
            n => self.nodes[n as usize].prev = prev,
        }
    }

    fn push_front(&mut self, slot: u32) {
        let old = self.head;
        let node = &mut self.nodes[slot as usize];
        (node.prev, node.next) = (NONE, old);
        match old {
            NONE => self.tail = slot,
            o => self.nodes[o as usize].prev = slot,
        }
        self.head = slot;
    }

    fn touch(&mut self, slot: u32, batch: u64) {
        self.nodes[slot as usize].used = batch;
        if self.head != slot {
            self.unlink(slot);
            self.push_front(slot);
        }
    }
}

/// What [`Atlas::slot`] found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Slot {
    /// Resident: the glyph's mask is at this texel origin.
    Hit((u32, u32)),
    /// The caller must write the mask into the slot at this origin before the next submit.
    Miss((u32, u32)),
    /// Every slot of the size is in use by the current batch.
    Full,
}

#[derive(Debug)]
pub(crate) struct Atlas {
    pub size: u32,
    pools: [Pool; 2],
    slots: HashMap<Arc<str>, [u32; VARIANTS]>,
    batch: u64,
    evictions: u64,
}

impl Atlas {
    /// An atlas of `size` x `size` texels for cells of `metrics`. A quarter of the slot rows (at
    /// least one) hold wide glyphs. `None` when the texture cannot hold a narrow and a wide slot.
    pub fn new(size: u32, metrics: CellMetrics) -> Option<Self> {
        let (w, h) = (metrics.cell_width, metrics.cell_height);
        let rows = size / h;
        let wide_rows = (rows / 4).max(1);
        if rows < 2 || size < 2 * w {
            return None;
        }
        let narrow_rows = rows - wide_rows;
        Some(Self {
            size,
            pools: [
                Pool::new(size / w, narrow_rows, 0, (w, h)),
                Pool::new(size / (2 * w), wide_rows, narrow_rows * h, (2 * w, h)),
            ],
            slots: HashMap::new(),
            batch: 1,
            evictions: 0,
        })
    }

    pub fn capacity(&self) -> usize {
        self.pools.iter().map(|p| p.nodes.len()).sum()
    }

    pub fn resident(&self) -> usize {
        self.slots
            .values()
            .map(|v| v.iter().filter(|&&s| s != NONE).count())
            .sum()
    }

    /// Slots of everything resident may be reused from now on: the previous batch was submitted.
    pub fn begin_batch(&mut self) {
        self.batch += 1;
    }

    /// Evictions since the last call.
    pub fn take_evictions(&mut self) -> u64 {
        std::mem::take(&mut self.evictions)
    }

    pub fn slot(&mut self, text: &str, wide: bool, bold: bool) -> Slot {
        let (pool, v) = (usize::from(wide), variant(wide, bold));
        if let Some(&id) = self
            .slots
            .get(text)
            .map(|ids| &ids[v])
            .filter(|&&id| id != NONE)
        {
            self.pools[pool].touch(id, self.batch);
            return Slot::Hit(self.pools[pool].position(id));
        }
        let Some(id) = self.reuse(pool) else {
            return Slot::Full;
        };
        let text: Arc<str> = Arc::from(text);
        let node = &mut self.pools[pool].nodes[id as usize];
        (node.text, node.variant) = (Some(text.clone()), v as u8);
        self.pools[pool].touch(id, self.batch);
        self.slots.entry(text).or_insert([NONE; VARIANTS])[v] = id;
        Slot::Miss(self.pools[pool].position(id))
    }

    /// The least recently used slot of a pool, emptied; `None` when the current batch uses all.
    fn reuse(&mut self, pool: usize) -> Option<u32> {
        let tail = self.pools[pool].tail;
        if tail == NONE || self.pools[pool].nodes[tail as usize].used == self.batch {
            return None;
        }
        let node = &mut self.pools[pool].nodes[tail as usize];
        if let Some(old) = node.text.take() {
            let v = usize::from(node.variant);
            if let Some(ids) = self.slots.get_mut(&old) {
                ids[v] = NONE;
                if ids.iter().all(|&id| id == NONE) {
                    self.slots.remove(&old);
                }
            }
            self.evictions += 1;
        }
        Some(tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atlas() -> Atlas {
        // 64 x 64 texels, 8 x 16 cells: 4 slot rows, 3 of 8 narrow slots and 1 of 4 wide slots.
        Atlas::new(64, CellMetrics::default()).unwrap()
    }

    fn miss(slot: Slot) -> (u32, u32) {
        match slot {
            Slot::Miss(at) => at,
            other => panic!("expected a miss, got {other:?}"),
        }
    }

    #[test]
    fn slots_tile_the_texture_without_overlap() {
        let mut a = atlas();
        assert_eq!(a.capacity(), 24 + 4);
        let mut seen = std::collections::HashSet::new();
        for i in 0..24 {
            let at = miss(a.slot(&format!("n{i}"), false, false));
            assert!(
                at.0 + 8 <= 64 && at.1 + 16 <= 48,
                "narrow slots stay above the wide row"
            );
            assert!(seen.insert(at), "{at:?} handed out twice");
        }
        for i in 0..4 {
            let at = miss(a.slot(&format!("w{i}"), true, false));
            assert!(at.0 + 16 <= 64 && at.1 == 48);
            assert!(seen.insert(at));
        }
    }

    #[test]
    fn a_resident_glyph_hits_at_the_same_place_and_weights_are_separate() {
        let mut a = atlas();
        let at = miss(a.slot("a", false, false));
        assert_eq!(a.slot("a", false, false), Slot::Hit(at));
        assert_ne!(miss(a.slot("a", false, true)), at, "bold is another mask");
        assert_ne!(miss(a.slot("a", true, false)), at, "so is a wide one");
        assert_eq!(a.resident(), 3);
    }

    #[test]
    fn the_least_recently_used_glyph_is_evicted_once_the_batch_moves_on() {
        let mut a = atlas();
        let first: Vec<_> = (0..24)
            .map(|i| miss(a.slot(&format!("n{i}"), false, false)))
            .collect();
        assert_eq!(
            a.slot("extra", false, false),
            Slot::Full,
            "all 24 belong to the batch that is still being drawn"
        );
        a.begin_batch();
        a.slot("n0", false, false); // the oldest becomes the newest
        assert_eq!(
            miss(a.slot("extra", false, false)),
            first[1],
            "n1 was the victim"
        );
        assert_eq!(a.take_evictions(), 1);
        assert_eq!(a.take_evictions(), 0, "counted once");
        assert!(
            matches!(a.slot("n0", false, false), Slot::Hit(_)),
            "n0 was refreshed"
        );
        assert!(
            matches!(a.slot("n1", false, false), Slot::Miss(_)),
            "n1 is gone"
        );
        assert_eq!(
            a.resident(),
            24,
            "the atlas never holds more than its slots"
        );
    }

    #[test]
    fn churn_never_grows_the_atlas() {
        let mut a = atlas();
        for i in 0..10_000 {
            if i % 4 == 0 {
                a.begin_batch();
            }
            a.slot(&format!("g{i}"), i % 3 == 0, i % 5 == 0);
            assert!(a.resident() <= a.capacity());
        }
        assert!(a.take_evictions() > 9_000 - a.capacity() as u64);
    }

    #[test]
    fn a_texture_too_small_for_a_wide_slot_has_no_atlas() {
        assert!(Atlas::new(8, CellMetrics::default()).is_none());
        let tall = CellMetrics {
            cell_height: 40,
            ..CellMetrics::default()
        };
        assert!(Atlas::new(64, tall).is_none());
    }
}
