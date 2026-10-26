use crate::{Request, Status};

pub(crate) const MAX_TICKET: u64 = 9_007_199_254_740_991;
/// Metadata stays bounded even when release reaches native before acquisition.
pub(crate) struct Policy<H> {
    epoch: String,
    issued: u64,
    closed: u64,
    pub(crate) active: Option<(u64, H)>,
}
impl<H> Default for Policy<H> {
    fn default() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            issued: 0,
            closed: 0,
            active: None,
        }
    }
}
impl<H> Policy<H> {
    pub(crate) fn status(&mut self, available: bool, reason: String) -> Result<Status, String> {
        self.issued = self
            .issued
            .checked_add(1)
            .filter(|n| *n <= MAX_TICKET)
            .ok_or("Display ownership tickets exhausted; restart lazysh.")?;
        Ok(Status {
            available,
            reason,
            active: self.active.is_some(),
            epoch: self.epoch.clone(),
            ticket: self.issued,
        })
    }
    pub(crate) fn admit(&mut self, request: &Request) -> Result<(), String> {
        self.validate(request)?;
        if request.ticket <= self.closed {
            return Err("Display ownership has expired.".into());
        }
        self.closed = request.ticket;
        Ok(())
    }
    fn validate(&self, request: &Request) -> Result<(), String> {
        if request.epoch != self.epoch
            || request.ticket == 0
            || request.ticket > self.issued
            || request.ticket > MAX_TICKET
        {
            return Err("Display ownership has expired.".into());
        }
        Ok(())
    }
    pub(crate) fn release(&mut self, request: &Request) -> Result<Option<H>, String> {
        if request.epoch != self.epoch {
            return Ok(None);
        }
        self.validate(request)?;
        self.closed = self.closed.max(request.ticket);
        Ok(
            if self
                .active
                .as_ref()
                .is_some_and(|(ticket, _)| *ticket == request.ticket)
            {
                self.active.take().map(|(_, hold)| hold)
            } else {
                None
            },
        )
    }
    pub(crate) fn invalidate(&mut self) -> Option<H> {
        let old = self.active.take().map(|(_, hold)| hold);
        self.epoch = uuid::Uuid::new_v4().to_string();
        self.issued = 0;
        self.closed = 0;
        old
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ticket(policy: &mut Policy<()>) -> Request {
        let status = policy.status(true, String::new()).unwrap();
        Request {
            epoch: status.epoch,
            ticket: status.ticket,
        }
    }
    #[test]
    fn release_before_delayed_acquisition_cannot_reacquire() {
        let mut policy = Policy::<()>::default();
        let owner = ticket(&mut policy);
        assert!(policy.release(&owner).unwrap().is_none());
        assert!(policy.admit(&owner).is_err());
        let next = ticket(&mut policy);
        policy.admit(&next).unwrap();
        policy.active = Some((next.ticket, ()));
        assert!(policy.release(&owner).unwrap().is_none());
        assert!(policy.active.is_some());
    }
    #[test]
    fn background_without_lock_and_renderer_replacement_invalidate_old_status() {
        let mut policy = Policy::<()>::default();
        for _ in 0..2 {
            let old = ticket(&mut policy);
            policy.admit(&old).unwrap();
            policy.active = Some((old.ticket, ()));
            assert!(policy.invalidate().is_some());
            assert!(policy.admit(&old).is_err());
            assert!(policy.release(&old).unwrap().is_none());
            let fresh = ticket(&mut policy);
            policy.admit(&fresh).unwrap();
        }
    }
    #[test]
    fn an_unacquired_status_ticket_cannot_cross_an_epoch_with_a_reused_counter() {
        let mut policy = Policy::<()>::default();
        let pending = ticket(&mut policy);
        assert!(policy.active.is_none());
        policy.invalidate();
        let fresh = ticket(&mut policy);
        assert_eq!(pending.ticket, fresh.ticket);
        assert_ne!(pending.epoch, fresh.epoch);
        assert!(policy.admit(&pending).is_err());
        policy.admit(&fresh).unwrap();
    }
    #[test]
    fn renderer_reload_uses_native_tickets_and_rejects_unissued_numbers() {
        let mut policy = Policy::<()>::default();
        let old = ticket(&mut policy);
        let fresh = ticket(&mut policy);
        policy.admit(&fresh).unwrap();
        assert!(policy.admit(&old).is_err());
        for value in [0, fresh.ticket + 1, MAX_TICKET + 1] {
            assert!(policy
                .admit(&Request {
                    epoch: fresh.epoch.clone(),
                    ticket: value
                })
                .is_err());
        }
    }
}
