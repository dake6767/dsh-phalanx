import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { I18nProvider } from '@heroui/react/rac';
import { languagePreference, platformLanguageCookie, resolvePlatformLocale, type PlatformLanguagePreference, type PlatformLocale } from '../../src/domain/platform-language';
import { platformError, platformText, type PlatformMessageKey } from '../../src/domain/platform-copy';
import type { CommunityErrorParams } from '../../src/domain/admin-contract';
const LanguageContext = createContext<{ locale: PlatformLocale; preference: PlatformLanguagePreference; setPreference: (value: PlatformLanguagePreference) => void } | undefined>(undefined);
export function CommunityLanguageProvider({ children }: { children: ReactNode }) {
 const [preference, setPreference] = useState(() => languagePreference(document.cookie));
 const [browserLanguage, setBrowserLanguage] = useState(() => navigator.languages.join(','));
 const locale = resolvePlatformLocale(platformLanguageCookie(preference), browserLanguage);
 useEffect(() => {
  const change = () => setBrowserLanguage(navigator.languages.join(','));
  addEventListener('languagechange', change); return () => removeEventListener('languagechange', change);
 }, []);
 // Apply in the render that changes visible copy, without resetting component state or drafts.
 document.documentElement.lang = locale;
 return <LanguageContext.Provider value={{ locale, preference, setPreference: value => { document.cookie = platformLanguageCookie(value); setPreference(value); } }}><I18nProvider locale={locale}>{children}</I18nProvider></LanguageContext.Provider>;
}
export class CommunityCopyError extends Error {
 constructor(readonly key: PlatformMessageKey) { super(key); }
}
export function usePlatformLanguage() {
 const context = useContext(LanguageContext);
 if (!context) throw new Error('Platform language provider is missing');
 return { ...context,
  t: (key: PlatformMessageKey, params?: CommunityErrorParams) => platformText(context.locale, key, params),
  errorText: (failure: unknown, fallback: PlatformMessageKey = 'Request failed') => {
   if (failure instanceof CommunityCopyError) return platformText(context.locale, failure.key);
   if (failure instanceof Error) {
    const detail = failure as Error & { code?: string; params?: CommunityErrorParams };
    return platformError(context.locale, { error: detail.message, code: detail.code, params: detail.params });
   }
   return platformText(context.locale, fallback);
  },
 };
}
