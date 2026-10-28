//! Explicitly pinned, single-device Web Push configuration and encrypted wire data.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jwt_simple::algorithms::ES256KeyPair;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    net::{IpAddr, SocketAddr},
    path::Path,
};
use uuid::Uuid;
use web_push::{ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushMessageBuilder};
use zeroize::Zeroizing;

pub const MAX_CLEAR_BYTES: usize = 2048;
pub const MAX_WIRE_BYTES: usize = 4096;
const INVALID: &str = "Invalid private Web Push configuration";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum EventFormat {
    #[default]
    Legacy,
    BoundV2,
}
impl EventFormat {
    fn legacy(&self) -> bool {
        *self == Self::Legacy
    }
}

pub(crate) fn read_private<'de, D: Deserializer<'de>>(
    decoder: D,
) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(decoder).map(Zeroizing::new)
}
fn write_private<S: Serializer>(value: &Zeroizing<String>, encoder: S) -> Result<S::Ok, S::Error> {
    encoder.serialize_str(value)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    schema_version: u8,
    slot_id: Uuid,
    origin: String,
    addresses: Vec<IpAddr>,
    contact: String,
    #[serde(default, skip_serializing_if = "EventFormat::legacy")]
    event_format: EventFormat,
    #[serde(deserialize_with = "read_private", serialize_with = "write_private")]
    private_vapid: Zeroizing<String>,
}

/// Never Debug/serialize this object into status or errors: it owns a VAPID key.
pub struct PushConfig {
    settings: Settings,
    public_key: String,
    #[cfg(any(test, feature = "test-support"))]
    root: Option<reqwest::Certificate>,
}

impl PushConfig {
    pub fn generate(
        origin: String,
        addresses: Vec<IpAddr>,
        contact: String,
    ) -> Result<Self, String> {
        Self::generate_with_event_format(origin, addresses, contact, EventFormat::Legacy)
    }

