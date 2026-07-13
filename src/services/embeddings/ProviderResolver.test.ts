import { ProviderResolver } from './ProviderResolver';
import joplin from 'api';

describe('ProviderResolver', () => {
	describe('getDefaultConfig', () => {
		it('returns joplin-native as default', () => {
			const config = ProviderResolver.getDefaultConfig();
			expect(config.id).toBe('joplin-native');
		});
	});

	describe('resolveWithValidation', () => {
		it('throws when joplin.ai is unavailable', async () => {
			(joplin as any).ai = undefined;
			await expect(ProviderResolver.resolveWithValidation()).rejects.toThrow(
				'joplin.ai is not available'
			);
		});

		it('throws when index is not ready', async () => {
			(joplin as any).ai = {
				getIndexStatus: jest.fn().mockResolvedValue({ ready: false, state: 'disabled' }),
				getEmbeddings: jest.fn(),
			};
			await expect(ProviderResolver.resolveWithValidation()).rejects.toThrow(
				'Joplin AI index is not ready'
			);
		});

		it('returns provider when index is ready', async () => {
			(joplin as any).ai = {
				getIndexStatus: jest.fn().mockResolvedValue({ ready: true, modelId: 'test-model' }),
				getEmbeddings: jest.fn(),
			};
			const provider = await ProviderResolver.resolveWithValidation();
			expect(provider.id).toBe('joplin-native');
			expect(provider.modelName).toBe('test-model');
		});

		it('uses the default native model when index status omits modelId', async () => {
			(joplin as any).ai = {
				getIndexStatus: jest.fn().mockResolvedValue({ ready: true }),
				getEmbeddings: jest.fn(),
			};
			const provider = await ProviderResolver.resolveWithValidation();
			expect(provider.modelName).toBe('joplin-native');
		});
	});
});
