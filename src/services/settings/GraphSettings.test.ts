import joplin from 'api';
import { SettingItemType } from 'api/types';
import { registerGraphSettings, isAiAnalysisEnabled, getSimilaritySettings } from './GraphSettings';

describe('GraphSettings', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('registerGraphSettings', () => {
		it('registers a section and all note-graph settings', async () => {
			await registerGraphSettings();

			expect(joplin.settings.registerSection).toHaveBeenCalledWith(
				'noteGraph',
				expect.objectContaining({ label: expect.any(String) })
			);
			expect(joplin.settings.registerSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					'noteGraph.aiAnalysisEnabled': expect.objectContaining({
						type: SettingItemType.Bool,
						value: false,
						public: true,
						section: 'noteGraph',
					}),
					'noteGraph.similarityThreshold': expect.objectContaining({
						type: SettingItemType.Int,
						value: 50,
						minimum: 0,
						maximum: 100,
						public: true,
						section: 'noteGraph',
					}),
					'noteGraph.maxEdgesPerNote': expect.objectContaining({
						type: SettingItemType.Int,
						value: 5,
						minimum: 1,
						maximum: 20,
						public: true,
						section: 'noteGraph',
					}),
				})
			);
		});
	});

	describe('isAiAnalysisEnabled', () => {
		it('reads the aiAnalysisEnabled key', async () => {
			(joplin.settings.value as jest.Mock).mockResolvedValue(true);

			const result = await isAiAnalysisEnabled();

			expect(joplin.settings.value).toHaveBeenCalledWith('noteGraph.aiAnalysisEnabled');
			expect(result).toBe(true);
		});

		it('returns false when the setting is false', async () => {
			(joplin.settings.value as jest.Mock).mockResolvedValue(false);

			const result = await isAiAnalysisEnabled();

			expect(result).toBe(false);
		});
	});

	describe('getSimilaritySettings', () => {
		it('reads both keys and converts threshold from a 0-100 percentage to a 0-1 fraction', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.similarityThreshold': 70,
				'noteGraph.maxEdgesPerNote': 8,
			});

			const result = await getSimilaritySettings();

			expect(joplin.settings.values).toHaveBeenCalledWith([
				'noteGraph.similarityThreshold',
				'noteGraph.maxEdgesPerNote',
			]);
			expect(result).toEqual({ threshold: 0.7, topK: 8 });
		});
	});
});
