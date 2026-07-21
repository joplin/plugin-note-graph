import { Note } from '../data/Types';
import { GraphBuilder } from './graph/GraphBuilder';
import { GraphData } from './graph/types';
import { VectorRepository } from '../data/Database/VectorRepository';
import { ProviderResolver } from './embeddings/ProviderResolver';
import { EmbeddingOrchestrator } from './embeddings/Orchestrator';
import { EmbeddedNote, EmbeddingProvider, BatchProgress } from './embeddings/Types';
import { isAiAnalysisEnabled, getSimilaritySettings } from './settings/GraphSettings';

export interface SemanticBuildResult {
	graphData: GraphData;
	usedAi: boolean;
}

/**
 * Coordinates turning notes into a GraphData, deciding between the plain
 * structural graph and the AI-enhanced one, and caching the last successful
 * embedding so threshold/top-K changes can recompute without re-embedding.
 */
export class AnalysisController {
	private lastNotes: Note[] | null = null;
	private lastEmbeddedNotes: EmbeddedNote[] | null = null;

	public constructor(private readonly builder = new GraphBuilder()) {}

	public buildStructural(notes: Note[]): GraphData {
		return this.builder.build(notes);
	}

	/**
	 * `usedAi: false` covers two different situations the caller must treat the
	 * same way (render the structural graph) but may want to message
	 * differently: AI analysis is off, or it's on but unavailable/failed. Check
	 * `isAiAnalysisEnabled()` separately if that distinction matters.
	 */
	public async embedAndBuildSemantic(
		notes: Note[],
		onProgress?: (progress: BatchProgress) => void
	): Promise<SemanticBuildResult> {
		const embeddedNotes = await this.tryEmbed(notes, onProgress);

		if (!embeddedNotes) {
			return { graphData: this.builder.build(notes), usedAi: false };
		}

		this.lastNotes = notes;
		this.lastEmbeddedNotes = embeddedNotes;

		console.info(`AI analysis: ${embeddedNotes.length}/${notes.length} notes embedded, building semantic graph.`);
		const { threshold, topK } = await getSimilaritySettings();
		const graphData = await this.builder.buildWithSimilarity(notes, embeddedNotes, threshold, topK);
		return { graphData, usedAi: true };
	}

	/** Rebuilds the graph from the last successful embedding using the current threshold/top-K settings. */
	public async recompute(): Promise<GraphData | null> {
		if (!this.lastNotes || !this.lastEmbeddedNotes) {
			return null;
		}
		const { threshold, topK } = await getSimilaritySettings();
		console.info(
			`Recomputing graph: threshold=${threshold}, topK=${topK}, ${this.lastEmbeddedNotes.length} cached vectors.`
		);
		return this.builder.buildWithSimilarity(this.lastNotes, this.lastEmbeddedNotes, threshold, topK);
	}

	/** Returns null on any failure (setting off, provider unavailable, nothing embedded) — never throws, so the caller can always fall back to the structural graph. */
	private async tryEmbed(
		notes: Note[],
		onProgress?: (progress: BatchProgress) => void
	): Promise<EmbeddedNote[] | null> {
		if (!(await isAiAnalysisEnabled())) {
			return null;
		}

		let provider: EmbeddingProvider;
		try {
			provider = await ProviderResolver.resolveWithValidation();
		} catch (e) {
			console.error('AI analysis unavailable, falling back to structural graph:', e);
			return null;
		}

		const orchestrator = new EmbeddingOrchestrator();
		orchestrator.setProvider(provider);
		orchestrator.setCache(new VectorRepository());
		if (onProgress) {
			orchestrator.setOnProgress(onProgress);
		}

		const { embeddedNotes, errors } = await orchestrator.embedNotes(notes);
		if (embeddedNotes.length === 0) {
			console.error('AI analysis produced no embeddings, falling back to structural graph:', errors);
			return null;
		}

		return embeddedNotes;
	}
}
