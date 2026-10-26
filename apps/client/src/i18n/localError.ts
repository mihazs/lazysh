import {t} from './core';

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

/** Only client-created failures carry these finite keys; host strings are never interpreted. */
export class LocalUiError extends Error {
  constructor(readonly key: 'filesTooLarge' | 'repoInvalid' | 'repoSubmodule' | 'repoInvalidFile' | 'previewPortsSyntax' | 'previewPortsRange' | 'previewNoteLimits' | 'previewInvalidResponse' | 'previewInvalidAddress' | 'previewInvalidPicker' | 'previewInvalidList' | 'previewInvalidListeners' | 'previewPortRange' | 'cloudOriginMismatch' | 'cloudInvalidStatus' | 'cloudInvalidQuota' | 'cloudInvalidCapabilities') { super(t(key)); }
}
export type UiErrorCause = string | LocalUiError;
export function captureUiError(error: unknown): UiErrorCause {
  return error instanceof LocalUiError ? error : errorMessage(error);
}
export function uiErrorText(error: UiErrorCause): string {
  return typeof error === 'string' ? error : t(error.key);
}
