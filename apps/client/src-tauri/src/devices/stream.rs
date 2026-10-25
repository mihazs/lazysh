use super::*;
use crate::app_lock::{AccessLease, Guarded, GuardedError};
type Protected<T> = std::result::Result<Guarded<T>, GuardedError<crate::ssh::SshError>>;
use russh::ChannelMsg;
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{watch, Mutex};

const MAX_RECORD: usize = 720_000;
#[derive(Default)]
pub struct DeviceStreams(Mutex<HashMap<String, Stream>>);
impl DeviceStreams {
    pub(crate) async fn cancel_for_lock(&self) {
        let mut streams = self.0.lock().await;
        for stream in streams.values_mut() {
            stream.cancel.send_replace(true);
            stream.output = watch::channel(Packet::default()).1;
        }
        // Keep capacity reserved until the owned SSH worker confirms cleanup;
        // fresh unlocks must not accumulate detached sources behind an empty map.
        streams.retain(|_, stream| !*stream.done.borrow() && stream.done.has_changed().is_ok());
    }
}
struct Stream {
    session_id: String,
    cancel: watch::Sender<bool>,
    output: watch::Receiver<Packet>,
    done: watch::Receiver<bool>,
}
fn ensure_capacity(entries: &mut HashMap<String, Stream>, session_id: &str) -> Result<()> {
    // A renderer reload can lose its token. Completed workers must not reserve
    // a session or a global slot forever merely because stop was never invoked.
    entries.retain(|_, stream| !*stream.done.borrow() && stream.done.has_changed().is_ok());
    if entries.len() >= 2
        || entries
            .values()
            .any(|stream| stream.session_id == session_id)
    {
        return Err(SshError::new(
            "busy",
            "Stop the existing device stream first",
        ));
    }
    Ok(())
}
#[derive(Clone, Default, Serialize)]
pub struct Packet {
    sequence: u64,
    frame: Option<Value>,
    error: Option<SshError>,
    idle: bool,
}

