//! Debug-only fixed-size startup diagnostics. Never stores bridge error text or authority data.
use serde::Serialize;

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    #[default]
    Pending,
    Running,
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Registration,
    Capability,
    PolicyProof,
    Authority,
    Worker,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PolicyFailure {
    Location,
    Storage,
    CredentialInspection,
    CredentialService,
    Other,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    registration: Outcome,
    capability: Outcome,
    policy_proof: Outcome,
    authority: Outcome,
    worker: Outcome,
    pub ready_received: bool,
    // Preserve the first failure even when register returns after its ready callback.
    first_failure: Option<Stage>,
    policy_failure: Option<PolicyFailure>,
}

impl Snapshot {
    pub fn policy_failed(&mut self, error: &str) {
        self.record(Stage::PolicyProof, Outcome::Failed);
        if self.policy_failure.is_none() {
            self.policy_failure = Some(match error {
                "Cannot locate native resume protection policy" => PolicyFailure::Location,
                super::policy::STORAGE => PolicyFailure::Storage,
                "Cannot inspect device credentials" => PolicyFailure::CredentialInspection,
                "Device credential service unavailable" => PolicyFailure::CredentialService,
                _ => PolicyFailure::Other,
            });
        }
    }

    pub fn record(&mut self, stage: Stage, outcome: Outcome) {
        let current = match stage {
            Stage::Registration => &mut self.registration,
            Stage::Capability => &mut self.capability,
            Stage::PolicyProof => &mut self.policy_proof,
            Stage::Authority => &mut self.authority,
            Stage::Worker => &mut self.worker,
        };
        if *current != Outcome::Failed {
            *current = outcome;
        }
        if outcome == Outcome::Failed && self.first_failure.is_none() {
            self.first_failure = Some(stage);
        }
    }
}
