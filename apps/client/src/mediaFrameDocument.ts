/** The frame's own policy: no script, no network, nothing but one data URL for the media element. */
export const mediaFramePolicy = "default-src 'none'; media-src data:; style-src 'unsafe-inline'";

/** The document inside the isolated frame: one media element on the data it was handed. The type comes from a short allowlist and the data was checked as base64, so neither can leave the attribute. */
export const mediaFrameDocument = ({kind, mime, data}: {kind: 'video' | 'audio'; mime: string; data: string}) => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${mediaFramePolicy}"><style>html,body{margin:0;height:100%;background:#000}${kind}{display:block;width:100%;height:100%}</style><${kind} controls preload="metadata" src="data:${mime};base64,${data}"></${kind}>`;
