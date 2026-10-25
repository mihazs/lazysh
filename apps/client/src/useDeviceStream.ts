import { useProtectedInvoke } from './access';
import { useEffect } from "react";


/** One outstanding pull; native keeps only its newest frame. */
export function useDeviceStream(
  enabled: boolean,
  sessionId: string,
  id: string,
  socket: string,
  onFrame: (value: unknown) => void,
  onError: (error: unknown) => void,
  platform = "ios",
) {
  const invoke = useProtectedInvoke();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let streamId: string | undefined;
    const stop = async () => {
      if (streamId) {
        const token = streamId;
        streamId = undefined;
        await invoke("device_stream_stop", { sessionId, streamId: token });
      }
    };
    void (async () => {
      try {
        streamId = await invoke<string>("device_stream_start", {
          sessionId,
          id,
          socket,
          devicePlatform: platform,
        });
        let sequence = 0;
        while (!cancelled) {
          const packet = await invoke<{
            sequence: number;
            frame?: unknown;
            error?: unknown;
            idle?: boolean;
          }>("device_stream_next", { sessionId, streamId, after: sequence });
          if (cancelled) break;
          if (packet.error) throw packet.error;
          if (packet.idle === true) {
            if (packet.sequence !== sequence || packet.frame)
              throw new Error("Invalid idle device packet.");
            continue;
          }
          if (
            !Number.isSafeInteger(packet.sequence) ||
            packet.sequence <= sequence ||
            !packet.frame
          )
            throw new Error("Invalid device stream sequence.");
          sequence = packet.sequence;
          onFrame(packet.frame);
        }
      } catch (error) {
        if (!cancelled) onError(error);
      } finally {
        try {
          await stop();
        } catch (error) {
          if (!cancelled) onError(error);
        }
      }
    })();
    return () => {
      cancelled = true;
      void stop().catch(() => {});
    };
  }, [enabled, sessionId, id, socket, platform, onFrame, onError]);
}
