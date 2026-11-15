//! Install, dry-run and roll back the managed companion.
//!
//! Order matters: the release is resolved and pinned before anything is written; the download is
//! staged in a private file that is not executable; size and SHA-256 are compared before it is
//! made executable; only then is it run, in a cleared environment, to prove it is a companion;
//! only then is it renamed over the installed binary, and the installed path is checked again.
use super::{
    compare, confirmed, current,
    report::{Current, Failure, Fault, Output, Report},
    resolve, selftest,
    staging::{commit, Identity},
    state::{self, Previous, Retained},
    store::{hash, Staged, Store, PREVIOUS},
    Args, Mode, Resolved, Standing,
};
use serde_json::{json, Value};

pub async fn run(
    args: &Args,
    mode: Mode,
    output: &Output,
    report: &mut Report,
) -> Result<(), Fault> {
    if mode == Mode::Rollback {
        rollback(output, report)
    } else {
        install(args, mode, output, report).await
    }
}

/// Compare the installed companion with the wanted release; `true` when nothing needs doing.
fn settled(args: &Args, wanted: &str, report: &mut Report) -> Result<bool, Fault> {
    let installed = current::detect()?;
    let standing = compare(args, installed.version.as_deref(), wanted);
    report.current = Some(installed);
    if standing? == Standing::Same {
        report.outcome = "upToDate";
        return Ok(true);
    }
    Ok(false)
}
fn valid(version: Option<String>) -> Option<String> {
    version.filter(|v| lazysh_companion_release::version(v).is_some())
}
fn installed(store: &Store, version: &str, identity: &Identity) -> Current {
    Current {
        version: Some(version.to_owned()),
        path: store.installed_path().to_string_lossy().into_owned(),
        sha256: identity.0.clone(),
        bytes: identity.1,
        managed: true,
    }
}
/// What the kept previous copy is now, from the identity `commit` retained.
fn retained(kept: Option<Identity>, replaced: bool, from: Option<String>) -> Retained {
    match (kept, replaced, valid(from)) {
        (Some((sha256, _)), _, Some(version)) => Retained::Set(Previous { version, sha256 }),
        (None, false, _) => Retained::Keep,
        _ => Retained::Clear,
    }
}
/// Remember the operation for `--status`, whatever its outcome.
fn record(
    action: &str,
    from: Option<&str>,
    to: &str,
    report: &Report,
    result: &Result<Retained, Fault>,
) {
    let Ok(directory) = crate::state_directory() else {
        return;
    };
    let (outcome, error) = match result {
        Ok(_) => (report.outcome, Value::Null),
        Err(fault) => (
            if fault.failure == Failure::Uncertain {
                "uncertain"
            } else {
                "failed"
            },
            json!({"kind":fault.failure.kind(),"detail":fault.detail}),
        ),
    };
    let operation = json!({"action":action,"outcome":outcome,"from":from,"to":to,
        "at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),"error":error});
    // A failed run replaced nothing it knows of, so the kept copy stays as it was.
    let retained = result.as_ref().map_or(Retained::Keep, Retained::clone);
    state::record(&directory, retained, operation);
}

async fn install(
    args: &Args,
    mode: Mode,
    output: &Output,
    report: &mut Report,
) -> Result<(), Fault> {
    let resolved = resolve(args, mode, output).await?;
    report.latest = Some(resolved.latest());
    let wanted = resolved.selection.version.clone();
    if settled(args, &wanted, report)? {
        return Ok(());
    }
    if mode == Mode::Install
        && !args.yes
        && !confirmed(&format!(
            "Install companion {wanted} over {}?",
            report
                .current
                .as_ref()
                .and_then(|c| c.version.as_deref())
                .unwrap_or("an unknown version")
        ))
    {
        return Err(Failure::Usage.into());
    }
    let dry = mode == Mode::DryRun;
    let store = match Store::open(!dry)? {
        Some(store) => store,
        None => Store::scratch()?,
    };
    // Another update may have finished while this one resolved; the lock makes this read final.
    if settled(args, &wanted, report)? {
        return Ok(());
    }
    let from = report.current.as_ref().and_then(|c| c.version.clone());
    let had = store.current()?.is_some();
    let result = apply(&store, &resolved, dry, had, from.as_deref(), output, report).await;
    if !dry {
        record("update", from.as_deref(), &wanted, report, &result);
    }
    result.map(|_| ())
}

async fn apply(
    store: &Store,
    resolved: &Resolved,
    dry: bool,
    had: bool,
    from: Option<&str>,
    output: &Output,
    report: &mut Report,
) -> Result<Retained, Fault> {
    let selection = &resolved.selection;
    let mut staged = store.stage()?;
    let mut download = resolved.publisher.download(selection).await?;
    let mut received = 0;
    while let Some(chunk) = download.chunk().await? {
        staged.staging.write(&chunk)?;
        received += chunk.len() as u64;
        output.progress(received, selection.bytes);
    }
    output.stage("verifying");
    staged
        .staging
        .seal(&selection.digest, selection.bytes, hash)?;
    output.stage("selfTesting");
    if !selftest::passes(&store.path(&staged), &selection.version) {
        return Err(Failure::SelfTestFailed.into());
    }
    if dry {
        report.outcome = "dryRunOk";
        return Ok(Retained::Keep);
    }
    replace(
        store,
        staged,
        &selection.version,
        "updated",
        had,
        from,
        output,
        report,
    )
}

/// Rename the verified, self-tested file over the installed one and report what is installed now.
#[allow(clippy::too_many_arguments)]
fn replace(
    store: &Store,
    staged: Staged<'_>,
    version: &str,
    outcome: &'static str,
    had: bool,
    from: Option<&str>,
    output: &Output,
    report: &mut Report,
) -> Result<Retained, Fault> {
    output.stage("replacing");
    let identity = staged
        .staging
        .identity()
        .cloned()
        .ok_or(Failure::Internal)?;
    let kept = commit(store, staged, version, || output.stage("checkingInstalled"))?;
    report.outcome = outcome;
    report.current = Some(installed(store, version, &identity));
    report.previous = kept
        .as_ref()
        .zip(from)
        .map(|(kept, from)| json!({"version":from,"sha256":kept.0}));
    Ok(retained(kept, had, from.map(str::to_owned)))
}

fn rollback(output: &Output, report: &mut Report) -> Result<(), Fault> {
    let store = Store::open(false)?.ok_or(Failure::NoPreviousVersion)?;
    let previous = state::State::read(&crate::state_directory()?)
        .previous
        .filter(|_| store.exists(PREVIOUS))
        .ok_or(Failure::NoPreviousVersion)?;
    let installed = current::detect()?;
    let had = store.current()?.is_some();
    // A PATH copy that is only running is not what is being replaced.
    let from = installed.version.clone().filter(|_| had);
    report.current = Some(installed);
    let result = restore(&store, &previous, had, from.as_deref(), output, report);
    record(
        "rollback",
        from.as_deref(),
        &previous.version,
        report,
        &result,
    );
    result.map(|_| ())
}

fn restore(
    store: &Store,
    previous: &Previous,
    had: bool,
    from: Option<&str>,
    output: &Output,
    report: &mut Report,
) -> Result<Retained, Fault> {
    // The copy is verified against the digest recorded when it was kept, so a swapped file is refused.
    let staged = store.copy_previous(&previous.sha256)?;
    output.stage("selfTesting");
    if !selftest::passes(&store.path(&staged), &previous.version) {
        return Err(Failure::SelfTestFailed.into());
    }
    replace(
        store,
        staged,
        &previous.version,
        "rolledBack",
        had,
        from,
        output,
        report,
    )
}
