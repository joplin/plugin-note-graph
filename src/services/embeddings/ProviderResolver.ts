import joplin from 'api';
import { EmbeddingProvider, ProviderConfig } from './Types';
import { JoplinNativeProvider } from './Providers/JoplinNativeProvider';

export class ProviderResolver {

	public static resolve(): EmbeddingProvider {
		return new JoplinNativeProvider();
	}

	/**
	 * Resolves the native embedding provider after verifying that Joplin AI is
	 * available and its embedding index is ready.
	 */
	public static async resolveWithValidation(): Promise<EmbeddingProvider> {
		const joplinAi = joplin.ai as any;
		if (!joplinAi || typeof joplinAi.getIndexStatus !== 'function') {
			throw new Error('joplin.ai is not available. Enable AI in Settings → AI. Requires Joplin v3.7+.');
		}
		const status = await joplinAi.getIndexStatus();
		if (!status || !status.ready) {
			throw new Error('Joplin AI index is not ready. Enable AI and the embedding index in Settings → AI.');
		}
		return new JoplinNativeProvider(status.modelId ?? 'joplin-native', 0);
	}

	public static getDefaultConfig(): ProviderConfig {
		return { id: 'joplin-native' };
	}
}
