use super::*;
use russh::ChannelMsg;
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{watch, Mutex};

const MAX_RECORD: usize = 720_000;
#[derive(Default)]
pub struct DeviceStreams(Mutex<HashMap<String, Stream>>);
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
            "Stop the existing simulator stream first",
        ));
    }
    Ok(())
}
#[derive(Clone, Default, Serialize)]
pub struct Packet {
    sequence: u64,
    frame: Option<Value>,
    error: Option<SshError>,
}

fn record(bytes: &[u8], id: &str) -> Result<Value> {
    let frame: Value = serde_json::from_slice(bytes)?;
    if frame["schemaVersion"] != 1
        || frame["id"] != id
        || frame["platform"] != "ios"
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
            "Invalid simulator stream frame",
        ));
    }
    for key in ["width", "height", "imageWidth", "imageHeight"] {
        if !frame[key].as_u64().is_some_and(|v| (1..=8192).contains(&v)) {
            return Err(SshError::new(
                "invalid_output",
                "Invalid simulator dimensions",
            ));
        }
    }
    Ok(frame)
}
async fn receive(
    session: Arc<crate::ssh::Session>,
    command: String,
    id: String,
    mut cancel: watch::Receiver<bool>,
    output: watch::Sender<Packet>,
) -> Result<()> {
    let mut disconnected = session.cancel.subscribe();
    if *cancel.borrow() || *disconnected.borrow() {
        return Ok(());
    }
    let mut channel = tokio::select! { biased;
        _=cancel.changed()=>return Ok(()),
        _=disconnected.changed()=>return Ok(()),
        result=tokio::time::timeout(Duration::from_secs(10),session.handle.channel_open_session())=>result.map_err(|_|SshError::new("timeout","Simulator channel timed out"))??,
    };
    let result=tokio::time::timeout(Duration::from_secs(900),async {
        tokio::select! {biased;
            _=cancel.changed()=>return Ok(()),
            _=disconnected.changed()=>return Ok(()),
            result=tokio::time::timeout(Duration::from_secs(10),channel.exec(true,command))=>result.map_err(|_|SshError::new("timeout","Starting simulator stream timed out"))??,
        }
        let mut buffer=Vec::new();let mut sequence=0;
        loop {
            let msg=tokio::select! {biased;
                _=cancel.changed()=>return Ok(()),
                _=disconnected.changed()=>return Ok(()),
                msg=tokio::time::timeout(Duration::from_secs(12),channel.wait())=>msg.map_err(|_|SshError::new("timeout","Simulator stream stopped producing frames"))?,
            };
            match msg {
                Some(ChannelMsg::Data{data})=>{
                    for byte in data.iter().copied() {
                        if byte==b'\n' {
                            let frame=record(&buffer,&id)?;buffer.clear();sequence+=1;
                            output.send_replace(Packet{sequence,frame:Some(frame),error:None});
                        } else {if buffer.len()>=MAX_RECORD {return Err(SshError::new("output_too_large","Simulator stream frame exceeds limit"));}buffer.push(byte);}
                    }
                },
                Some(ChannelMsg::ExitStatus{exit_status}) if exit_status!=0=>return Err(SshError::new("remote_command_failed","Simulator streaming failed; verify idb and the selected private companion socket")),
                None=>return Err(SshError::new("disconnected","Simulator stream ended")),
                _=>{},
            }
        }
    }).await.map_err(|_|SshError::new("timeout","Simulator preview reached its 15 minute limit"));
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
    state: State<'_, AppState>,
    streams: State<'_, DeviceStreams>,
    session_id: String,
    id: String,
    socket: String,
) -> Result<String> {
    let command = companion_command(&id, &socket, "stream")?;
    let session = state.session(&session_id).await?;
    let mut entries = streams.0.lock().await;
    ensure_capacity(&mut entries, &session_id)?;
    let token = uuid::Uuid::new_v4().to_string();
    let (cancel, request) = watch::channel(false);
    let (output, latest) = watch::channel(Packet::default());
    let (done, completion) = watch::channel(false);
    entries.insert(
        token.clone(),
        Stream {
            session_id,
            cancel,
            output: latest,
            done: completion,
        },
    );
    tauri::async_runtime::spawn(async move {
        if let Err(error) = receive(session, command, id, request, output.clone()).await {
            let sequence = output.borrow().sequence + 1;
            output.send_replace(Packet {
                sequence,
                frame: None,
                error: Some(error),
            });
        }
        done.send_replace(true);
    });
    Ok(token)
}
#[tauri::command]
pub async fn device_stream_next(
    streams: State<'_, DeviceStreams>,
    session_id: String,
    stream_id: String,
    after: u64,
) -> Result<Packet> {
    let mut output = {
        let entries = streams.0.lock().await;
        let stream = entries
            .get(&stream_id)
            .filter(|s| s.session_id == session_id)
            .ok_or_else(|| SshError::new("invalid_input", "Unknown simulator stream"))?;
        stream.output.clone()
    };
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let packet = output.borrow_and_update().clone();
            if packet.sequence > after {
                return Ok(packet);
            }
            output
                .changed()
                .await
                .map_err(|_| SshError::new("disconnected", "Simulator stream closed"))?;
        }
    })
    .await
    .map_err(|_| SshError::new("timeout", "Waiting for simulator frame timed out"))?
}
#[tauri::command]
pub async fn device_stream_stop(
    streams: State<'_, DeviceStreams>,
    session_id: String,
    stream_id: String,
) -> Result<()> {
    let mut entries = streams.0.lock().await;
    if entries
        .get(&stream_id)
        .is_some_and(|s| s.session_id != session_id)
    {
        return Err(SshError::new(
            "invalid_input",
            "Simulator stream belongs to another session",
        ));
    }
    let stream = entries.remove(&stream_id);
    drop(entries);
    if let Some(mut stream) = stream {
        stream.cancel.send_replace(true);
        if !*stream.done.borrow() {
            tokio::time::timeout(Duration::from_secs(5), stream.done.changed())
                .await
                .map_err(|_| SshError::new("timeout", "Simulator stream cleanup timed out"))?
                .map_err(|_| SshError::new("disconnected", "Simulator cleanup stopped"))?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_records_bind_identity_and_bound_payloads() {
        let frame = serde_json::json!({"schemaVersion":1,"id":"test","platform":"ios","mime":"image/jpeg","base64":"/9j/2Q==","width":390,"height":844,"imageWidth":195,"imageHeight":422});
        assert!(record(&serde_json::to_vec(&frame).unwrap(), "test").is_ok());
        assert!(record(&serde_json::to_vec(&frame).unwrap(), "other").is_err());
        let mut hostile = frame;
        hostile["width"] = 0.into();
        assert!(record(&serde_json::to_vec(&hostile).unwrap(), "test").is_err());
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