fn record(bytes: &[u8], id: &str, platform: &str) -> Result<Value> {
    let frame: Value = serde_json::from_slice(bytes)?;
    if frame["schemaVersion"] != 1
        || frame["id"] != id
        || frame["platform"] != platform
        || frame["mime"] != "image/jpeg"
        || !frame["base64"].as_str().is_some_and(|value| {
            value.starts_with("/9j/")
                && value.len() <= 700_000
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        })
    {
        return Err(SshError::new(
            "invalid_output",
            "Invalid device stream frame",
        ));
    }
    for key in ["width", "height", "imageWidth", "imageHeight"] {
        if !frame[key].as_u64().is_some_and(|v| (1..=8192).contains(&v)) {
            return Err(SshError::new("invalid_output", "Invalid device dimensions"));
        }
    }
    Ok(frame)
}
async fn receive(
    access: AccessLease,
    session: Arc<crate::ssh::Session>,
    command: String,
    id: String,
    platform: String,
    mut cancel: watch::Receiver<bool>,
    output: watch::Sender<Packet>,
) -> Result<()> {
    access.check()?;
    let mut disconnected = session.cancel.subscribe();
    if *cancel.borrow() || *disconnected.borrow() {
        return Ok(());
    }
    let mut channel = tokio::select! { biased;
        _=access.cancelled()=>return Ok(()),
        _=cancel.changed()=>return Ok(()),
        _=disconnected.changed()=>return Ok(()),
        result=tokio::time::timeout(Duration::from_secs(10),session.handle.channel_open_session())=>result.map_err(|_|SshError::new("timeout","Device channel timed out"))??,
    };
    let maximum = Duration::from_secs(if platform == "android" { 180 } else { 900 });
    let result=tokio::time::timeout(maximum,async {
        tokio::select! {biased;
            _=access.cancelled()=>return Ok(()),
            _=cancel.changed()=>return Ok(()),
            _=disconnected.changed()=>return Ok(()),
            result=async {access.check()?;tokio::time::timeout(Duration::from_secs(10),channel.exec(true,command)).await.map_err(|_|SshError::new("timeout","Starting device stream timed out"))?.map_err(SshError::from)}=>result?,
        }
        let mut buffer=Vec::new();let mut sequence=0;
        let startup_deadline=tokio::time::Instant::now()+Duration::from_secs(12);
        loop {
            let read_timeout=if sequence==0 {startup_deadline.saturating_duration_since(tokio::time::Instant::now())} else {Duration::from_secs(12)};
            if sequence==0 && read_timeout.is_zero() {return Err(SshError::new("timeout","Device stream did not produce its first frame"));}
            let msg=tokio::select! {biased;
                _=access.cancelled()=>return Ok(()),
            _=cancel.changed()=>return Ok(()),
                _=disconnected.changed()=>return Ok(()),
                msg=tokio::time::timeout(read_timeout,channel.wait())=>match msg {
                    Ok(msg)=>msg,
                    Err(_) if platform=="android" && sequence>0 && buffer.is_empty()=>continue,
                    Err(_)=>return Err(SshError::new("timeout","Device stream stopped producing frames")),
                },
            };
            match msg {
                Some(ChannelMsg::Data{data})=>{
                    for byte in data.iter().copied() {
                        if byte==b'\n' {
                            access.check()?;let frame=record(&buffer,&id,&platform)?;buffer.clear();sequence+=1;
                            output.send_replace(Packet{sequence,frame:Some(frame),error:None,idle:false});
                        } else {if buffer.len()>=MAX_RECORD {return Err(SshError::new("output_too_large","Device stream frame exceeds limit"));}buffer.push(byte);}
                    }
                },
                Some(ChannelMsg::ExitStatus{exit_status}) if exit_status!=0=>return Err(SshError::new("remote_command_failed","Device video stopped; verify host video tools and device availability")),
                None=>return Err(SshError::new("disconnected","Device video ended; start another preview if needed")),
                _=>{},
            }
        }
    }).await.map_err(|_|SshError::new("timeout","Device preview reached its maximum duration"));
    // EOF cancels the companion's stdin watcher even when the simulator is idle.
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = channel.eof().await;
        channel.close().await
    })
    .await;
    result?
}
#[tauri::command]
pub async fn device_stream_start(
    access: AccessLease,
    state: State<'_, AppState>,
    streams: State<'_, DeviceStreams>,
    session_id: String,
    id: String,
    socket: Option<String>,
    device_platform: Option<String>,
) -> Protected<String> {
    access
        .run(async {
            let platform = device_platform.unwrap_or_else(|| "ios".into());
            let command = match platform.as_str() {
                "android" => android_command(&id, "stream")?,
                "ios" => companion_command(&id, socket.as_deref().unwrap_or(""), "stream")?,
                _ => {
                    return Err(SshError::new(
                        "invalid_input",
                        "Unsupported device platform",
                    ))
                }
            };
            let session = state.session(&session_id).await?;
            let mut entries = streams.0.lock().await;
            ensure_capacity(&mut entries, &session_id)?;
            let token = uuid::Uuid::new_v4().to_string();
            let (cancel, request) = watch::channel(false);
            let (output, latest) = watch::channel(Packet::default());
            let (done, completion) = watch::channel(false);
            access.check()?;
            access.with_current(|| {
                entries.insert(
                    token.clone(),
                    Stream {
                        session_id,
                        cancel,
                        output: latest,
                        done: completion,
                    },
                );
            })?;
            let source_access = access.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = receive(
                    source_access,
                    session,
                    command,
                    id,
                    platform,
                    request,
                    output.clone(),
                )
                .await
                {
                    let sequence = output.borrow().sequence + 1;
                    output.send_replace(Packet {
                        sequence,
                        frame: None,
                        error: Some(error),
                        idle: false,
                    });
                }
                done.send_replace(true);
            });
            Ok(token)
        })
        .await
}
#[tauri::command]
pub async fn device_stream_next(
    access: AccessLease,
    streams: State<'_, DeviceStreams>,
    session_id: String,
    stream_id: String,
    after: u64,
) -> Protected<Packet> {
    access
        .run(async {
            let output = {
                let entries = streams.0.lock().await;
                let stream = entries
                    .get(&stream_id)
                    .filter(|s| s.session_id == session_id)
                    .ok_or_else(|| SshError::new("invalid_input", "Unknown device stream"))?;
                stream.output.clone()
            };
            next_packet(output, after).await
        })
        .await
}
async fn next_packet(mut output: watch::Receiver<Packet>, after: u64) -> Result<Packet> {
    match tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let packet = output.borrow_and_update().clone();
            if packet.sequence > after {
                return Ok(packet);
            }
            output
                .changed()
                .await
                .map_err(|_| SshError::new("disconnected", "Device stream closed"))?;
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Ok(Packet {
            sequence: after,
            idle: true,
            ..Packet::default()
        }),
    }
}
#[tauri::command]
pub async fn device_stream_stop(
    streams: State<'_, DeviceStreams>,
    session_id: String,
    stream_id: String,
) -> Result<()> {
    let entries = streams.0.lock().await;
    if entries
        .get(&stream_id)
        .is_some_and(|s| s.session_id != session_id)
    {
        return Err(SshError::new(
            "invalid_input",
            "Device stream belongs to another session",
        ));
    }
    let stream = entries
        .get(&stream_id)
        .map(|stream| (stream.cancel.clone(), stream.done.clone()));
    drop(entries);
    if let Some((cancel, mut done)) = stream {
        cancel.send_replace(true);
        if !*done.borrow() {
            tokio::time::timeout(Duration::from_secs(5), done.changed())
                .await
                .map_err(|_| SshError::new("timeout", "Device stream cleanup timed out"))?
                .map_err(|_| SshError::new("disconnected", "Device cleanup stopped"))?;
        }
        streams.0.lock().await.remove(&stream_id);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn lock_cancels_every_source_and_discards_retained_frames() {
        let streams = DeviceStreams::default();
        let (cancel, cancelled) = watch::channel(false);
        let (_output, output) = watch::channel(Packet {
            sequence: 1,
            frame: Some(serde_json::json!({"private": "frame"})),
            ..Packet::default()
        });
        let (_done, done) = watch::channel(false);
        streams.0.lock().await.insert(
            "token".into(),
            Stream {
                session_id: "session".into(),
                cancel,
                output,
                done,
            },
        );
        streams.cancel_for_lock().await;
        assert!(*cancelled.borrow());
        let mut entries = streams.0.lock().await;
        assert!(entries["token"].output.borrow().frame.is_none());
        assert!(ensure_capacity(&mut entries, "session").is_err());
    }
    #[test]
    fn streamed_records_bind_identity_and_bound_payloads() {
        let frame = serde_json::json!({"schemaVersion":1,"id":"test","platform":"ios","mime":"image/jpeg","base64":"/9j/2Q==","width":390,"height":844,"imageWidth":195,"imageHeight":422});
        assert!(record(&serde_json::to_vec(&frame).unwrap(), "test", "ios").is_ok());
        assert!(record(&serde_json::to_vec(&frame).unwrap(), "other", "ios").is_err());
        assert!(record(&serde_json::to_vec(&frame).unwrap(), "test", "android").is_err());
        let mut hostile = frame;
        hostile["width"] = 0.into();
        assert!(record(&serde_json::to_vec(&hostile).unwrap(), "test", "ios").is_err());
    }
    #[test]
    fn latest_slot_discards_old_frames_without_webview_queue_growth() {
        let (output, latest) = watch::channel(Packet::default());
        for sequence in 1..100 {
            output.send_replace(Packet {
                sequence,
                ..Packet::default()
            });
        }
        assert_eq!(latest.borrow().sequence, 99);
    }
    #[tokio::test(start_paused = true)]
    async fn idle_poll_preserves_last_frame_and_closed_source_cancels_wait() {
        let frame = serde_json::json!({"original":"capture"});
        let (output, latest) = watch::channel(Packet {
            sequence: 1,
            frame: Some(frame.clone()),
            ..Packet::default()
        });
        let start = tokio::time::Instant::now();
        let idle = next_packet(latest.clone(), 1).await.unwrap();
        assert!(idle.idle);
        assert_eq!(idle.sequence, 1);
        assert!(idle.frame.is_none());
        assert_eq!(tokio::time::Instant::now() - start, Duration::from_secs(15));
        assert_eq!(latest.borrow().frame, Some(frame));
        output.send_replace(Packet {
            sequence: 2,
            frame: Some(serde_json::json!({"next":"capture"})),
            ..Packet::default()
        });
        let next = next_packet(latest.clone(), 1).await.unwrap();
        assert_eq!(next.sequence, 2);
        assert!(!next.idle);
        drop(output);
        assert!(next_packet(latest, 2).await.is_err());
    }
    #[test]
    fn finished_or_crashed_workers_do_not_reserve_slots_after_renderer_reload() {
        let mut entries = HashMap::new();
        let mut completed_workers = Vec::new();
        for index in 0..2 {
            let (cancel, _) = watch::channel(false);
            let (_, output) = watch::channel(Packet::default());
            let (done, completion) = watch::channel(index == 0);
            // One acknowledged completion and one dropped worker cover both paths.
            entries.insert(
                index.to_string(),
                Stream {
                    session_id: "lost-owner".into(),
                    cancel,
                    output,
                    done: completion,
                },
            );
            if index == 0 {
                completed_workers.push(done);
            } else {
                drop(done);
            }
        }
        assert!(ensure_capacity(&mut entries, "lost-owner").is_ok());
        assert!(entries.is_empty());
        let (cancel, _) = watch::channel(false);
        let (_, output) = watch::channel(Packet::default());
        let (_done, completion) = watch::channel(false);
        entries.insert(
            "live".into(),
            Stream {
                session_id: "live-owner".into(),
                cancel,
                output,
                done: completion,
            },
        );
        assert!(ensure_capacity(&mut entries, "live-owner").is_err());
        assert_eq!(entries.len(), 1);
        assert!(ensure_capacity(&mut entries, "new-owner").is_ok());
    }
    #[tokio::test]
    async fn stop_checks_session_ownership_and_waits_for_source_cleanup() {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .manage(DeviceStreams::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (cancel, mut request) = watch::channel(false);
        let (_output, latest) = watch::channel(Packet::default());
        let (done, completion) = watch::channel(false);
        app.state::<DeviceStreams>().0.lock().await.insert(
            "stream".into(),
            Stream {
                session_id: "owner".into(),
                cancel,
                output: latest,
                done: completion,
            },
        );
        assert!(
            device_stream_stop(app.state(), "other".into(), "stream".into())
                .await
                .is_err()
        );
        assert!(!*request.borrow());
        let cleanup = async {
            request.changed().await.unwrap();
            assert!(*request.borrow());
            done.send_replace(true);
        };
        let (stop, ()) = tokio::join!(
            device_stream_stop(app.state(), "owner".into(), "stream".into()),
            cleanup
        );
        assert!(stop.is_ok());
        assert!(app.state::<DeviceStreams>().0.lock().await.is_empty());
    }
}
