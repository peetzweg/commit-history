/// <reference types="vite/client" />

interface ImportMetaEnv {
	/**
	 * Feature flag for the README-embed UI. Set to "true" (e.g. in a local .env)
	 * to show it; left unset in production so the whole snippet — and its live
	 * preview request — is tree-shaken out of the build.
	 */
	readonly VITE_FEATURE_EMBED?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
