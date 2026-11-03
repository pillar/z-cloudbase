// Console UI language (zh / en). Each page keeps its own messages next to it (`defineMessages`), so
// adding text never touches a shared dictionary. Server error messages are shown as returned.
import { createContext, useContext, useState, type ReactNode } from 'react';

export type Locale = 'zh' | 'en';
const KEY = 'zcb.console.locale';

type Message = string | ((...args: never[]) => string);
/** `en` must provide every key of `zh` with the same shape (checked by the compiler). */
export function defineMessages<T extends Record<string, Message>>(m: { zh: T; en: { [K in keyof T]: T[K] } }) {
  return m;
}

function stored(): Locale {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'zh' || v === 'en') return v;
  } catch {
    // storage unavailable: fall back to the default
  }
  return 'zh';
}

const LocaleContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({ locale: 'zh', setLocale: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(stored);
  const setLocale = (l: Locale) => {
    setLocaleState(l);
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
    try {
      localStorage.setItem(KEY, l);
    } catch {
      // private mode: the choice lasts for this page only
    }
  };
  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export const useLocale = () => useContext(LocaleContext);

/** The messages of the current language: `const t = useT(messages); t.title; t.created(date)`. */
export function useT<T>(messages: { zh: T; en: T }): T {
  return messages[useLocale().locale];
}

/** Locale-aware formatting of timestamps (epoch ms), counts and byte sizes. */
export function useFormat() {
  const { locale } = useLocale();
  const tag = locale === 'zh' ? 'zh-CN' : 'en-US';
  return {
    time: (ms: number | null | undefined) =>
      ms ? new Date(ms).toLocaleString(tag, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–',
    number: (n: number) => n.toLocaleString(tag),
    /** A 0..1 ratio as a percentage, e.g. 0.4567 → "45.7%". */
    percent: (ratio: number, digits = 1) => ratio.toLocaleString(tag, { style: 'percent', maximumFractionDigits: digits }),
    bytes: fmtBytes,
  };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
