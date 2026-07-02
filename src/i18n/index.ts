// OMS i18n entry point
//
// Reads the shared ~/.snow/language.json (the same file snow-cli uses) so the
// language switch is global: changing language in snow-cli also changes oms's
// CLI output. Falls back to 'en' if the file is missing or unreadable.
//
// oms is a standalone npm package and cannot import snow-cli's source, so this
// reimplements the minimal read logic (snow-cli's languageConfig.ts) — same
// file format, same default.

import {homedir} from 'os';
import {join} from 'path';
import {existsSync, readFileSync} from 'fs';
import type {Language, TranslationKeys} from './types.js';
import {translations} from './translations.js';

const LANGUAGE_CONFIG_FILE = join(homedir(), '.snow', 'language.json');

/**
 * Read the current language from the shared ~/.snow/language.json.
 * Falls back to 'en' on any error (missing file, corrupt JSON, unknown value).
 */
export function getCurrentLanguage(): Language {
	if (!existsSync(LANGUAGE_CONFIG_FILE)) {
		return 'en';
	}
	try {
		const configData = readFileSync(LANGUAGE_CONFIG_FILE, 'utf-8');
		const config = JSON.parse(configData);
		const lang = config?.language;
		if (lang === 'en' || lang === 'zh' || lang === 'zh-TW') {
			return lang;
		}
		return 'en';
	} catch {
		return 'en';
	}
}

/** The translation table for the current language. */
export function getTranslations(): TranslationKeys {
	return translations[getCurrentLanguage()];
}

export {translations} from './translations.js';
export type {Language, TranslationKeys, Translations} from './types.js';
