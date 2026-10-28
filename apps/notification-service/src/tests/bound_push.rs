use super::push_delivery::Fixture;
use super::*;
use crate::push::{EventFormat, PushConfig};
use rusqlite::params;

async fn ready() -> (Fixture, serde_json::Value) {
    let mut fixture = Fixture::with_format(EventFormat::BoundV2).await;
    let bootstrap = fixture.activate().await;
    source(&fixture.service, SOURCE, "owned public alias").await;
    (fixture, bootstrap)
}
async fn claim(fixture: &Fixture) -> store::Job {
    fixture
        .service
        .db(|store| {
            store.connection.execute("UPDATE events SET next=0", [])?;
            Ok(store.claim()?.unwrap())
        })
        .await
        .unwrap()
}
async fn admitted() -> (Fixture, serde_json::Value, store::Job) {
    let (fixture, bootstrap) = ready().await;
    enqueue(&fixture.service, SOURCE, &event()).await;
    let job = claim(&fixture).await;
    (fixture, bootstrap, job)
}
fn receipt_state(store: &store::Store, id: &str) -> rusqlite::Result<(String, i64)> {
    store.connection.query_row(
        "SELECT state,attempts FROM events WHERE receipt=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}
async fn post_job(fixture: &mut Fixture, job: &store::Job) -> serde_json::Value {
    let config = fixture.service.0.config.push().unwrap();
    let response = config
        .request(job.push.as_ref().unwrap(), &fixture.service.0.client)
        .unwrap()
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    fixture.message().await.1
}

#[tokio::test]
async fn bound_requests_decrypt_to_exact_original_device_and_fixed_expiry_across_rotation_and_restart(
) {
    let (mut fixture, bootstrap) = ready().await;
    let event = event();
    let event_id = event.event_id;
    enqueue(&fixture.service, SOURCE, &event).await;
    let first = claim(&fixture).await;
    let original_endpoint = first.push.as_ref().unwrap().endpoint.clone();
    let body = post_job(&mut fixture, &first).await;
    let issued = body["issuedAt"].as_i64().unwrap();
    let expires = body["expiresAt"].as_i64().unwrap();
    assert_eq!(
        body,
        serde_json::json!({"schemaVersion":2,"deviceId":bootstrap["deviceId"],"generation":bootstrap["generation"],
        "receiptId":first.receipt.receipt_id,"eventId":event_id,"kind":"needs_attention","alias":"owned public alias",
        "issuedAt":issued,"expiresAt":expires})
    );
    assert_eq!(expires - issued, 300);
    assert!((1..=300).contains(&first.push.as_ref().unwrap().ttl));
    fixture
        .service
        .db(move |store| store.finish(&first, false))
        .await
        .unwrap();
    fixture.rotate("rotated").await;
    let second = claim(&fixture).await;
    assert_eq!(second.push.as_ref().unwrap().endpoint, original_endpoint);
    assert_eq!(post_job(&mut fixture, &second).await, body);
    assert_eq!(second.attempts, 2);
    fixture
        .service
        .db(move |store| store.finish(&second, false))
        .await
        .unwrap();

    let directory = std::mem::replace(&mut fixture._directory, tempfile::tempdir().unwrap());
    let config_path = directory.path().join("push.json");
    fixture
        .service
        .0
        .config
        .push()
        .unwrap()
        .write(&config_path)
        .unwrap();
    let certificate = fixture.sink.pem.clone();
    drop(fixture);
    let config = PushConfig::read(&config_path)
        .unwrap()
        .with_test_root(reqwest::Certificate::from_pem(certificate.as_bytes()).unwrap());
    let service =
        Service::open(Config::web_push(directory.path().join("state"), ADMIN, config).unwrap())
            .unwrap();
    let third = service
        .db(|store| {
            store.connection.execute("UPDATE events SET next=0", [])?;
            Ok(store.claim()?.unwrap())
        })
        .await
        .unwrap();
    assert_eq!(third.attempts, 3);
    let wire = third.push.as_ref().unwrap();
    assert_eq!(wire.endpoint, original_endpoint);
    let clear = web_push_native::decrypt(
        wire.body.clone(),
        &web_push_native::p256::SecretKey::from_slice(&[7; 32]).unwrap(),
        &web_push_native::Auth::from([9; 16]),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&clear).unwrap(),
        body
    );
    service
        .db(move |store| store.finish(&third, false))
        .await
        .unwrap();
    assert!(service.db(|store| store.claim()).await.unwrap().is_none());
}

#[tokio::test]
async fn bound_expiry_and_clock_rollback_never_freshen_or_admit_a_retry() {
    let (fixture, _, job) = admitted().await;
    let id = job.receipt.receipt_id.clone();
    fixture
        .service
        .db(move |store| store.finish(&job, false))
        .await
        .unwrap();
    fixture
        .service
        .db(move |store| {
            let saved: String = store.connection.query_row(
                "SELECT subscription FROM event_push WHERE receipt=?1",
                [&id],
                |r| r.get(0),
            )?;
            let mut value: serde_json::Value = serde_json::from_str(&saved).unwrap();
            let at = store::now();
            value["issuedAt"] = serde_json::json!(at + 60);
            value["expiresAt"] = serde_json::json!(at + 300);
            let future = serde_json::to_string(&value).unwrap();
            store.connection.execute(
                "UPDATE event_push SET subscription=?1 WHERE receipt=?2",
                params![future, id],
            )?;
            store.connection.execute("UPDATE events SET next=0", [])?;
            assert!(store.claim().is_err());
            assert_eq!(receipt_state(store, &id)?, ("queued".into(), 1));
            let expired = store::now();
            value["issuedAt"] = serde_json::json!(expired - 301);
            value["expiresAt"] = serde_json::json!(expired - 1);
            store.connection.execute(
                "UPDATE event_push SET subscription=?1 WHERE receipt=?2",
                params![serde_json::to_string(&value).unwrap(), id],
            )?;
            assert!(store.claim()?.is_none());
            assert_eq!(receipt_state(store, &id)?, ("expired_unknown".into(), 1));
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn bound_snapshot_is_closed_and_ttl_is_only_the_original_remaining_window() {
    let (fixture, bootstrap, job) = admitted().await;
    let config = fixture.service.0.config.push().unwrap();
    let snapshot = fixture
        .service
        .db(|store| {
            Ok(store
                .connection
                .query_row("SELECT subscription FROM event_push", [], |r| {
                    r.get::<_, String>(0)
                })?)
        })
        .await
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
    value["issuedAt"] = serde_json::json!(1000);
    value["expiresAt"] = serde_json::json!(1030);
    let saved = serde_json::to_string(&value).unwrap();
    let captured = crate::push_event::capture(
        &config,
        serde_json::to_string(&value["subscription"]).unwrap(),
        bootstrap["generation"].as_i64().unwrap(),
        1000,
        1020,
    )
    .unwrap();
    let capped = crate::push_event::encrypted(&config, &captured, &job.receipt, 1005)
        .unwrap()
        .unwrap();
    assert_eq!(capped.ttl, 15);
    let wire = crate::push_event::encrypted(&config, &saved, &job.receipt, 1005)
        .unwrap()
        .unwrap();
    assert_eq!(wire.ttl, 25);
    let clear = fixture.decrypt(wire.body);
    assert_eq!(clear["generation"], bootstrap["generation"]);
    assert_eq!(clear["issuedAt"], 1000);
    assert_eq!(clear["expiresAt"], 1030);
    assert!(
        crate::push_event::encrypted(&config, &saved, &job.receipt, 1030)
            .unwrap()
            .is_none()
    );
    for (key, changed) in [
        ("schemaVersion", serde_json::json!(1)),
        ("deviceId", serde_json::json!(Uuid::new_v4())),
        ("generation", serde_json::json!(-1)),
        ("issuedAt", serde_json::json!(-1)),
        ("expiresAt", serde_json::json!(1301)),
        ("unknown", serde_json::json!(true)),
    ] {
        let mut bad = value.clone();
        bad[key] = changed;
        assert!(crate::push_event::encrypted(
            &config,
            &serde_json::to_string(&bad).unwrap(),
            &job.receipt,
            1005
        )
        .is_err());
    }
}

#[tokio::test]
async fn changing_only_event_format_requires_reconfiguration_and_preserves_old_identity_and_sources(
) {
    let mut fixture = Fixture::with_format(EventFormat::Legacy).await;
    fixture.activate().await;
    source(&fixture.service, SOURCE, "retained source").await;
    let receipt = enqueue(&fixture.service, SOURCE, &event()).await;
    let _admitted = claim(&fixture).await;
    let before = fixture.service.db(|store| store.status()).await.unwrap();
    let directory = std::mem::replace(&mut fixture._directory, tempfile::tempdir().unwrap());
    let old = directory.path().join("old.json");
    fixture
        .service
        .0
        .config
        .push()
        .unwrap()
        .write(&old)
        .unwrap();
    let mut settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&old).unwrap()).unwrap();
    settings["eventFormat"] = serde_json::json!("bound-v2");
    let new = directory.path().join("new.json");
    client::write_private(&new, &serde_json::to_vec(&settings).unwrap()).unwrap();
    drop(fixture);
    let configuration = || {
        Config::web_push(
            directory.path().join("state"),
            ADMIN,
            PushConfig::read(&new).unwrap(),
        )
        .unwrap()
    };
    assert!(Service::open(configuration()).is_err());
    Service::reconfigure(configuration()).unwrap();
    let service = Service::open(configuration()).unwrap();
    let after = service.db(|store| store.status()).await.unwrap();
    assert_eq!(after.account_id, before.account_id);
    assert!(!after.enabled);
    assert_eq!(after.generation, before.generation + 1);
    let id = receipt.receipt_id;
    service
        .db(move |store| {
            let sources: i64 =
                store
                    .connection
                    .query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?;
            let devices: i64 =
                store
                    .connection
                    .query_row("SELECT count(*) FROM push_device", [], |r| r.get(0))?;
            let snapshots: i64 =
                store
                    .connection
                    .query_row("SELECT count(*) FROM event_push", [], |r| r.get(0))?;
            let state: String = store.connection.query_row(
                "SELECT state FROM events WHERE receipt=?1",
                [id],
                |r| r.get(0),
            )?;
            assert_eq!((sources, devices, snapshots), (1, 0, 0));
            assert_eq!(state, "cancelled_unknown");
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/admin/destination/enable",
            ADMIN,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn bound_revoke_stops_new_claims_without_retracting_or_reclassifying_prior_admission() {
    let (mut fixture, bootstrap, job) = admitted().await;
    let id = job.receipt.receipt_id.clone();
    fixture.revoke().await;
    let body = post_job(&mut fixture, &job).await;
    assert_eq!(body["deviceId"], bootstrap["deviceId"]);
    assert_eq!(body["generation"], bootstrap["generation"]);
    fixture
        .service
        .db(move |store| store.finish(&job, true))
        .await
        .unwrap();
    let state = fixture
        .service
        .db(move |store| {
            Ok(store.connection.query_row(
                "SELECT state FROM events WHERE receipt=?1",
                [id],
                |r| r.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(state, "cancelled_unknown");
}
