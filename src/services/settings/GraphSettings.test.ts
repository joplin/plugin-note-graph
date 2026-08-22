import joplin from 'api';
import { SettingItemType } from 'api/types';
import {
	registerGraphSettings,
	isAiAnalysisEnabled,
	getSimilaritySettings,
	getScopeSettings,
} from './GraphSettings';

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
					'noteGraph.llmEnrichmentEnabled': expect.objectContaining({
						type: SettingItemType.Bool,
						value: false,
						public: true,
						section: 'noteGraph',
					}),
					'noteGraph.retryEmbedding': expect.objectContaining({
						type: SettingItemType.Bool,
						value: false,
						public: true,
						section: 'noteGraph',
					}),
					'noteGraph.retryEnrichment': expect.objectContaining({
						type: SettingItemType.Bool,
						value: false,
						public: true,
						section: 'noteGraph',
					}),
					'noteGraph.scopeMode': expect.objectContaining({
						type: SettingItemType.String,
						value: 'all',
						public: false,
					}),
					'noteGraph.scopeSelectedNotebooks': expect.objectContaining({
						type: SettingItemType.String,
						value: '',
						public: false,
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

		it('falls back to defaults when a value is undefined instead of propagating NaN', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.similarityThreshold': undefined,
				'noteGraph.maxEdgesPerNote': undefined,
			});

			const result = await getSimilaritySettings();

			expect(result.threshold).not.toBeNaN();
			expect(result.topK).not.toBeNaN();
			expect(result).toEqual({ threshold: 0.5, topK: 5 });
		});

		it('clamps an out-of-range threshold and topK to the registered min/max', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.similarityThreshold': 250,
				'noteGraph.maxEdgesPerNote': -3,
			});

			const result = await getSimilaritySettings();

			expect(result).toEqual({ threshold: 1, topK: 1 });
		});

		it('falls back to defaults when a value is not a number', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.similarityThreshold': 'not-a-number',
				'noteGraph.maxEdgesPerNote': NaN,
			});

			const result = await getSimilaritySettings();

			expect(result).toEqual({ threshold: 0.5, topK: 5 });
		});

		it('falls back to defaults instead of clamping to the minimum when a value is null, empty, or a boolean', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.similarityThreshold': null,
				'noteGraph.maxEdgesPerNote': '',
			});

			const result = await getSimilaritySettings();

			expect(result).toEqual({ threshold: 0.5, topK: 5 });

			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.similarityThreshold': false,
				'noteGraph.maxEdgesPerNote': true,
			});

			const secondResult = await getSimilaritySettings();

			expect(secondResult).toEqual({ threshold: 0.5, topK: 5 });
		});
	});

	describe('getScopeSettings', () => {
		it('reads a JSON-encoded list of selected notebook IDs', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.scopeMode': 'selected',
				'noteGraph.scopeSelectedNotebooks': JSON.stringify(['id-1', 'id-2']),
			});

			const result = await getScopeSettings();

			expect(joplin.settings.values).toHaveBeenCalledWith([
				'noteGraph.scopeMode',
				'noteGraph.scopeSelectedNotebooks',
			]);
			expect(result).toEqual({
				mode: 'selected',
				selectedNotebookIds: ['id-1', 'id-2'],
			});
		});

		it('falls back to "all" for an unrecognized or missing mode', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.scopeMode': undefined,
				'noteGraph.scopeSelectedNotebooks': '',
			});

			const result = await getScopeSettings();

			expect(result).toEqual({ mode: 'all', selectedNotebookIds: [] });
		});

		it('reads the "current" mode', async () => {
			(joplin.settings.values as jest.Mock).mockResolvedValue({
				'noteGraph.scopeMode': 'current',
				'noteGraph.scopeSelectedNotebooks': '',
			});

			const result = await getScopeSettings();

			expect(result.mode).toBe('current');
		});
	});
});
