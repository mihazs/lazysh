//! Private single-device enrollment. No endpoint, auth secret or challenge nonce is
//! returned through a public status/receipt. Only encrypted Web Push carries a nonce.
use crate::{
    digest,
    push::{EncryptedPush, PushConfig},
    store::{now, Store},
    token, valid_token, ApiError, Service,
};
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

pub(crate) fn schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS push_device (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, enrollment BLOB NOT NULL, enrollment_expires INTEGER NOT NULL, bootstrap TEXT, credential BLOB, revoked INTEGER NOT NULL, active TEXT, request TEXT, candidate TEXT, challenge TEXT, proof BLOB, expires INTEGER, wire TEXT);
        CREATE TABLE IF NOT EXISTS event_push (receipt TEXT PRIMARY KEY, subscription TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS push_capabilities (hash BLOB PRIMARY KEY);")
}
pub(crate) fn routes() -> Router<Service> {
    Router::new()
        .route("/v1/admin/push/{action}", post(admin_enrollment))
        .route("/v1/push/bootstrap", post(bootstrap))
        .route("/v1/push/subscription", post(subscribe))
        .route("/v1/push/confirm", post(confirm))
        .route("/v1/push/revoke", post(revoke))
}
fn input<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    value
        .map(|Json(value)| value)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_push_request"))
}
fn config(service: &Service) -> Result<Arc<PushConfig>, ApiError> {
    service.0.config.push().ok_or_else(ApiError::not_found)
}
fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "push_identity_conflict")
}
fn checked(value: &str) -> Result<(), ApiError> {
    if valid_token(value) {
        Ok(())
    } else {
        Err(ApiError(StatusCode::BAD_REQUEST, "invalid_push_capability"))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Begin {
    #[serde(deserialize_with = "crate::push::read_private")]
    capability: Zeroizing<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Bootstrap {
    request_id: Uuid,
    #[serde(deserialize_with = "crate::push::read_private")]
    credential: Zeroizing<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Subscribe {
    request_id: Uuid,
    endpoint: String,
    p256dh: String,
    #[serde(deserialize_with = "crate::push::read_private")]
    auth: Zeroizing<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Confirm {
    challenge_id: Uuid,
    #[serde(deserialize_with = "crate::push::read_private")]
    nonce: Zeroizing<String>,
}
struct BootstrapRow {
    generation: i64,
    enrollment: Vec<u8>,
    enrollment_expires: i64,
    request: Option<String>,
    credential: Option<Vec<u8>>,
    revoked: bool,
}
struct PendingRow {
    request: Option<String>,
    candidate: Option<String>,
    challenge: Option<String>,
    expires: Option<i64>,
    wire: Option<String>,
    active: Option<String>,
}

async fn admin_enrollment(
    State(service): State<Service>,
    Path(action): Path<String>,
    headers: HeaderMap,
    body: Result<Json<Begin>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let reset = match action.as_str() {
        "enrollment" => false,
        "reset" => true,
        _ => return Err(ApiError::not_found()),
    };
    enrollment(service, headers, input(body)?, reset).await
}
async fn enrollment(
    service: Service,
    headers: HeaderMap,
    body: Begin,
    reset: bool,
) -> Result<Json<serde_json::Value>, ApiError> {
    service.admin(&headers)?;
    config(&service)?;
    checked(&body.capability)?;
    let hash = digest(&body.capability);
    if service.0.config.reserved(&hash) {
        return Err(conflict());
    }
    let generation=service.db(move |store| {
        let tx=store.connection.transaction()?;
        fresh_capability(&tx,&hash)?;
        if tx.query_row("SELECT count(*) FROM sources WHERE token=?1",[hash.to_vec()],|r|r.get::<_,i64>(0))? !=0 { return Err(conflict()); }
        let old:Option<(i64,Vec<u8>)>=tx.query_row("SELECT generation,enrollment FROM push_device WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if !reset && old.is_some() { return Err(conflict()); }
        if old.as_ref().is_some_and(|(_,saved)|saved==&hash) { return Err(conflict()); }
        let generation=old.map_or(0,|(generation,_)|generation+1);
        tx.execute("INSERT INTO push_capabilities VALUES(?1)",[hash.to_vec()])?;
        tx.execute("DELETE FROM push_device",[])?;
        tx.execute("DELETE FROM event_push",[])?;
        tx.execute("INSERT INTO push_device (id,generation,enrollment,enrollment_expires,revoked) VALUES(1,?1,?2,?3,0)",params![generation,hash.to_vec(),now()+600])?;
        tx.execute("UPDATE account SET enabled=0,generation=generation+1",[])?;
        tx.execute("UPDATE events SET state=CASE WHEN may_sent=1 THEN 'cancelled_unknown' ELSE 'cancelled' END WHERE state IN ('queued','sending')",[])?;
        tx.commit()?;
        Ok(generation)
    }).await?;
    service.changed();
    Ok(Json(
        serde_json::json!({"enrollmentReady":true,"generation":generation,"expiresInSeconds":600,"enabled":false}),
    ))
}
async fn bootstrap(
    State(service): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Bootstrap>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let config = config(&service)?;
    let body = input(body)?;
    checked(&body.credential)?;
    if body.request_id.is_nil() {
        return Err(conflict());
    }
    let enrollment = digest(token(&headers)?);
    let credential = digest(&body.credential);
    if service.0.config.reserved(&credential) || credential == enrollment {
        return Err(conflict());
    }
    let (generation,confirmed)=service.db(move |store|{
        let tx=store.connection.transaction()?;
        let row:Option<BootstrapRow>=tx.query_row("SELECT generation,enrollment,enrollment_expires,bootstrap,credential,revoked FROM push_device WHERE id=1",[],|r|Ok(BootstrapRow{generation:r.get(0)?,enrollment:r.get(1)?,enrollment_expires:r.get(2)?,request:r.get(3)?,credential:r.get(4)?,revoked:r.get(5)?})).optional()?;
        let row=row.ok_or_else(ApiError::unauthorized)?;
        if row.revoked || row.enrollment_expires<=now() || !bool::from(row.enrollment.as_slice().ct_eq(&enrollment)) { return Err(ApiError::unauthorized()); }
        if let Some(request)=row.request {
            if request!=body.request_id.to_string() || row.credential.as_deref()!=Some(credential.as_slice()) { return Err(conflict()); }
        } else {
            fresh_capability(&tx,&credential)?;
            if tx.query_row("SELECT count(*) FROM sources WHERE token=?1",[credential.to_vec()],|r|r.get::<_,i64>(0))? !=0 { return Err(conflict()); }
            tx.execute("UPDATE push_device SET bootstrap=?1,credential=?2 WHERE id=1",params![body.request_id.to_string(),credential.to_vec()])?;
            tx.execute("INSERT INTO push_capabilities VALUES(?1)",[credential.to_vec()])?;
        }
        let confirmed=tx.query_row("SELECT active IS NOT NULL FROM push_device WHERE id=1",[],|r|r.get::<_,bool>(0))?;
        tx.commit()?;
        Ok((row.generation,confirmed))
    }).await?;
    Ok(Json(
        serde_json::json!({"deviceId":config.slot_id(),"generation":generation,"publicVapidKey":config.public_key(),"confirmed":confirmed}),
    ))
}
fn fresh_capability(connection: &Connection, hash: &[u8; 32]) -> Result<(), ApiError> {
    if connection.query_row(
        "SELECT count(*) FROM push_capabilities WHERE hash=?1",
        [hash.to_vec()],
        |r| r.get::<_, i64>(0),
    )? != 0
    {
        return Err(conflict());
    }
    if connection.query_row("SELECT count(*) FROM push_capabilities", [], |r| {
        r.get::<_, i64>(0)
    })? >= 256
    {
        return Err(ApiError::capacity());
    }
    Ok(())
}
impl Store {
    fn device(&self, credential: &[u8; 32]) -> Result<i64, ApiError> {
        let row:Option<(i64,Vec<u8>)>=self.connection.query_row("SELECT generation,credential FROM push_device WHERE id=1 AND revoked=0 AND credential IS NOT NULL",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (generation, saved) = row.ok_or_else(ApiError::unauthorized)?;
        if !bool::from(saved.as_slice().ct_eq(credential)) {
            return Err(ApiError::unauthorized());
        }
        Ok(generation)
    }
}
async fn subscribe(
    State(service): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Subscribe>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let config = config(&service)?;
    let body = input(body)?;
    if body.request_id.is_nil() {
        return Err(conflict());
    }
    let credential = digest(token(&headers)?);
    // Authenticate before doing any crypto; recheck inside the write transaction.
    service.db(move |store| store.device(&credential)).await?;
    let subscription = config
        .subscription(body.endpoint, body.p256dh, body.auth.to_string())
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_push_subscription"))?;
    let candidate =
        Zeroizing::new(serde_json::to_string(&subscription).map_err(|_| ApiError::storage())?);
    let config_for_db = config.clone();
    let (challenge,wire)=service.db(move |store|{
        let generation=store.device(&credential)?;
        let tx=store.connection.transaction()?;
        let saved:PendingRow=tx.query_row("SELECT request,candidate,challenge,expires,wire,active FROM push_device WHERE id=1",[],|r|Ok(PendingRow{request:r.get(0)?,candidate:r.get(1)?,challenge:r.get(2)?,expires:r.get(3)?,wire:r.get(4)?,active:r.get(5)?}))?;
        if saved.request.as_deref()==Some(body.request_id.to_string().as_str()) {
            if saved.candidate.as_deref()!=Some(candidate.as_str()) || saved.expires.unwrap_or(0)<=now() { return Err(conflict()); }
            return Ok((saved.challenge.ok_or_else(ApiError::storage)?,serde_json::from_str::<EncryptedPush>(&saved.wire.ok_or_else(ApiError::storage)?).map_err(|_|ApiError::storage())?));
        }
        if let Some(active)=saved.active {
            let active:crate::push::Subscription=serde_json::from_str(&active).map_err(|_|ApiError::storage())?;
            if active.p256dh!=subscription.p256dh || active.auth.as_str()!=subscription.auth.as_str() { return Err(conflict()); }
        }
        let challenge=Uuid::new_v4().to_string();
        let nonce=crate::secret();
        let plaintext=Zeroizing::new(serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"kind":"challenge","deviceId":config_for_db.slot_id(),"generation":generation,"challengeId":challenge,"nonce":nonce.as_str()})).map_err(|_|ApiError::storage())?);
        let wire=config_for_db.encrypt(&subscription,&plaintext,300).map_err(|_|ApiError(StatusCode::BAD_REQUEST,"invalid_push_subscription"))?;
        let encoded=Zeroizing::new(serde_json::to_string(&wire).map_err(|_|ApiError::storage())?);
        tx.execute("UPDATE push_device SET request=?1,candidate=?2,challenge=?3,proof=?4,expires=?5,wire=?6 WHERE id=1",params![body.request_id.to_string(),candidate.as_str(),challenge,digest(&nonce).to_vec(),now()+300,encoded.as_str()])?;
        tx.commit()?;
        Ok((challenge,wire))
    }).await?;
    // Admission has committed. Revoke can stop future work, not recall this POST.
    let accepted = config
        .request(&wire, &service.0.client)
        .map_err(|_| ApiError::storage())?
        .send()
        .await
        .is_ok_and(|response| response.status().is_success());
    Ok(Json(
        serde_json::json!({"challengeId":challenge,"pushServiceAccepted":accepted,"confirmed":false}),
    ))
}
async fn confirm(
    State(service): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Confirm>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    config(&service)?;
    let body = input(body)?;
    checked(&body.nonce)?;
    let credential = digest(token(&headers)?);
    service.db(move |store|{
        store.device(&credential)?;
        let tx=store.connection.transaction()?;
        let row:(Option<String>,Option<Vec<u8>>,Option<i64>)=tx.query_row("SELECT challenge,proof,expires FROM push_device WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let proof=digest(&body.nonce);
        if row.0.as_deref()!=Some(body.challenge_id.to_string().as_str()) || row.2.unwrap_or(0)<=now() || !row.1.is_some_and(|saved|bool::from(saved.as_slice().ct_eq(&proof))) { return Err(conflict()); }
        tx.execute("UPDATE push_device SET active=candidate,request=NULL,candidate=NULL,challenge=NULL,proof=NULL,expires=NULL,wire=NULL WHERE id=1",[])?;
        tx.commit()?;
        Ok(())
    }).await?;
    service.changed();
    Ok(Json(serde_json::json!({"confirmed":true})))
}
async fn revoke(
    State(service): State<Service>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    config(&service)?;
    let credential = digest(token(&headers)?);
    service.db(move |store|{
        // Keep only the hash for idempotent revocation; it grants no enrollment/send authority.
        let saved:Option<Vec<u8>>=store.connection.query_row("SELECT credential FROM push_device WHERE id=1",[],|r|r.get(0)).optional()?.flatten();
        if !saved.is_some_and(|hash|bool::from(hash.as_slice().ct_eq(&credential))) { return Err(ApiError::unauthorized()); }
        let tx=store.connection.transaction()?;
        tx.execute("UPDATE push_device SET revoked=1,active=NULL,candidate=NULL,wire=NULL,proof=NULL,challenge=NULL,request=NULL WHERE id=1",[])?;
        tx.execute("DELETE FROM event_push",[])?;
        tx.execute("UPDATE account SET enabled=0,generation=generation+1",[])?;
        tx.execute("UPDATE events SET state=CASE WHEN may_sent=1 THEN 'cancelled_unknown' ELSE 'cancelled' END WHERE state IN ('queued','sending')",[])?;
        tx.commit()?;
        Ok(())
    }).await?;
    service.changed();
    Ok(Json(serde_json::json!({"revoked":true})))
}
