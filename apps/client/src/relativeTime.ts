import { useEffect, useState } from 'react';
import { uiI18n } from './i18n/core';

const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];

/** Short, locale-aware recency ("4 min. ago"); callers keep the absolute time in a title or datetime. */
export function formatRelativeTime(value: string | number | Date, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(uiI18n.language, { numeric: 'auto', style: 'short' });
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1];
  return format.format(Math.trunc(seconds / size), unit);
}

/** Remaining time as m:ss or h:mm:ss; never negative. */
export function formatCountdown(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  const pad = (part: number) => String(part).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Re-renders while active so relative times and countdowns stay current. */
export function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

export function pathBasename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}
