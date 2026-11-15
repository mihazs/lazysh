import type {MediaClip} from './mediaPreview';
import {mediaFrameDocument} from './mediaFrameDocument';

/**
 * Plays a host's video or audio in a frame with an opaque origin: `sandbox` without tokens gives it
 * no script, no form, no popup and no access to this window, its storage or the native bridge, and
 * its own policy blocks every load but the one data URL. A blob URL would be cleaner, but an opaque
 * origin cannot load one made here.
 */
export default function MediaFrame({clip, label}: {clip: MediaClip; label: string}) {
  return <iframe className={`file-media-frame file-media-${clip.kind}`} title={label} sandbox="" referrerPolicy="no-referrer" srcDoc={mediaFrameDocument(clip)}/>;
}