    pub fn generate_with_event_format(
        origin: String,
        addresses: Vec<IpAddr>,
        contact: String,
        event_format: EventFormat,
    ) -> Result<Self, String> {
        let key = ES256KeyPair::generate();
        let bytes = Zeroizing::new(key.to_bytes());
        Self::validate(Settings {
            schema_version: 1,
            slot_id: Uuid::new_v4(),
            origin,
            addresses,
            contact,
            event_format,
            private_vapid: Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_slice())),
        })
    }

    pub fn read(path: &Path) -> Result<Self, String> {
        let value = lazysh_common::service_secrets::read_secret(path)?;
        Self::validate(serde_json::from_str(&value).map_err(|_| INVALID)?)
    }

    pub fn write(&self, path: &Path) -> Result<(), String> {
        let bytes = Zeroizing::new(serde_json::to_vec(&self.settings).map_err(|_| INVALID)?);
        if bytes.len() > 1024 {
            return Err(INVALID.into());
        }
        crate::client::write_private(path, bytes.as_slice())
    }

    fn validate(mut settings: Settings) -> Result<Self, String> {
        let origin = crate::https(&settings.origin)?;
        let contact = reqwest::Url::parse(&settings.contact).map_err(|_| INVALID)?;
        if settings.schema_version != 1
            || settings.slot_id.is_nil()
            || origin.path() != "/"
            || settings.origin.len() > 384
            || settings.contact.len() > 128
            || !matches!(contact.scheme(), "https" | "mailto")
            || contact.path().is_empty()
            || settings.contact.chars().any(char::is_control)
            || contact.password().is_some()
            || !contact.username().is_empty()
            || contact.query().is_some()
            || contact.fragment().is_some()
            || settings.addresses.is_empty()
            || settings.addresses.len() > 4
            || settings.addresses.iter().any(|ip| {
                ip.is_unspecified()
                    || ip.is_multicast()
                    || *ip == IpAddr::from([255, 255, 255, 255])
            })
            || settings.private_vapid.len() != 43
        {
            return Err(INVALID.into());
        }
        settings.origin = origin.origin().ascii_serialization();
        settings.addresses.sort();
        settings.addresses.dedup();
        if let Some(host) = origin
            .host_str()
            .and_then(|value| value.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        {
            if settings.addresses.as_slice() != [host] {
                return Err(INVALID.into());
            }
        }
        let key = VapidSignatureBuilder::from_base64_no_sub(settings.private_vapid.as_str())
            .map_err(|_| INVALID)?;
        let public_key = URL_SAFE_NO_PAD.encode(key.get_public_key());
        Ok(Self {
            settings,
            public_key,
            #[cfg(any(test, feature = "test-support"))]
            root: None,
        })
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }
    pub fn slot_id(&self) -> Uuid {
        self.settings.slot_id
    }
    pub fn event_format(&self) -> EventFormat {
        self.settings.event_format
    }
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_test_root(mut self, root: reqwest::Certificate) -> Self {
        self.root = Some(root);
        self
    }
    pub(crate) fn identity(&self) -> [u8; 32] {
        let format = match self.event_format() {
            EventFormat::Legacy => "webpush-v1",
            EventFormat::BoundV2 => "webpush-bound-v2",
        };
        crate::digest(&format!(
            "{format}\0{}\0{}\0{}\0{:?}",
            self.settings.slot_id, self.settings.origin, self.public_key, self.settings.addresses
        ))
    }

    pub(crate) fn client(&self) -> Result<reqwest::Client, String> {
        let origin = reqwest::Url::parse(&self.settings.origin).map_err(|_| INVALID)?;
        let host = origin.host_str().ok_or(INVALID)?;
        let addresses: Vec<_> = self
            .settings
            .addresses
            .iter()
            .map(|ip| SocketAddr::new(*ip, origin.port_or_known_default().unwrap_or(443)))
            .collect();
        #[cfg(any(test, feature = "test-support"))]
        let root = self.root.clone();
        #[cfg(not(any(test, feature = "test-support")))]
        let root = None;
        lazysh_notification_client::client_builder(root)
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| "Cannot construct pinned Web Push client".into())
    }

    pub(crate) fn subscription(
        &self,
        endpoint: String,
        p256dh: String,
        auth: String,
    ) -> Result<Subscription, String> {
        if endpoint.len() > 1000 || p256dh.len() != 87 || auth.len() != 22 {
            return Err("Invalid Web Push subscription".into());
        }
        self.endpoint(&endpoint)?;
        let public = URL_SAFE_NO_PAD
            .decode(&p256dh)
            .map_err(|_| "Invalid Web Push subscription")?;
        let secret = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(&auth)
                .map_err(|_| "Invalid Web Push subscription")?,
        );
        if public.len() != 65 || public[0] != 4 || secret.len() != 16 {
            return Err("Invalid Web Push subscription".into());
        }
        Ok(Subscription {
            endpoint,
            p256dh,
            auth: Zeroizing::new(auth),
        })
    }

    fn endpoint(&self, endpoint: &str) -> Result<(), String> {
        if endpoint.len() > 1000 {
            return Err("Invalid Web Push subscription".into());
        }
        let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid Web Push subscription")?;
        if url.scheme() != "https"
            || url.origin().ascii_serialization() != self.settings.origin
            || url.as_str() != endpoint
            || url.fragment().is_some()
            || url.password().is_some()
            || !url.username().is_empty()
            || endpoint
                .split('/')
                .nth(2)
                .is_some_and(|host| host.contains('@'))
        {
            return Err("Invalid Web Push subscription".into());
        }
        Ok(())
    }

    pub(crate) fn encrypt(
        &self,
        subscription: &Subscription,
        body: &[u8],
        ttl: u32,
    ) -> Result<EncryptedPush, String> {
        self.endpoint(&subscription.endpoint)?;
        if body.len() > MAX_CLEAR_BYTES || ttl == 0 || ttl > 86400 {
            return Err("Web Push payload exceeds bounds".into());
        }
        let info = SubscriptionInfo::new(
            subscription.endpoint.clone(),
            subscription.p256dh.clone(),
            subscription.auth.to_string(),
        );
        let mut signature =
            VapidSignatureBuilder::from_base64(self.settings.private_vapid.as_str(), &info)
                .map_err(|_| "Cannot sign Web Push request")?;
        // Both candidate libraries drop a non-default port in their default aud.
        // Use this library's supported override with the vetted full HTTPS origin.
        signature.add_claim("aud", self.settings.origin.as_str());
        signature.add_claim("sub", self.settings.contact.as_str());
        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_ttl(ttl);
        builder.set_vapid_signature(
            signature
                .build()
                .map_err(|_| "Cannot sign Web Push request")?,
        );
        builder.set_payload(ContentEncoding::Aes128Gcm, body);
        let message = builder
            .build()
            .map_err(|_| "Cannot encrypt Web Push request")?;
        let payload = message.payload.ok_or("Cannot encrypt Web Push request")?;
        if payload.content.is_empty() || payload.content.len() > MAX_WIRE_BYTES {
            return Err("Web Push ciphertext exceeds bounds".into());
        }
        let authorization = payload
            .crypto_headers
            .into_iter()
            .find(|(name, _)| *name == "Authorization")
            .map(|(_, value)| value)
            .ok_or("Cannot sign Web Push request")?;
        Ok(EncryptedPush {
            endpoint: subscription.endpoint.clone(),
            authorization,
            body: payload.content,
            ttl,
        })
    }
    pub(crate) fn request(
        &self,
        wire: &EncryptedPush,
        client: &reqwest::Client,
    ) -> Result<reqwest::RequestBuilder, String> {
        // Revalidate persisted work as well as freshly submitted subscriptions.
        self.endpoint(&wire.endpoint)?;
        if wire.body.is_empty()
            || wire.body.len() > MAX_WIRE_BYTES
            || wire.ttl == 0
            || wire.ttl > 86400
        {
            return Err("Invalid persisted Web Push request".into());
        }
        Ok(client
            .post(&wire.endpoint)
            .header("Authorization", &wire.authorization)
            .header("TTL", wire.ttl.to_string())
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .body(wire.body.clone()))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    #[serde(deserialize_with = "read_private", serialize_with = "write_private")]
    pub auth: Zeroizing<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct EncryptedPush {
    pub endpoint: String,
    pub authorization: String,
    pub body: Vec<u8>,
    pub ttl: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_push_native::p256::{self, elliptic_curve::sec1::ToEncodedPoint};

    fn config() -> PushConfig {
        PushConfig::generate(
            "https://push.example:8443".into(),
            vec!["127.0.0.1".parse().unwrap()],
            "mailto:operator@example.invalid".into(),
        )
        .unwrap()
    }
    fn subscriber(config: &PushConfig) -> (Subscription, p256::SecretKey) {
        let key = p256::SecretKey::from_slice(&[7; 32]).unwrap();
        let public = key.public_key().to_encoded_point(false);
        (
            config
                .subscription(
                    "https://push.example:8443/up/opaque?cap=A%2fB".into(),
                    URL_SAFE_NO_PAD.encode(public.as_bytes()),
                    URL_SAFE_NO_PAD.encode([9; 16]),
                )
                .unwrap(),
            key,
        )
    }

    #[test]
    fn web_push_ciphertext_decrypts_with_an_independent_rustcrypto_implementation() {
        let config = config();
        let (subscription, key) = subscriber(&config);
        let plaintext = br#"{"schemaVersion":1,"kind":"challenge","nonce":"owned-fixture"}"#;
        let encrypted = config.encrypt(&subscription, plaintext, 120).unwrap();
        assert_eq!(encrypted.endpoint, subscription.endpoint);
        assert!(!encrypted
            .body
            .windows(plaintext.len())
            .any(|window| window == plaintext));
        assert!(encrypted.body.len() <= MAX_WIRE_BYTES);
        let decrypted =
            web_push_native::decrypt(encrypted.body, &key, &web_push_native::Auth::from([9; 16]))
                .unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn vapid_signature_binds_the_exact_origin_including_non_default_port() {
        use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
        let config = config();
        let (subscription, _) = subscriber(&config);
        let request = config.encrypt(&subscription, b"owned", 120).unwrap();
        let (token, public) = request
            .authorization
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(public, config.public_key());
        let parts: Vec<_> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://push.example:8443");
        assert_eq!(claims["sub"], "mailto:operator@example.invalid");
        let verifier =
            VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(public).unwrap()).unwrap();
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        verifier
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn subscription_keeps_opaque_query_and_rejects_an_unapproved_origin_or_normalization() {
        let config = config();
        let (subscription, _) = subscriber(&config);
        for endpoint in [
            "http://push.example:8443/up/opaque",
            "https://other.example:8443/up/opaque",
            "https://push.example/up/opaque",
            "https://user@push.example:8443/up/opaque",
            "https://@push.example:8443/up/opaque",
            "https://push.example:8443/a/../opaque",
            "https://push.example:8443/up/opaque#fragment",
        ] {
            assert!(config
                .subscription(
                    endpoint.into(),
                    subscription.p256dh.clone(),
                    subscription.auth.to_string()
                )
                .is_err());
        }
    }

    #[test]
    fn plaintext_and_ttl_limits_fail_before_a_request_is_built() {
        let config = config();
        let (subscription, key) = subscriber(&config);
        let boundary = vec![b'x'; MAX_CLEAR_BYTES];
        let request = config.encrypt(&subscription, &boundary, 86400).unwrap();
        assert_eq!(
            web_push_native::decrypt(request.body, &key, &web_push_native::Auth::from([9; 16]))
                .unwrap(),
            boundary
        );
        assert!(config
            .encrypt(&subscription, &vec![b'x'; MAX_CLEAR_BYTES + 1], 120)
            .is_err());
        assert!(config.encrypt(&subscription, b"x", 0).is_err());
        assert!(config.encrypt(&subscription, b"x", 86401).is_err());
    }

    #[test]
    fn private_configuration_roundtrips_without_overwrite_and_pins_literal_addresses() {
        let config = config();
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        lazysh_common::fs::private_directory(&directory).unwrap();
        let path = directory.join("push.json");
        if cfg!(unix) {
            config.write(&path).unwrap();
            let recovered = PushConfig::read(&path).unwrap();
            assert_eq!(recovered.identity(), config.identity());
            assert_eq!(recovered.public_key(), config.public_key());
            assert!(config.write(&path).is_err());
        } else {
            assert!(config.write(&path).is_err());
        }
        assert!(PushConfig::generate(
            "https://127.0.0.1:8443".into(),
            vec!["127.0.0.2".parse().unwrap()],
            "mailto:a@example.invalid".into()
        )
        .is_err());
        assert!(PushConfig::generate(
            "https://push.example".into(),
            vec![],
            "mailto:a@example.invalid".into()
        )
        .is_err());
    }

    #[test]
    fn legacy_configuration_bytes_and_identity_stay_compatible_and_bound_format_is_explicit() {
        let config = config();
        assert_eq!(config.event_format(), EventFormat::Legacy);
        let raw = serde_json::to_value(&config.settings).unwrap();
        assert!(raw.get("eventFormat").is_none());
        let old_identity = crate::digest(&format!(
            "webpush-v1\0{}\0{}\0{}\0{:?}",
            config.settings.slot_id,
            config.settings.origin,
            config.public_key,
            config.settings.addresses
        ));
        assert_eq!(config.identity(), old_identity);
        let decoded = PushConfig::validate(serde_json::from_value(raw.clone()).unwrap()).unwrap();
        assert!(
            serde_json::to_vec(&decoded.settings).unwrap()
                == serde_json::to_vec(&config.settings).unwrap()
        );
        for value in [
            serde_json::json!("unknown"),
            serde_json::Value::Null,
            serde_json::json!(2),
        ] {
            let mut bad = raw.clone();
            bad["eventFormat"] = value;
            assert!(serde_json::from_value::<Settings>(bad).is_err());
        }
        let mut bound = raw;
        bound["eventFormat"] = serde_json::json!("bound-v2");
        let bound = PushConfig::validate(serde_json::from_value(bound).unwrap()).unwrap();
        assert_eq!(bound.event_format(), EventFormat::BoundV2);
        assert_ne!(bound.identity(), old_identity);
        assert_eq!(bound.public_key(), config.public_key());
    }

    #[test]
    fn legacy_event_ciphertext_preserves_the_exact_existing_clear_payload() {
        let config = config();
        let (subscription, key) = subscriber(&config);
        let receipt = crate::Receipt {
            receipt_id: Uuid::new_v4().to_string(),
            event_id: Uuid::new_v4().to_string(),
            kind: "done".into(),
            alias: "public alias".into(),
            state: "sending".into(),
            may_have_reached_destination: true,
        };
        let snapshot = serde_json::to_string(&subscription).unwrap();
        let wire = crate::push_event::encrypted(&config, &snapshot, &receipt, 1000)
            .unwrap()
            .unwrap();
        assert_eq!(wire.ttl, 300);
        let clear =
            web_push_native::decrypt(wire.body, &key, &web_push_native::Auth::from([9; 16]))
                .unwrap();
        let expected = serde_json::json!({"schemaVersion":1,"receiptId":receipt.receipt_id,"eventId":receipt.event_id,"kind":receipt.kind,"alias":receipt.alias});
        assert_eq!(clear, serde_json::to_vec(&expected).unwrap());
    }
}
