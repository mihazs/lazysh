use std::collections::VecDeque;
use std::time::Duration;
use tokio::time::Instant;

// The reference behavior specifies a small inter-step delay without a duration.
pub(crate) const STEP_DELAY: Duration = Duration::from_millis(50);

pub(crate) struct InputSequence {
    steps: VecDeque<Vec<u8>>,
    offset: usize,
    ready_at: Instant,
    admitted_at: Instant,
}

impl From<String> for InputSequence {
    fn from(data: String) -> Self {
        let now = Instant::now();
        Self {
            steps: if data.is_empty() {
                VecDeque::new()
            } else {
                [data.into_bytes()].into()
            },
            offset: 0,
            ready_at: now,
            admitted_at: now,
        }
    }
}

impl InputSequence {
    pub(crate) fn parse(data: String, steps: Option<Vec<String>>) -> Result<Self, String> {
        let Some(steps) = steps else {
            if data.len() > 65536 {
                return Err("Paste at most 64 KiB at once".into());
            }
            return Ok(data.into());
        };
        if !data.is_empty()
            || steps.is_empty()
            || steps.len() > 8
            || steps.iter().any(String::is_empty)
            || steps.iter().map(String::len).sum::<usize>() > 65536
        {
            return Err("A terminal sequence needs 1–8 nonempty steps, at most 64 KiB total, and no separate data".into());
        }
        let now = Instant::now();
        Ok(Self {
            steps: steps.into_iter().map(String::into_bytes).collect(),
            offset: 0,
            ready_at: now,
            admitted_at: now,
        })
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
    pub(crate) fn is_paced(&self) -> bool {
        self.steps.len() > 1
    }
    pub(crate) fn admitted_at(&self) -> Instant {
        self.admitted_at
    }
    pub(crate) fn ready_at(&self) -> Instant {
        self.ready_at
    }
    pub(crate) fn delay(&self) -> Duration {
        self.ready_at.saturating_duration_since(Instant::now())
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.steps.front().expect("input step exists")[self.offset..]
    }
    pub(crate) fn advance(&mut self, count: usize) {
        assert!(count <= self.bytes().len());
        self.offset += count;
        if self.offset == self.steps.front().unwrap().len() {
            self.steps.pop_front();
            self.offset = 0;
            if !self.steps.is_empty() {
                self.ready_at = Instant::now() + STEP_DELAY;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn delay_starts_after_complete_dispatch_with_no_leading_or_trailing_wait() {
        let mut input = InputSequence::parse(
            String::new(),
            Some(vec!["\x1b[24~".into(), "h".into(), "\r".into()]),
        )
        .unwrap();
        assert_eq!(input.delay(), Duration::ZERO);
        input.advance(1);
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(input.delay(), Duration::ZERO);
        assert_eq!(input.bytes(), b"[24~");
        input.advance(4);
        assert_eq!(input.delay(), STEP_DELAY);
        tokio::time::advance(STEP_DELAY - Duration::from_millis(1)).await;
        assert_eq!(input.delay(), Duration::from_millis(1));
        tokio::time::advance(Duration::from_millis(1)).await;
        input.advance(1);
        assert_eq!(input.delay(), STEP_DELAY);
        tokio::time::advance(STEP_DELAY).await;
        input.advance(1);
        assert!(input.is_empty());
        assert_eq!(input.delay(), Duration::ZERO);
    }
    #[tokio::test(start_paused = true)]
    async fn admission_and_literal_text_do_not_add_delay_or_split_unicode() {
        let text = " 你好,, 😀 ";
        let mut literal = InputSequence::parse(text.into(), None).unwrap();
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(literal.delay(), Duration::ZERO);
        assert_eq!(literal.bytes(), text.as_bytes());
        literal.advance(text.len());
        assert!(literal.is_empty());
    }
    #[test]
    fn sequence_limits_preserve_one_queue_items_existing_byte_budget() {
        for steps in [
            vec![],
            vec![String::new()],
            vec!["a".into(); 9],
            vec!["x".repeat(65537)],
        ] {
            assert!(InputSequence::parse(String::new(), Some(steps)).is_err());
        }
        assert!(InputSequence::parse("data".into(), Some(vec!["a".into()])).is_err());
        assert!(InputSequence::parse(String::new(), Some(vec!["x".repeat(8192); 8])).is_ok());
        assert!(InputSequence::parse("x".repeat(65536), None).is_ok());
        assert!(InputSequence::parse("x".repeat(65537), None).is_err());
    }
}
